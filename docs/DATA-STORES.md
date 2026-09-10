# Data stores — what goes where

Status: 2026-09-10. Written after the SPX bar feed was found silently flat for
48 sessions. Every fact below was measured on this box, not assumed.

## TL;DR — the one rule

> **Bars are written by the EOD backfill. Nothing else writes bars.**

Two writers targeting `data/parquet/bars/` is what broke the feed. `live-capture`
ran all session and flushed last, so it always won for the current day: the EOD
job wrote real Polygon OHLC each night and the next session's capture overwrote
it with `open=high=low=close=mid, volume=0`. The backtest engine reads that
profile, so it silently ran on range-less bars.

---

## Authoritative stores

| Path | Owner (writer) | Contents | Consumers |
|---|---|---|---|
| `data/parquet/bars/{profile}/{date}.parquet` | `scripts/backfill/eod-backfill.ts` **only** | 1m OHLCV per contract + underlying, `source=polygon` | backtest engine (`loadDay`), monthly reports, sweeps — 33 files reference it |
| `data/parquet/snapshots/{profile}/{date}.parquet` | `scripts/live/live-capture.ts` | bid/ask, mid, last, greeks, IV, OI — per minute | spread/liquidity analysis. **The only place bid/ask exists.** |
| `data/flatfile-cache/{prefix}/` | `scripts/diag/preprocess-flatfiles.ts` | extracted Polygon S3 OPRA day-files | multi-DTE sweeps (avoids re-downloading 158MB/day) |
| `data/sweep-state/{SYM}-{engine}.json` | `scripts/diag/sweep-parallel.ts` | persisted sweep accumulators | EOD incremental sweeps |
| `data/reports/monthly-{spx,ndx}/` | `scripts/diag/monthly-gen.ts` | per-day contract report JSON | studio monthly view |
| `optionx/data/account.db` | optionx position manager | live positions + broker orders w/ fill prices | the ONLY record of real fills |

### Profile naming

- `spx-0dte` — live profile, 2025-03-27 → present. What the engine resolves to.
- `spx-0dte-hist` — Polygon flat-file archive, 2022-09-01 → 2025-03-26, 612
  sessions, same schema (`ts` is BIGINT there, INTEGER in the live profile; the
  reader casts). `resolveSymbolTarget` derives `profileId` as `{sym}-{dte}dte`,
  so a registry entry alone could never reach it. Since 2026-09-10
  (`scripts/diag/sweep-symbol.ts`):
  - `loadDay()` falls back to `{profileId}-hist` when the live profile has no
    file for that date — always on, so a study that names an archive date gets it.
  - `listDatesFor()` merges the archive **only under `SWEEP_HIST=1`**. Opt-in
    because the nightly incremental sweeps call it too; measured: 357 dates
    default, 969 with the flag. `SWEEP_DAYS` slices the merged list.
  - **Caveat:** the archive's underlying `SPX` rows are close-only
    (open=high=low=close, volume 0 on 2022-09-01, 2024-06-14, 2025-03-26 — 0 of
    390 bars ranged each day). Its option contracts have real OHLC. Anything
    that touch-tests the *underlying* intrabar is blind on archive dates.

---

## Derived / cache — safe to delete, will rebuild

| Path | Size | Note |
|---|---|---|
| `data/cache/*.brc` | 3.6G | binary bar cache. Pure speed cache; `loadDayUncached` falls through to parquet when absent/stale. |
| `data/live-capture/{date}.db` | 6.4G | live-capture's per-day SQLite spool. Flushed to snapshots parquet; crash-recovery only. |
| `spx-study/stage/` | 3.9M | **symlink farm, not data.** 960 links, 0 real files: 612 → `spx-0dte-hist`, 348 → `spx-0dte`. A merged full-history view of both profiles. 0 broken links. Referenced by no code. |
| `worktrees/SPXer/*/data` | 0 | symlinks → `/home/ubuntu/SPXer/data`. Not copies. |

---

## Dead weight — needs a decision

| Path | Size | Finding |
|---|---|---|
| `data/spxer.db` | **15G** | `bars` table is **empty (0 rows)** — migrated to parquet. Remaining content is `replay_results` (9,497,217 rows), `replay_contracts` (21,209), `signals` (5,035), `contracts` (216). 35,437 free pages. Still referenced by 57 files, so it is NOT inert — the replay system uses it. Needs a `VACUUM` and an audit of what replay actually needs. |
| `data/metrics.db` | 51M | referenced by **0** files. |
| `data/parquet/quarantine/` | 400K | `spx-0dte-2026-09-07.tradier-holiday.parquet` — Labor Day, market closed, OPRA has no file, yet live-capture wrote 154,224 bars (SPX: 378 rows, **1 distinct close**). Kept as evidence. |
| `spxer-studio/studio-server.cjs.bak*` | 24K | two untracked backups sitting in the repo root. |

---

## Rules

1. **One writer per store.** If a second process needs to write bars, it writes
   to its own profile, never a shared one.
2. **A backfill that writes nothing is a failure.** `eod-backfill.ts` now counts
   failures and sets `exitCode=1`; an empty roster or date list is REFUSED.
   `eod-pipeline.sh` branches on rc, so PHASE 1 aborts loudly.
3. **Snapshots are not bars.** Tradier is a snapshot API, not a tick feed
   (`live-capture.ts:15`). Its rows have no intra-minute range and volume 0.
   They belong in `snapshots/`, never in `bars/`. Bar writes are gated by
   `barWritesEnabled()` in `src/live/capture-guard.ts` (opt-in,
   `LIVE_CAPTURE_WRITE_BARS=1` exactly; pinned by `tests/live/capture-guard.test.ts`).
3a. **No writer runs on a non-trading day.** `captureSkipReason()` (same
   module) exits live-capture before the spool is opened on weekends/holidays;
   `eod-backfill.ts` `tradingDays()` is holiday-aware and a range with no
   trading days is a `SKIP` with rc 0 (a reversed range is still `REFUSED`, rc 1).
   Both read `MARKET_HOLIDAYS` in `src/config.ts` — which listed **Labor Day
   2026 as 2026-08-31, a week early**. 2026-09-07 was the real holiday (the
   quarantined file's date) and 2026-08-31 was a real session (its parquet
   exists in both spx-0dte and ndx-0dte). Fixed in `src/config.ts`,
   `src/config/defaults.ts`, `scripts/agent-scheduler.sh`,
   `scripts/agent-watchdog.sh`. Dec 24 early closes are still not listed in
   `EARLY_CLOSE_DAYS`.
4. **Live trading reads neither.** optionx fetches 1m bars from Tradier
   `/v1/markets/timesales` over HTTP (`optionx/src/shared/market-data.ts`) and
   never touches this parquet. Data-store changes cannot break live trading.
5. **Check `source` before trusting a date range.** One profile can hold several
   eras: `polygon`, `aggregated`, `thetadata`, `tradier-live`. Sampling the
   newest file tells you nothing about the rest.

---

## Resolved 2026-09-10

- [x] `spx-0dte-hist` reachable — `loadDay` fallback + `SWEEP_HIST=1` merge
      (see Profile naming above; `tests/diag/sweep-symbol.test.ts`).
- [x] `live-capture` non-trading-day guard + `eod-backfill` holiday-aware dates
      (rule 3a). Labor Day 2026 corrected to 09-07 in all four holiday tables.
- [x] `data/metrics.db` — 302,694 rows spanning 2026-05-01 → 2026-05-07; zero
      references in SPXer, optionx, spxer-studio, termchat, projects. **Moved
      to `data/_trash/metrics.db`** (reversible; delete when convenient).
- [x] Stored higher timeframes — correction: 2m/3m/5m/10m/15m rows exist in
      276 files, **2025-03-27 → 2026-05-05** (not 07-06); `1h` in one file.
      Every active `loadDay` caller requests `'1m'` (40 call sites) and the
      engine aggregates on the fly, so nothing reads stored higher timeframes.
      No backfill needed; do not add one.

## Candle repair status (2026-09-10 afternoon)

Measured per profile: underlying rows with `high == low` for the whole day
("flat"), i.e. Tradier snapshot mids masquerading as candles.

| Profile | Flat days found | Action |
|---|---|---|
| `spx-0dte` | 0 (repaired 09-10 morning) | — |
| `ndx-0dte` | 48, 2026-07-06 → 09-10 | `eod-backfill 2026-07-06 2026-09-10 --only=ndx-0dte --force` (log `logs/ndx-repair-2026-09-10.log`) |
| `spy-1dte` / `qqq-1dte` | 49 each, 2026-07-06 → 09-10 (never in the nightly `--only`) | re-backfilled from 2026-05-07 / 05-15 (`/tmp/spyqqq-backfill.log`) |
| `xsp-0dte` | 49 — the profile had **only** Tradier junk | roster entry added (`I:XSP`, `XSP`, interval 1, band 20); re-backfill chained (`logs/xsp-repair-2026-09-10.log`) |
| `spx-1dte` / `ndx-1dte` | 2 each (created 09-09 by the old writer) | moved to `data/parquet/quarantine/*.tradier-flat.parquet`; no roster entry, no consumer |

Nightly `eod-pipeline.sh` PHASE 1 now backfills
`spx-0dte,ndx-0dte,spy-1dte,qqq-1dte,xsp-0dte` (`BACKFILL_PROFILES`).

**20:15Z `NOT_AUTHORIZED` — did not recur on 2026-09-10.** Tonight's cron run
wrote all five profiles (`Done — 5 profile-day(s) OK`), and the timed probe
returned `status=DELAYED` with a full bar count for `I:SPX`, `I:NDX` and `SPY`
at every sample from 20:05Z to 21:00Z, including 20:15:01Z. The nightly
failures (every night ≤ 09-09) and the morning-of-09-10 success are consistent
with a Polygon indices entitlement that changed on 09-10; that is inferred
from timing, not verified against the account. If it recurs, the probe script
is `/tmp/polygon-eod-probe.sh` (copy it somewhere durable).

**Iron merge root cause (found 2026-09-10 evening, fixed):** the iron
accumulator reached 535,937,273 bytes on 09-08 — within 1 MB of V8's
`MAX_STRING_LENGTH` (536,870,888) — so `JSON.stringify(wholeState)` in
`sweep-shard.ts::dumpResults` threw and the merge exited 1 every night from
then on, including on a clean bootstrap. `dumpResults` now writes one
top-level entry per line (still one JSON object) and `readStateEntries`
parses files ≥ 256 MB line by line; smaller and legacy single-line files
take the whole-file path. Pinned by `tests/diag/sweep-shard.test.ts`.

**Sweep state was contaminated (rebuilt 2026-09-10 night).**
`data/sweep-state/{SPX,NDX}-{credit,iron,concdist}.json` accumulate per-config
results across all dates; the 48 junk sessions (07-06 → 09-09) are baked into
`pnl/n/wins/capNets/perHour`, which cannot be recomputed from the per-date map
alone. Separately, `iron#merge exited 1` every night since 09-08 (NDX) /
09-09 (SPX) — before any change in this doc — so the iron state has not
persisted a new day since then. The only honest repair is a full bootstrap
(`eod-pipeline.sh --now --bootstrap` with the state files moved aside; the
2026-05-18 bootstrap took ~8.5 min for SPX: credit 107 s + iron 289 s +
concdist 104 s with 8 shards). Chained to run after tonight's pipeline;
contaminated state parked in `data/_trash/sweep-state-contaminated/`.

### Pre-holiday 1DTE gap (found during the repair, fixed 2026-09-10)

`expiryForDate()` in `scripts/backfill/backfill-replay-options.ts` and in
`scripts/diag/sweep-symbol.ts` skipped weekends only, so the session before
every holiday resolved its 1DTE expiry *to* the holiday, found no listed
options, and was dropped. spy-1dte and qqq-1dte were missing all 14 such
sessions from 2025-04-17 to 2026-07-02, and 2026-09-04 kept its Tradier junk
because `--force` skips a day that yields no option data. Both helpers now
step through `nextTradingDay()` (holiday-aware) and are pinned by tests.
Reminder: `tsc` covers `src/` only, so a wrong argument count in `scripts/`
is not a build error.

## Open items

- [ ] `data/spxer.db` — 15,053,926,400 bytes. `bars` empty. Freelist is 35,437
      pages × 4,096 = **~145 MB**, so a `VACUUM` (which needs ~15 GB of temp
      space) would reclaim almost nothing — the size is real `replay_results`
      rows (9,497,217) plus `replay_summary` (263,299). No process holds it
      open (`lsof` empty); last modified 2026-08-05. Active replay writes go to
      `data/replay.db` (23,210 results, modified 2026-09-09). Only
      `scripts/backfill/daily-backfill.ts` (ecosystem entry, not running) and
      the Sunday `purge-bars.ts` cron (purges an empty table) still point at it.
      **Decision needed:** archive to `GDRIVE_REMOTE` and delete, or keep.
      Either way the `purge-bars.ts` crontab line is dead weight.
- [ ] Archive underlying is close-only (caveat above). If underlying intrabar
      range matters for a study on 2022-09 → 2025-03, re-pull `I:SPX` 1m from
      Polygon into the `-hist` files — a separate backfill job, not written.
- [ ] Zero-byte / stale DBs in `data/`: `optimizer.db` (0 B), `spx.db` (0 B),
      `signals.db`, `account.db` (49 KB, Apr 2026; `src/storage/db.ts` still
      names it). Not audited.
- [ ] `spxer-studio/studio-server.cjs.bak*` — two untracked backups, untouched.

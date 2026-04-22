# Multi-Ticker Expansion Plan

**Status**: Framework scaffolding built (Phase 1 + 2a complete). NDX raw 1m data backfilled but missing MTF aggregates + indicators — uncovered 2026-04-20. Live path (`src/index.ts`, `spx_agent.ts`) still hardcoded SPX. **Next work unit: UNIVERSAL-BACKFILL refactor** — see [`docs/UNIVERSAL-BACKFILL.md`](./UNIVERSAL-BACKFILL.md). This refactor supersedes the old "Resume Step 1" (profile-fetch prototype).

**Context**: SPXer is extending from SPX-only to a multi-instrument system. Data provider architecture has stabilized — ThetaData WS primary for options, Tradier WS cold-standby, Tradier REST for underlying + orders. Next ticker rollout can proceed once profiles become data-driven.

**Target tickers (in priority order)**:
1. SPX 0DTE (live today — margin account 6YA51425)
2. NDX 0DTE/1DTE (backtest-only until account assigned)
3. SPY 1DTE (backtest-only)
4. QQQ 1DTE (backtest-only)

TSLA / NVDA weeklies parked until the first four are validated. Once UNIVERSAL-BACKFILL ships, any ticker can be onboarded from the UI for backtest — the priority list only applies to live trading.

---

## What's Done

### Phase 1 — Agnostic Framework (complete)

Built `src/instruments/` and `src/framework/` as pure scaffolding. No integration with the live agent yet.

**Files created**:
- `src/instruments/types.ts` — `InstrumentProfile` type (structural description: symbol, option prefix, strike interval, session hours, expiry cadence, stream phases)
- `src/instruments/profiles/spx-0dte.ts` — SPX profile matching current hardcoded values in `spx_agent.ts`
- `src/instruments/profiles/ndx-0dte.ts` — NDX profile, populated from live Tradier probe on 2026-04-20 (NDXP root, $10 ATM strike interval, ±$500 band, daily expiry cadence, no account assigned — backtest-only)
- `src/instruments/profiles/spy-1dte.ts` — SPY placeholder, no accountId (backtest-only)
- `src/instruments/registry.ts` — In-memory lookup, enforces unique id + unique accountId
- `src/instruments/symbol-format.ts` — OCC symbol formatting and parsing
- `src/instruments/expiry-resolver.ts` — ET-safe expiry policies (0DTE, 1DTE, nearestAfterMinDte)
- `src/instruments/index.ts` — barrel
- `src/framework/agent-runner.ts` — `runAgent(opts)`, `validateAgentBoot`, boot banner
- `src/framework/index.ts` — barrel

**Not yet wired to live path**: `src/index.ts` (940 lines) and `spx_agent.ts` have zero imports from `src/instruments/` or `src/framework/`. The scaffolding is a dead-end island until Phase 2b (dispatcher refactor).

**Test coverage**:
- `tests/instruments/registry.test.ts` — 16 tests (registry invariants + SPX parity)
- `tests/instruments/symbol-format.test.ts` — 23 tests (symbol formatting for SPX/SPY, round-trip)
- `tests/instruments/expiry-resolver.test.ts` — 28 tests (holiday/weekend handling, all policies)
- `tests/framework/agent-runner.test.ts` — 12 tests (boot validation, banner format)

**Design principle**: `Profile = WHERE` (structural, immutable per ticker). `Config = HOW` (strategy knobs, testable via replay). Never mix.

### Phase 2 — Pipeline Folder Split (partially complete)

**2a: File move (complete)** — SPX-specific orchestration moved to `src/pipeline/spx/` subdirectory via `git mv` to preserve history.

Moved:
- `src/pipeline/scheduler.ts` → `src/pipeline/spx/scheduler.ts`
- `src/pipeline/contract-tracker.ts` → `src/pipeline/spx/contract-tracker.ts`
- `src/pipeline/option-stream.ts` → `src/pipeline/spx/option-stream.ts`
- Test mirrors moved accordingly to `tests/pipeline/spx/`

Kept at `src/pipeline/` root (shared pure computation, ticker-agnostic):
- `aggregator.ts`, `bar-builder.ts`, `indicator-engine.ts` (re-export shim), `indicators/`, `option-candle-builder.ts`

Import sites updated: `src/index.ts`, `src/server/http.ts`, and 3 test files.
`npx tsc --noEmit` clean. 516/517 tests pass (1 unrelated Yahoo live-API weekend flake).
Live PM2 processes (spxer, spxer-agent) unaffected.

**2b: Dispatcher refactor (NOT started)** — `src/index.ts` still hardcodes SPX. Not urgent; do this only when adding the second ticker. Confirmed 2026-04-20: `src/index.ts` has zero imports from `instruments/` or `framework/`.

### Phase 2c — Resume Step 1 artifacts landed (superseded 2026-04-20)

Two scripts were written for the original "profile-fetch prototype" approach:

- `scripts/test-profile-fetch.ts` — profile-driven vendor parity test against NDX.
- `scripts/create-ndx-config.ts` — NDX config row seeder.

**These are now superseded by the UNIVERSAL-BACKFILL refactor.** Rather than a bespoke one-off script to prove a single ticker works, we're generalizing profile storage, discovery, backfill, and UI in one pass so *any* ticker can be onboarded without code edits. Keep the scripts in-tree for historical reference; delete them as part of UNIVERSAL-BACKFILL Phase 5 cleanup.

### Phase 2d — Backfill gap uncovered (2026-04-20)

NDX backfill was run via `scripts/backfill/run-ndx-batch.sh` which only invoked `backfill-worker.ts`. Result:
- 266 days of NDX + NDXP options 1m bars present
- **Zero** 2m/3m/5m/10m/15m aggregate bars
- **Zero** populated denormalized indicator columns (all NULL)

Root cause: `backfill-worker.ts` has an early-return for non-SPX profiles (lines 475–489). `build-mtf-bars.ts` has `WHERE symbol='SPX'` hardcoded in its trading-day query. `daily-backfill.ts` only orchestrates for SPX. The orchestration layer was never generalized — `run-ndx-batch.sh` was a quick bypass that skipped post-processing entirely.

**This is the immediate driver for the UNIVERSAL-BACKFILL refactor.** NDX cannot be replayed with full fidelity until its MTFs and indicators are populated, and the right way to fix it is to remove the SPX-hardcoding throughout the backfill path rather than bolt on another per-ticker script.

---

## Architectural Decisions Locked In

1. **Duplicate orchestration per ticker, share computation** (live path only). `src/pipeline/spx/`, `src/pipeline/ndx/`, etc. each have their own `contract-tracker.ts`, `option-stream.ts`, `scheduler.ts` for the *live* data service. Pure computation lives in `src/core/` and `src/pipeline/` root. The *backfill/replay* path is fully symbol-agnostic after UNIVERSAL-BACKFILL — no per-ticker folders needed there.

2. **Per-ticker PM2 process** (live). Each ticker gets its own agent (`spx_agent.ts`, `ndx_agent.ts`, etc.) with its own account. Failure isolation over shared-process efficiency. Registry enforces unique accountId so two agents can't double-trade one account.

3. **Execution routing is agent-owned, not Config-owned**. The live agent hardcodes (or after refactor: reads from profile) `accountId` and symbol routing. The Config defines strategy (signals, exits, risk). Test in replay → set `CONFIG_ID` → deploy.

4. **Storage tier: SQLite today + Parquet+zstd for T-1 and older**. See [Storage Tier](#storage-tier) below.

5. **Never-trade-ITM is a config knob, not a profile invariant**. All strategy assumptions must be testable via replay. Profile stays structural.

6. **Parity contract**: same Config + same core/ functions → identical output across live and replay, regardless of ticker.

7. **Profiles are data, not code** (ratified 2026-04-20 via UNIVERSAL-BACKFILL). An `instrument_profiles` SQLite table is the source of truth. Code profiles in `src/instruments/profiles/` become seed data loaded on first boot. Live-tradable profiles (`can_go_live=true`) are additionally overwritten from code on every boot — keeps the audit trail in git while still allowing UI-authored backtest-only profiles. DB-only profiles can be added/edited from the replay viewer UI without a code deploy.

8. **One backfill orchestrator, symbol-agnostic**. `scripts/backfill/orchestrate-backfill.ts` is the single entry point for CLI, daily cron, and UI-triggered backfill jobs. Takes a profile id. Discovers missing dates/timeframes/indicators. Fetches raw data, builds MTFs, populates indicators. No per-ticker backfill scripts. Delete-on-sight.

---

## Storage Tier

Decided: **Option A — parquet on VPS3 local disk, nightly async mirror to srvr E:/**.

**Measured facts (2026-04-20)**:
- VPS3 local read: 768 MB/s direct, 979 MB/s cached
- zstd-3 compression on real SPXer DB data: 5.0× (500 MiB → 101 MiB)
- Ping VPS3 → srvr (tailscale): 166 ms RTT
- Throughput VPS3 → srvr: 5.2 MB/s
- VPS3 free: 74 GB; srvr E:/ total: 2 TB
- Current `spxer.db`: 40 GB (266 days of SPX)

**Why not srvr primary**: 5 MB/s over tailscale would 5–10× replay latency, breaks autoresearch throughput. 166 ms RTT kills DuckDB parquet range reads.

**Projected footprint (4 tickers × 300 days with 5× zstd)**:
| Ticker | Raw | Compressed |
|---|---|---|
| SPX | 45 GB | 9 GB |
| NDX | ~40 GB | 8 GB |
| SPY 1DTE | 6 GB | 1.2 GB |
| QQQ 1DTE | 6 GB | 1.2 GB |
| **Total** | **97 GB** | **~20 GB** |

**Tier rules**:
- `date === todayET()` → SQLite only. Live agent, data service, dashboards.
- `date < todayET()` → Parquet only. Replay, backtest, autoresearch, replay viewer.
- Replay is never valid on today's date — enforce with error in bar loader.

**Flush event (16:30 ET daily)**:
1. Write today's bars → parquet locally to staging path
2. Verify row count matches SQLite
3. rsync to srvr E:/
4. Verify checksum on srvr
5. Only then DELETE FROM bars WHERE date < today FROM SQLite
6. Keep local parquet for rolling 18 months; older tier rotates to srvr-only / GDrive

**File layout**:
```
/home/ubuntu/SPXer/data/parquet/
├── bars/
│   ├── spx/2026-04-20.parquet
│   ├── ndx/2026-04-20.parquet
│   ├── spy/2026-04-20.parquet
│   └── qqq/2026-04-20.parquet
└── contracts/   (optional; contracts metadata may stay in SQLite as permanent index)
```

**Boundaries**:
- Contracts metadata stays in SQLite (small, relational, ~300K rows at 10-year horizon — negligible)
- `replay_runs`, `replay_results`, `replay_configs` stay in SQLite (transactional, small)
- spxer.db (hot) becomes ~150 MB when shrunk to today-only

---

## Multi-Vendor Data Pipeline (SHIPPED 2026-04-20)

Per CLAUDE.md "Live data provider architecture" + MEMORY.md "Data Provider Architecture":
- **Options WS**: ThetaData primary (`src/providers/thetadata-stream.ts`), Tradier WS cold standby (`src/pipeline/spx/option-stream.ts`). `thetaIsPrimary()` is pure connection-state switch, no hysteresis. Both streams feed the same `OptionCandleBuilder`; Tradier drops ticks when Theta is connected.
- **SPX underlying**: Tradier REST timesales — single source. Health-gate halts agent on failure (safe stop).
- **Order execution**: Tradier — single source. Agent halts on failure.
- **Historical backfill**: SPX from Polygon (still subscribed), options from ThetaData REST.
- Option stream wake is single-phase at 09:22 ET (no two-phase re-lock).

**Profile cleanup — done 2026-04-20**: the `dataProvider` field and the `DataProviderId` type have been removed from `InstrumentProfile` and all three profiles (SPX/NDX/SPY). Vendor routing is orchestration-owned, not profile-owned — it lives in the per-ticker pipeline folder (`src/pipeline/{id}/`), not here. The profile type's JSDoc now documents this boundary explicitly. `tsc --noEmit` clean; 76/76 instruments + framework tests pass.

**Bar source tagging**: `replay_bars.source` column already tracks origin (`'polygon'` | `'thetadata'` | `'live'` | `'aggregated'`). Replay reads all sources transparently. The parquet flush must preserve this column so downstream replays stay source-aware.

---

## Resume Plan

The plan below is re-sequenced around the UNIVERSAL-BACKFILL refactor. The old Step 1 (profile-fetch prototype) is retired — its goal (prove profile-driven vendor calls work for a non-SPX ticker) is subsumed by Phase 1–2 of UNIVERSAL-BACKFILL, which produces a generic discovery service that exercises the same code path for every profile automatically.

Layers (mapped to `docs/UNIVERSAL-BACKFILL.md` design):

```
 Layer 5 — UI control / monitoring           ◄─── UB Phase 3-4 + later Symbol Registry
 Layer 4 — Storage (SQLite hot + parquet)    ◄─── Step B below
 Layer 3 — Live agents (one per profile)     ◄─── Step C below (unblocked by UB)
 Layer 2 — Data pipeline (fetch/agg/indic.)  ◄─── UB Phase 2 generalizes it
 Layer 1 — Instrument profiles (data model)  ◄─── UB Phase 1 makes it dynamic
```

### Step A — UNIVERSAL-BACKFILL refactor (next work unit)

Full spec in [`docs/UNIVERSAL-BACKFILL.md`](./UNIVERSAL-BACKFILL.md). Summary of phases:

1. **Profile store + discovery service** — `instrument_profiles` table, `src/instruments/profile-store.ts`, `src/instruments/discovery.ts` (Polygon-backed auto-detection), `src/instruments/backfill-routing.ts`. Seed existing code profiles on first boot.
2. **Generic backfill orchestrator** — `scripts/backfill/orchestrate-backfill.ts`, `src/pipeline/mtf-builder.ts`, `src/backfill/missing-dates.ts`. Drop SPX hardcoding from `build-mtf-bars.ts` and `backfill-worker.ts`. Delete `run-ndx-batch.sh`.
3. **Server API** — 10 endpoints under `/replay/api/symbols/*`. Extend `replay_jobs` with `kind`, `profile_id`, `progress_json`.
4. **UI** — dynamic symbol dropdown, "Add symbol" modal with discovery preview, per-symbol panel with coverage heatmap + "Fill missing dates" + active-jobs list + delete.
5. **Migration** — run orchestrator against NDX to populate missing MTFs + indicators. Delete deprecated per-ticker backfill scripts.

Acceptance gate: from a fresh clone, user types a ticker in the UI and gets a fully-backfilled replay-ready dataset without editing code. `SELECT DISTINCT timeframe FROM replay_bars WHERE symbol='NDX'` returns all 6 timeframes. `run-ndx-batch.sh` no longer exists.

Estimated effort: ~7.5 days. Phase 3 + 4 parallelizable.

### Step B — Storage tier, SPX only

Ship the parquet flush path for SPX alone. Independent of Step A but easier to validate after it: Step A gives us a clean definition of "complete data for a symbol-date," which is what the flush event verifies before deleting from SQLite. See [Storage Tier Checklist](#storage-tier-checklist-sequenced-do-after-spx-only-works) below.

### Step C — Multi-agent dispatcher (unblocked by Step A)

Once profiles are in DB and the backfill/replay path is generic, the live path can follow:

1. **Generalize `spx_agent.ts` → `agent.ts`** — reads `AGENT_PROFILE_ID` env var, loads profile from DB, wires execution via `profile.execution_account_id`. Live-tradable profiles are overwritten from code on boot so SPX behavior stays git-traceable.
2. **Refactor `src/index.ts` data service into a profile-loop** — one pipeline instance per enabled profile. Keep SPX path byte-compatible. `src/pipeline/spx/` stays; `src/pipeline/ndx/` gets created as a duplicate when NDX goes live.
3. **PM2 ecosystem per profile** — `spxer-agent-spx`, `spxer-agent-ndx`, etc. Same binary, different env. Registry enforces unique account id.

Blocked on: assigning a broker account to NDX (or any non-SPX ticker) before that ticker's agent can go live.

### Step D — Live monitoring UI

Extends the replay viewer's Symbol Manager into a full Symbol Registry with live views:
- Per-symbol live dashboard (P&L, positions, current signal state)
- Per-symbol leaderboard (config × date performance)
- Account allocation percentages
- Cross-symbol risk summary

Blocked on Step C to have live data flowing for non-SPX tickers.

---

### Retired steps (for history)

- ~~Step 1: Pre-market vendor parity test~~ — subsumed by UB discovery service.
- ~~Step 2: Extend prototype to ThetaData options~~ — ThetaData routing is now profile-owned; SPX remains the only ThetaData-subscribed ticker per vendor-routing config. Other tickers use Polygon.
- ~~Step 4: Build NDX pipeline (duplicate `src/pipeline/spx/`)~~ — still valid for *live* NDX when an account is assigned, but no longer a prerequisite for replay/backtest work.

---

## Storage Tier Checklist (sequenced, do after SPX-only works)

1. Extend `src/storage/archiver.ts` for daily bar flush (not just expired contracts)
2. Add `src/storage/parquet-reader.ts` — DuckDB wrapper for replay bar reads
3. Swap `src/replay/machine.ts` bar loader from SQLite to parquet
4. Swap `/replay/api/bars` endpoint in `src/server/replay-server.ts` to parquet
5. Add 16:30 ET flush as PM2 scheduled task (not system cron — need PM2 restart policy + alerting)
6. One-time migration: export existing 40 GB spxer.db SPX history to parquet, verify row counts per day
7. **Parity test** — gate for shipping: SQLite-backed replay and parquet-backed replay produce byte-identical trade tapes for the same date
8. Nightly rclone mirror of `data/parquet/` → srvr E:/ for DR

---

## Open Questions

- **NDX profile specifics** — ✅ resolved via Tradier probe: NDXP root, $10 ATM interval, daily expiries, ±$500 band. Band width may need tuning against replay results.
- **NDX account**: not yet assigned. Needed for live, not blocking backtest.
- **SPY/QQQ accounts**: same question.
- **Config allocation model**: user wants "percentage of account per symbol." Needs a `perSymbolAllocationPct` field on Config or a separate allocation table. TBD.
- **Pre-session warmup across days**: if any future config uses HMA 200 on 1h, the live agent needs cross-day bars. Today's "SQLite = today only" rule would break that. Mitigation: pull warmup from parquet at agent boot. Not urgent.
- **Config ↔ profile binding**: once multiple profiles exist, a config tested against SPX shouldn't silently "run" against NDX. Proposed during UB design: add `profile_id` to `replay_configs`, default existing rows to `'spx'`. Replay-all-configs-on-backfill filters by matching profile. Not yet decided.
- **Live-tradable profile overwrite policy**: UB proposes "DB wins for backtest-only profiles; code overwrites DB on boot for `can_go_live=true`." Need confirmation that this is the right trade-off vs full DB-is-truth.
- ~~**`dataProvider` field on `InstrumentProfile`**~~ — resolved 2026-04-20. Field + `DataProviderId` type dropped from `src/instruments/types.ts`, all three profiles, the index barrel, test assertions, and the Step 1 script. Vendor routing is orchestration-owned.
- ~~**Profile storage: code vs DB**~~ — resolved 2026-04-20 via UB design doc. Hybrid: code = seeds + live-tradable truth, DB = everything else.

---

## Risks Not Yet Mitigated

1. **Cross-machine flush atomicity**: if rsync to srvr fails after SQLite is cleared, today's bars are gone locally. Mitigation described in flush event above — strict two-phase with verification, don't clear SQLite until remote verify passes.

2. **Parquet schema evolution**: when indicators change, old parquet has old schema. DuckDB tolerates missing columns with NULL but replay that expects new indicators on old data produces garbage. Need schema versioning.

3. **Flush cron as SPOF**: missed day breaks tomorrow's replay. PM2-managed scheduled process (not system cron), idempotent re-run, manual trigger path, alerting on failure.

4. **Storage tier refactor stacks with multi-ticker refactor**: keep them sequenced separately. Multi-ticker first on existing SQLite; storage tier second as isolated change; multi-ticker × storage tier third. Never ship both at once.

---

## Quick Reference

- Live agent: `spx_agent.ts` → PM2 `spxer-agent` → margin 6YA51425
- Data service: `src/index.ts` → PM2 `spxer` → port 3600
- Multi-ticker framework scaffold: `src/instruments/`, `src/framework/`
- SPX-specific pipeline orchestration (live path): `src/pipeline/spx/`
- Shared pure computation: `src/pipeline/` (non-spx subdir), `src/core/`
- ThetaData primary, Tradier WS cold-standby: `src/providers/thetadata-stream.ts`, `src/pipeline/spx/option-stream.ts`
- Underlying + chain: Tradier HTTP via `src/providers/tradier.ts`
- **Universal backfill design**: [`docs/UNIVERSAL-BACKFILL.md`](./UNIVERSAL-BACKFILL.md)
- **Backfill orchestrator (after UB Phase 2)**: `scripts/backfill/orchestrate-backfill.ts`
- **Profile storage (after UB Phase 1)**: `instrument_profiles` table in `spxer.db`, code seeds in `src/instruments/profiles/`

# CLAUDE.md

This file provides guidance when working with code in this repository.

## Current Branch Status: `feat/multi-dte-credit-sweep`

**SPXer is now a BACKTEST + BACKFILL + LIVE-CAPTURE system. It no longer executes trades.** Live order execution has moved to a separate repo at `~/optionx` ("OptionX"). SPXer's job ends at producing validated strategy configs and the historical/real-time data those configs are tested against; the `take-live` flow hands a finished config to OptionX.

### Build & Test Status: ✅ GREEN

- `npm run build` (`tsc`) — **passes clean**, 0 errors
- `npm run test` (`vitest run`) — **684 passing / 0 failing** across 54 files

> The earlier `CODE-REVIEW-2026-05-22.md` (written for the `feat/shorts-fresh-fill-study` branch) lists "15 TS errors / 27 failing tests." Those all referenced `src/server/*` files (the old `:3601` replay viewer) which were deleted in commit `a32fe0e1a` ("remove dead :3601 replay viewer + replay CLI/legacy scripts", −22,867 lines). That review is **superseded** — see `CODE-REVIEW-2026-08-09.md` for the current accurate audit.

## What is SPXer

A research/backtest platform for short-DTE index options (SPX/NDX/XSP 0DTE, SPY/QQQ 1DTE) plus a growing set of **stock** (StockX) strategies. It owns three concerns:

1. **Backtest / sweep engines** — HMA/DEMA multi-timeframe signal detection → spread/long/iron structure selection → realistic exit simulation, swept across parameter grids and dates.
2. **Data pipelines** — nightly historical backfill (Tradier) and a market-hours **live-capture** daemon that records the option chain (bid/ask + greeks + live Black-Scholes delta) every minute into parquet.
3. **Config handoff to OptionX** — the backtest studio's `take-live` endpoint converts a winning sweep row into a config JSON written to `~/optionx/configs/{id}.json` and returns the PM2 command to launch it in OptionX.

### Service Architecture (This Branch)

| Process | Entry point | Purpose | Status |
|---------|-------------|---------|--------|
| **backtest studio** | `scripts/autoresearch/backtest-server.ts` | HTTP API + viewer on **port 3700**; runs sweeps, serves results, `take-live` → OptionX | ✅ Active (run manually / ad-hoc) |
| **live-capture** | `scripts/live/live-capture.ts` | Tradier RTH polling → parquet bars + snapshots; self-exits at close | ✅ Active (PM2 cron) |
| **daily-backfill** | `scripts/backfill/daily-backfill.ts` | Nightly candlestick backfill for all profiles | ✅ Active (PM2 cron) |
| ~~replay-viewer~~ | ~~`src/server/replay-server.ts`~~ | Old `:3601` viewer | ❌ **DELETED** (ecosystem entry + stray `replay2-viewer` PM2 app removed 2026-08-20, FR-001) |

### EOD pipeline process-lifecycle guarantees (FR-001, 2026-08-20)

Between 2026-07-31 and 2026-08-19 the nightly pipeline hung silently at the
`concurrent-distribution` merge (child never exited; wrapper awaited forever)
and each weekday's cron fire stacked another orphaned tree — 37 leaked
processes at peak. Three layers now bound every run:

1. **Per-step timeouts** (`scripts/diag/sweep-process.ts`, used by `sweep-parallel.ts`): every child is detached (own process group), wall-clock-bounded (`SWEEP_WORKER_TIMEOUT_S` 2700s / `SWEEP_MERGE_TIMEOUT_S` 900s), has stdout drained, and dies with the wrapper on SIGINT/SIGTERM. Engine merge paths exit explicitly (`process.exit(0)`).
2. **Pipeline mutex + bound** (`eod-pipeline.sh`): `flock -n` on `data/sweep-state/eod.lock` (a second fire logs `skip — previous run still active` and exits 0) and a 2h-per-symbol `timeout -k 60s` wrapper.
3. **Reaper** (`scripts/ops/sweep-reaper.sh`, cron `13,43 * * * *`): kills any sweep-family process tree older than 6h (`SWEEP_REAP_AGE_H`), `--dry-run` to preview.

Freshness is monitored by `check-data-pipeline.sh` TIER 9 + `eodFreshnessStatus()` in `src/ops/pipeline-health.ts` (warn >72h, fail >96h without a `=== EOD pipeline done ===` line).

**Live trading** (event handler, position monitor, data service `:3600`, Schwaber) has been **removed from this repo entirely** and reimplemented in OptionX. Do not look for it here.

## Commands (Current Branch)

```bash
# Build & test (BOTH GREEN)
npm run build            # tsc → dist/  (0 errors)
npm run test             # vitest run   (684 passing)
npm run test:watch       # vitest in watch mode

# End-of-day pipeline (nightly backfill + incremental sweep)
npm run eod              # bash scripts/ops/eod-pipeline.sh --now

# Backtest studio (port 3700) — run on demand
npx tsx scripts/autoresearch/backtest-server.ts

# Live capture / backfill (normally PM2-managed, but runnable directly)
npx tsx scripts/live/live-capture.ts            # loop until close
npx tsx scripts/live/live-capture.ts --once     # single poll + flush
npx tsx scripts/backfill/daily-backfill.ts
```

### Deleted commands (do not exist on this branch)
`npm run dev` · `npm run handler` · `npm run agent` · `npm run schwaber` · `npm run replay` · `npm run backtest` · `npm run viewer` · `npm run start` — plus the old `position_monitor.ts`. The entire `src/server/` directory and `src/replay/cli.ts` / `framework.ts` / `basket-runner.ts` / `batch-worker.ts` / `index.ts` are gone.

## Architecture

### Source Tree (`src/`)

```
src/
├── config.ts              — env-driven config (port, Tradier creds, DB path, market holidays)
├── types.ts               — Bar, Contract, Timeframe, IndicatorState, ...
├── agent/                 — model-clients (scanners/judge), regime-classifier, market-feed, types
├── backfill/              — job-store, missing-dates helpers
├── config/                — types.ts (Config), defaults.ts (DEFAULT_CONFIG, mergeConfig, validateConfig)
├── core/                  — SINGLE SOURCE OF TRUTH for deterministic trading logic (see below)
├── data/                  — economic-calendar.json
├── framework/             — agent-runner: runAgent(), validateAgentBoot(), formatBootBanner()
├── instruments/           — registry, discovery, symbol-format, profile-store, expiry-resolver,
│                            seed-profiles, backfill-routing; profiles/{spx-0dte,ndx-0dte,spy-1dte}.ts
├── live/                  — bs.ts (live Black-Scholes delta), instruments.ts (capture targets)
├── ops/                   — pipeline-health
├── pipeline/              — aggregator, bar-builder, mtf-builder, indicators/{tier1,tier2}
│                            (spx/ subdirectory is EMPTY — legacy, safe to delete)
├── providers/             — tradier, thetadata, yahoo
├── replay/                — machine, store, types, config, metrics, bar-cache-file, prompt-library
├── shared/                — stockx-triggers.ts (COPIED VERBATIM from optionx → backtest==live)
├── storage/               — replay-db, db, queries, or-levels, pivot-levels,
│                            parquet-{reader,reader-sync,writer}, archiver, snapshot-writer
└── utils/                 — et-time (UTC↔ET helpers), resilience
```

### Shared Core (`src/core/`) — Single Source of Truth

All deterministic trading logic lives here. Sweep engines and (in OptionX) the live agent import these directly. **Never duplicate this logic.**

```
src/core/
├── types.ts              — CoreBar, Signal, Position, ExitContext, Direction, SignalType, ExitReason, PriceGetter
├── signal-detector.ts    — detectSignals(): HMA/EMA crosses, RSI, price-based
├── strategy-engine.ts    — detectSignal() + signal state tracking
├── trade-manager.ts      — evaluateEntry(), evaluateExit()
├── position-manager.ts   — checkExit(): SL, TP, signal reversal, time-based
├── position-sizer.ts     — computeQty(): dynamic sizing from Config
├── entry-gate.ts         — checkEntryGates(): risk checks, cooldown, time window, close cutoff
├── risk-guard.ts         — max daily loss, max positions, trades/day limit
├── regime-gate.ts        — isRegimeBlocked(): regime-based entry filtering
├── strike-selector.ts    — selectStrike(): OTM contract selection from band
├── reentry-evaluator.ts  — TP re-entry chains
├── indicator-engine.ts   — HMA, RSI, Bollinger, EMA, ATR, VWAP, KC
├── fill-model.ts         — slippage: book-walk, participation-rate gates (Phases 1-4)
├── friction.ts           — spread + commission cost model; computeRealisticPnl()
├── option-tick.ts        — option tick-size rounding
├── bar-validator.ts      — OHLCV gap detection, synthetic bar handling
└── index.ts              — barrel re-exports
```

**Key principle**: the same code path produces identical behavior in backtest and live. `src/shared/stockx-triggers.ts` is intentionally copied byte-for-byte from OptionX so the StockX backtest matches the live engine.

### Timezone Helpers (`src/utils/et-time.ts`)

The server runs in UTC. **Never** construct a `Date` from a locale-formatted ET string. Always use:

```
getETOffsetMs(now?)    — UTC minus ET in ms (14.4M for EDT, 18M for EST)
todayET(now?)          — today's date in ET as 'YYYY-MM-DD'
nowET(now?)            — current ET time as { h, m, s }
etTimeToUnixTs(time)   — '16:00' ET today → Unix seconds
```

Used across `risk-guard`, `position-manager`, `live-capture`, and the sweep scripts. Add new ET-dependent logic here, not inline.

### Config System (`src/config/`)

```
src/config/types.ts     — canonical Config type
src/config/defaults.ts  — DEFAULT_CONFIG, mergeConfig(), validateConfig()
```

> Note: there are two config modules. `src/config.ts` (standalone file) holds **environment/runtime** config (port, Tradier creds, DB path, holidays). `src/config/` (directory) holds the **trading strategy** `Config` type. Don't conflate them.

### Backtest Studio (`scripts/autoresearch/backtest-server.ts`)

The primary HTTP server (**port 3700**). It is a single bundled file (recovered from the esbuild transpile cache after the source was lost while PM2 kept running it — see the file header). Responsibilities:

- Serves the backtest viewer HTML (`scripts/autoresearch/public/`)
- Runs HMA/DEMA multi-TF option backtests across strategies × dates with on-disk caching (`output/cache/`)
- Serves spread-sweep / long-sweep / iron-sweep / ETF-long results from `output/*.json`
- **`/api/take-live`** — converts a `{signal, spread, exit}` sweep row into an OptionX config JSON, writes it to `~/optionx/configs/{id}.json`, returns the PM2 launch command
- `/api/live-configs` — reflects OptionX configs currently on disk + their PM2 status
- On-demand single-config runs (`/api/long-sweep/run`, `/api/risk-analysis/compute`) spawn child processes

Instruments are resolved per-request via the `?profile=`/`?symbol=` query (SPX/NDX/SPY/QQQ/XSP), so one server serves all tickers.

### Replay Engine (`src/replay/`)

```
src/replay/
├── machine.ts          — config-driven single-day replay engine (bar cache, signal detection, trade exec)
├── store.ts            — SQLite store: replay_configs / replay_runs / replay_results tables
├── types.ts            — ReplayConfig, Trade, ReplayResult
├── config.ts           — replay-specific config helpers
├── metrics.ts          — trade analysis: win rate, Sharpe, P&L, drawdown
├── bar-cache-file.ts   — binary cache (.brc) reader/writer for 1m bars (the HOT path for all sweeps)
└── prompt-library.ts   — scanner/judge prompt templates
```

`machine.ts` was historically driven by the now-deleted `cli.ts`. The **active** backtest tooling (diag sweep scripts + `backtest-server.ts`) reads `bar-cache-file.ts` directly rather than going through `machine.ts`. `machine.ts` is still imported by `scripts/replay-hma-test.ts` and `scripts/test-config-debug.ts`.

**Performance**: replay/sweep is fast — a full day (~159K bars) loads in seconds via the in-memory bar cache.

### StockX (`src/shared/stockx-triggers.ts` + `scripts/diag/stockx-backtest.ts`)

A **stock** (not index) HMA backtest engine. `src/shared/stockx-triggers.ts` is copied verbatim from OptionX so the backtest matches the live stock engine exactly. Conventions: entry signal at bar **close**, fill at **next bar open** (no look-ahead); exits checked from the entry bar onward with conservative intrabar SL-before-TP; **SHARE** sizing (P&L ×1, no option multiplier), integer shares via `Math.floor`. Optional per-side slippage + commission.

### Data Pipeline (`src/pipeline/`)

```
src/pipeline/
├── bar-builder.ts       — OHLCV bar construction from timesales
├── aggregator.ts        — 5m/15m/1h from 1m bars
├── mtf-builder.ts       — multi-timeframe construction
└── indicators/
    ├── tier1.ts         — HMA, EMA, RSI, Bollinger, ATR, KC, VWAP (all instruments)
    └── tier2.ts         — SMA, Stochastic, MACD, ADX (underlyings/regime only)
```

`src/pipeline/indicator-engine.ts` does **not** exist on this branch — indicator logic lives in `src/core/indicator-engine.ts` and `src/pipeline/indicators/tier1.ts`. (The old CLAUDE.md referenced a re-export shim that was removed.)

**Higher timeframes are always aggregated from 1m bars**, never fetched independently.

### Instrument Management (`src/instruments/`)

Multi-instrument support (SPX, NDX, XSP, SPY, QQQ): `registry.ts`, `discovery.ts` (auto-detect profile from symbol), `symbol-format.ts` (Tradier ↔ standard), `profiles/` (spx-0dte, ndx-0dte, spy-1dte), `profile-store.ts`, `expiry-resolver.ts`, `backfill-routing.ts`, `seed-profiles.ts`.

## Database & Data Layout

| Path | Purpose |
|------|---------|
| `data/replay.db` | Replay meta: `replay_configs`, `replay_runs`, `replay_results`, `replay_jobs`, `leaderboard_reports`, `optimizer_results` (this is `replay-db.ts`'s default) |
| `data/spxer.db` | Legacy/alternative DB path (set via `DB_PATH`; see Known Issues) |
| `data/parquet/bars/{profile}/{date}.parquet` | Historical OHLCV bars (**primary** source for backtest) |
| `data/parquet/snapshots/{profile}/{date}.parquet` | **NEW** — per-minute bid/ask + greeks + live BS delta (from live-capture) |
| `data/cache/{date}_{tf}.{po\|full}.brc` | Binary optimized bar cache (hot path; `.po`=price-only, `.full`=with indicators) |
| `data/live-capture/{date}.db` | Per-day SQLite for crash-safe capture resume (keyed by profile,ts,symbol) |
| `data/flatfile-cache/{SPXW,NDXP,SPY,QQQ}/` | Cached flat-file (CSV) option data |

**Bar loading priority**: BRC cache → Parquet → SQLite. Higher timeframes (≠ `1m`) are aggregated from the `1m` base inside `loadBarCache()`.

## Key Types

- `src/types.ts` — `Bar` (OHLCV + `synthetic` + `gapType` + `indicators`), `Contract`, `Timeframe` (`'1m'|'5m'|'15m'|'1h'|'1d'`), `IndicatorState`
- `src/core/types.ts` — `CoreBar`, `Signal`, `Position`, `ExitCheck`, `TradeResult`, `Direction`, `SignalType`, `ExitReason`, `PriceGetter`
- `src/config/types.ts` — `Config`, `ModelRecord`, `PromptRecord`, `ResolvedConfig`, `SignalGate`
- `src/replay/types.ts` — `ReplayConfig`, `Trade`, `ReplayResult`

## Environment Variables

See `.env.example`. Required for full operation:

- `TRADIER_TOKEN` — Tradier API token (the **only** remaining market-data source; Polygon + ThetaData are cancelled)
- `TRADIER_ACCOUNT_ID` — account id (live execution now lives in OptionX)
- `DB_PATH` — DB path (note: `replay-db.ts` defaults to `data/replay.db`, `config.ts` defaults to `./data/spxer.db` — see Known Issues)
- `PORT` — legacy default 3600 (the backtest studio hardcodes **3700**)
- `PARQUET_ROOT` — parquet tree root (default `data/parquet/bars`)

Agent / model keys (used by `src/agent/`): `ANTHROPIC_API_KEY`, `LITELLM_BASE_URL` + `LITELLM_KEY`, optional `KIMI_API_KEY` / `GLM_API_KEY` / `MINIMAX_API_KEY` (+ `*_BASE_URL`), `KIMI_MODEL` / `GLM_MODEL` / `MINIMAX_MODEL` / `OPUS_MODEL`.

Other: `GDRIVE_REMOTE` (archival), `LOG_LEVEL`, `NODE_ENV`.

## Testing

Tests mirror `src/` and `scripts/` under `tests/`. Vitest with `globals: true`, `node` environment, 10s timeout. **684 tests pass.**

```
tests/
├── backfill/      ─── backfill pipeline tests
├── core/          ─── core trading logic (signal-detector, position-manager, friction, fill-model, …)
├── diag/          ─── diag/sweep script tests (black-scholes, delta-grid, fib-bb, regime, smc, tlb, …)
├── fixtures/      ─── shared test fixtures
├── framework/     ─── agent-runner tests
├── instruments/   ─── instrument registry / symbol-format tests
├── integration/   ─── end-to-end integration tests
├── pipeline/      ─── bar builder, aggregator, indicator engine (+ indicators/)
├── providers/     ─── Tradier / ThetaData / Yahoo
├── storage/       ─── DB and query tests
└── utils/         ─── et-time, resilience
```

A separate live/E2E config exists at `vitest.live.config.ts` (240s timeout, `tests/e2e/live-*.test.ts`): `npx vitest --config vitest.live.config.ts run`.

## Operations Scripts (`scripts/ops/`)

| Script | Purpose |
|--------|---------|
| `eod-pipeline.sh` | Nightly: backfill today → incremental sweep (or `--bootstrap` for full recompute). flock-mutexed + timeout-bounded (see FR-001 notes above) |
| `sweep-reaper.sh` | Cron (13,43 * * * *): kills sweep/eod process trees older than 6h; `--dry-run` previews |
| `daily-backfill.sh` (via `daily-backfill.ts`) | Nightly candlestick backfill, all profiles |
| `live-capture-start.sh` | Start the live-capture daemon |
| `check-environment.sh` / `check-data-pipeline.sh` | Health checks |
| `monitor-operational.sh` / `monitor-active-trading.sh` / `monitor-signal-detection.sh` | Operational monitoring (some reference the old live services — verify before relying on them) |
| `monthly-catchup.sh` | Bulk historical catch-up |

See `DAILY-OPS-CHECKLIST.md` and `SERVICE-ARCHITECTURE.md` (note: both predate the OptionX split and describe the old in-repo live services — read with that in mind).

## Design Decisions

- **Core modules are the single source of truth** — `src/core/` holds all deterministic trading logic; backtest and (OptionX) live import it. Never duplicate. `src/shared/stockx-triggers.ts` is copied verbatim from OptionX for the same reason.
- **SPXer does not trade.** It backtests, captures data, and hands configs to OptionX. Do not add order-execution code here.
- **Higher timeframes (5m/15m/1h) are aggregated from 1m bars**, never fetched independently.
- **Contract symbol format** — Tradier canonical: `SPXW260318C05000000` (SPXW + YYMMDD + C/P + 8-digit zero-padded strike × 1000).
- **All ET timezone handling goes through `src/utils/et-time.ts`.** Never use `new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))` — it silently misinterprets ET as UTC.
- **Trade friction model** — always-on $0.05 half-spread + $0.35 commission per side in all P&L. See `src/core/friction.ts`.
- **Fill model (Phases 1-4)** — execution realism on top of friction; Phase 4 adds participation-rate liquidity gates. See `docs/FILL-MODEL.md`, `src/core/fill-model.ts`.
- **Immutable data** — object spreads, never mutate in-place.
- **Indicator computation** — incremental, state-based (`src/core/indicator-engine.ts`, `src/pipeline/indicators/tier1.ts`), never recomputed from scratch.
- **Backtest must match live** — StockX trigger logic and core trading logic are shared verbatim with OptionX. Changing them here changes live behavior.

## For AI Agents Working In This Codebase

### Where to Start
1. **Read `CODE-REVIEW-2026-08-09.md`** for the current accurate status (the 2026-05-22 review is superseded).
2. **`src/core/`** is the single source of truth — read it before touching signals, exits, risk, strike selection, or fills.
3. **Follow the types** — `src/types.ts`, `src/core/types.ts`, `src/config/types.ts`, `src/replay/types.ts`. Don't invent ad-hoc types.
4. **The hot backtest path** is `bar-cache-file.ts` → sweep scripts / `backtest-server.ts`, not `machine.ts`.
5. **Live trading is in `~/optionx`, not here.** Configs flow SPXer → `~/optionx/configs/` via `take-live`.

### Testing Requirements
- Unit tests for pure functions (indicators, formatters, bar builders, friction/fill math)
- `npm run test` must stay green before commit (currently 684/684)
- Replay/sweep validation via `npx tsx scripts/diag/<sweep>.ts` for end-to-end checks

### Common Patterns
- **Immutable data**: object spreads, never in-place mutation
- **Incremental indicators**: state-based, never from scratch
- **Error handling**: explicit at boundaries (API calls, file I/O); let internal guarantees work
- **Logging**: `console.log` with timestamps
- **Timezone**: always `src/utils/et-time.ts` helpers

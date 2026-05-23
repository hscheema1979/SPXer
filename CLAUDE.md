# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current Branch Status: `feat/shorts-fresh-fill-study`

This branch focuses on **replay/backtest analysis and EOD pipelines only**. Live trading services (event handler, position monitor, data service, Schwaber) have been temporarily removed from this branch to streamline development. These services exist unchanged on `master` and can be restored if needed.

**See `CODE-REVIEW-2026-05-22.md` for detailed audit of compilation errors, test failures, and architectural issues.**

### ⚠️ Known Issues (Must Fix)
- 15 TypeScript compilation errors (or-levels stub, type mismatches)
- 27 test failures
- OR-levels and pivot-levels implementations stubbed out
- Replay viewer API routes are overly complex (3400+ lines in one file)

## What is SPXer

SPXer is a trading system with **independent services** sharing a unified core. On this branch, only the replay/backtest system and analytics services are active.

### Service Architecture (Replay Focus — This Branch)

| Service | Purpose | Status | Note |
|---------|---------|--------|------|
| **replay engine** | Config-driven backtesting | ✅ Active | `src/replay/machine.ts` |
| **replay viewer** | Web UI for replay results | ✅ Active | `npm run viewer` on port 3601 |
| **EOD pipeline** | Nightly replay + sweep aggregation | ✅ Active | `npm run eod` |
| **Admin viewer** | Config/result management | ✅ Active | Embedded in replay viewer |

### Live Trading Services (Deleted from This Branch)
These exist on `master` but have been removed here during refactoring:
- ❌ **Data service** (`npm run dev`) — Market data pipeline
- ❌ **Event handler** (`npm run handler`) — Live trading agent
- ❌ **Position monitor** — Exit observer
- ❌ **Schwaber** (`npm run schwaber`) — Schwab ETF trader

### Replay System (`npm run replay` — CURRENT FOCUS)

A config-driven backtesting engine that replays historical days through the same signal detection → scanner → judge pipeline, using an in-memory bar cache for performance.

**Critical architecture principle**: Both the live handler and replay system import core trading logic from `src/core/`. The same `Config` object fed to either system produces identical signal detection, strike selection, position exit, and risk evaluation. Test in replay → deploy to live with confidence.

**Signal source (v2.0 - independent architecture)**: The event handler is now 100% independent — it fetches all data directly from Tradier REST API and computes signals locally. It uses `detectHmaCrossPair()` from `src/pipeline/spx/signal-detector-function.ts`, which detects HMA crosses on **option contract bars** (not the SPX underlying). The SPX underlying is used only as a direction gate and for reversal detection.

**Previous signal source (v1.0 - deprecated)**: The event handler used to subscribe to WebSocket signals emitted by the data service (`contract_signal:{hmaPair}` channels). This has been replaced with independent Tradier REST API polling for maximum fault isolation.

## Commands (Current Branch)

```bash
# Replay & Analysis (ACTIVE ON THIS BRANCH)
npm run replay           # Single-day replay (tsx src/replay/cli.ts run)
npm run backtest         # Multi-day replay, no scanners/judges
npm run viewer           # Replay viewer web UI (port 3601) — main UI
npm run start            # Alias for viewer

# EOD Pipeline (nightly data refresh)
npm run eod              # Run end-of-day pipeline (incremental replay + sweep)

# Development
npm run build            # TypeScript compile to dist/ [BROKEN — 15 TS errors]
npm run test             # Run all tests (vitest run) [27 tests failing]
npm run test:watch       # Run tests in watch mode
```

### ❌ Commands Deleted (Exist on master, Not Here)
```bash
# These commands no longer exist on this branch:
npm run dev              # Data service — deleted
npm run handler          # Event handler — deleted
npm run agent            # Agent alias — deleted
npm run schwaber         # Schwab trader — deleted
npx tsx position_monitor.ts  # Position monitor — deleted
```

## Architecture

### Shared Core (`src/core/`) — Single Source of Truth

The replay system imports all deterministic trading logic from `src/core/`. **Never duplicate this logic.**

```
src/core/
├── types.ts                  — Signal, Direction, Position, ExitContext
├── signal-detector.ts        — detectSignals(): HMA crosses, RSI, EMA, price-based
├── position-manager.ts       — checkExit(): SL, TP, signal reversal, time-based
├── position-sizer.ts         — computeQty(): dynamic sizing from Config
├── entry-gate.ts             — checkEntryGates(): risk checks, cooldown, time window
├── risk-guard.ts             — Max daily loss, max positions, trades/day limit
├── regime-gate.ts            — isRegimeBlocked(): regime-based entry filtering
├── strike-selector.ts        — selectStrike(): OTM contract selection from band
├── strategy-engine.ts        — detectSignal(), signal state tracking
├── trade-manager.ts          — evaluateEntry(), evaluateExit()
├── reentry-evaluator.ts      — Handle TP re-entry chains
├── indicator-engine.ts       — HMA, RSI, Bollinger, EMA, ATR, VWAP, KC
├── friction.ts               — Spread + commission cost model
├── fill-model.ts             — Slippage: book-walk, participation-rate gates
├── bar-validator.ts          — OHLCV gap detection, synthetic bar handling
├── option-tick.ts            — Option tick size rounding
└── index.ts                  — Barrel re-exports
```

**Key principle**: Replay system imports these and calls them directly. Live agents (when restored on master) do the same. Same code path = identical behavior.

### Timezone Helpers (`src/utils/et-time.ts`)

All UTC↔ET conversions must use these shared helpers. The server runs in UTC — never construct a `Date` from a locale-formatted ET string.

```
src/utils/
├── et-time.ts
│   ├── getETOffsetMs(now?)    — UTC minus ET in ms (14.4M for EDT, 18M for EST)
│   ├── todayET(now?)          — today's date in ET as 'YYYY-MM-DD'
│   ├── nowET(now?)            — current ET time as { h, m, s }
│   └── etTimeToUnixTs(time)   — '16:00' ET today → Unix seconds
├── health.ts                  — HealthTracker: provider uptime, data freshness monitoring
└── resilience.ts              — Retry/backoff helpers for API calls
```

Used by: `risk-guard.ts`, `position-manager.ts`, `scheduler.ts`, `contract-tracker.ts`. Add new ET-dependent logic here, not inline.

### Config System (`src/config/`)

```
src/config/
├── types.ts          — Canonical type: Config (stored in replay_configs table)
└── defaults.ts       — DEFAULT_CONFIG, mergeConfig(), validateConfig()
```

All subsystems share the same `Config` type. Configs are stored as JSON in the `replay_configs` table of `spxer.db` via `ReplayStore`. Both replay and live agents load configs by ID from this single table. Test a config in replay → set `AGENT_CONFIG_ID` → deploy to live.

### Replay System (`src/replay/`) — CURRENT FOCUS

The replay engine is the core of this branch:

```
src/replay/
├── machine.ts              — Core replay engine: bar cache, signal detection, trade execution
├── cli.ts                  — CLI: run (single day), backtest (multi-day), results, sweep
├── store.ts                — SQLite store for configs, runs, results
├── basket-runner.ts        — Multi-member basket config support
├── batch-worker.ts         — Multi-day parallel replay via child processes
├── bar-cache-file.ts       — Binary cache (.brc) for 1m bars (performance optimization)
├── metrics.ts              — Trade analysis: win rate, Sharpe, P&L, drawdown
├── framework.ts            — Cycle snapshot builder
├── types.ts                — ReplayConfig, Trade, ReplayResult types
├── cli-config.ts           — CLI flag parsing
├── index.ts                — Barrel exports
└── prompt-library.ts       — Scanner/judge prompts (18 templates)
```

**Performance**: Replay is **fast** — Mar 20 (159K bars) replays in ~5 seconds using in-memory bar cache.

**Data sources**: Priority: BRC file → Parquet → SQLite. Parquet is primary for historical data; SQLite fallback when parquet missing.

### Replay Viewer & APIs (`src/server/`)

**Main files**:
- `replay-server.ts` — Express server entry point (port 3601)
- `replay-routes.ts` — API endpoints (3400+ lines, needs splitting)
- `sweep-manager-routes.ts` — Sweep aggregation endpoints
- `admin-routes.ts` — Config CRUD
- Multiple viewer HTML files for different analysis views

**⚠️ Issue**: `replay-routes.ts` is monolithic and mixes concerns (routes, queries, level computation). Needs splitting into `replay-query.ts`, `replay-levels.ts`, etc. See CODE-REVIEW for details.

### Data Pipeline (`src/pipeline/`)

```
src/pipeline/
├── bar-builder.ts          — OHLCV bar construction from timesales
├── aggregator.ts           — 5m/15m/1h from 1m bars
├── indicator-engine.ts     — Wrapper/shim to src/core/indicator-engine
├── mtf-builder.ts          — Multi-timeframe construction
├── indicators/
│   ├── tier1.ts            — HMA, EMA, RSI, Bollinger, ATR, KC, VWAP
│   └── tier2.ts            — SMA, Stochastic, MACD, ADX (unused in replay)
└── (deleted: contract-tracker, scheduler, price-stream, option-stream, etc.)
```

**Note**: `src/pipeline/indicator-engine.ts` is a **re-export shim** — actual logic lives in `src/core/indicator-engine.ts` and `src/pipeline/indicators/tier1.ts`.

### Instrument Management (`src/instruments/`)

Multi-instrument support (SPX, NDX, SPY, QQQ, etc.):

```
src/instruments/
├── types.ts                — InstrumentProfile, BackfillStrategy
├── registry.ts             — Symbol → profile mapping
├── profiles/
│   ├── spx-0dte.ts         — SPX 0DTE profile
│   ├── ndx-0dte.ts         — NDX 0DTE profile
│   └── spy-1dte.ts         — SPY 1DTE profile
├── discovery.ts            — Auto-detect profile from symbol
├── profile-store.ts        — Load/save profiles to DB
├── symbol-format.ts        — Tradier ↔ standard symbol conversion
├── backfill-routing.ts     — Data source routing (Polygon, ThetaData, etc.)
└── seed-profiles.ts        — Initialize default profiles
```

### Indicator Architecture (Tier 1 + Tier 2)

**Tier 1** (all instruments): HMA, EMA, RSI, Bollinger Bands, ATR, KC (Keltner Channel), VWAP
- Defined in `src/pipeline/indicators/tier1.ts`
- Called by replay engine for all bars

**Tier 2** (underlyings only): EMA 50/200, SMA, Stochastic, CCI, Momentum, MACD, ADX
- Defined in `src/pipeline/indicators/tier2.ts`
- Used only for regime classification (not in replay core)

**Incremental computation**: Indicators maintain rolling window state (HMA uses 25-bar max). Never recomputed from scratch — only updated per new bar.

### Autoresearch System (`scripts/autoresearch/`)

Parameter optimization loop: modify config → run replay → measure composite score → keep/discard.

```
scripts/autoresearch/
├── verify-metric.ts          — Single-run parameter verification with CLI flags
├── param-search.ts           — Automated multi-parameter search
├── config-optimizer.ts       — Config mutation helpers
├── verify-metric-wrapper.sh  — Shell wrapper for verify-metric
├── optimizer/                — Optimization strategy implementations
├── sessions/                 — Historical session logs
└── RESEARCH-BRIEF.md         — Autoresearch methodology documentation
```

**Composite score**: `(winRate * 40) + (sharpe * 30) + (avgDailyPnl > 0 ? 20 : 0) + (maxLoss > -500 ? 10 : 0)`. Range 0-100.

**verify-metric.ts CLI flags**: `--dates`, `--no-scanners`, `--strikeSearchRange`, `--contractPriceMin`, `--contractPriceMax`, `--rsiOversold`, `--rsiOverbought`, `--optionRsiOversold`, `--optionRsiOverbought`, `--stopLossPercent`, `--takeProfitMultiplier`, `--activeStart`, `--activeEnd`, `--cooldownSec`, `--maxDailyLoss`, `--enableHmaCrosses`, `--enableEmaCrosses`, `--hmaCrossFast`, `--hmaCrossSlow`, `--emaCrossFast`, `--emaCrossSlow`, `--timeframe`, `--label`, `--config-file`.

### Other Source Directories

```
src/data/
└── economic-calendar.json    — US economic calendar data for regime awareness
```

## Key Types (`src/types.ts`)

- `Bar` — OHLCV + `synthetic` flag + `gapType` + `indicators` (flat JSON blob)
- `Contract` — Options contract with `ContractState` lifecycle
- `Timeframe` — `'1m' | '5m' | '15m' | '1h' | '1d'`
- `IndicatorState` — Rolling window state for incremental indicator computation

`src/core/types.ts`: `CoreBar`, `Signal`, `Position`, `ExitCheck`, `TradeResult`, `Direction`, `SignalType`, `ExitReason`, `PriceGetter`

`src/config/types.ts`: `Config`, `ModelRecord`, `PromptRecord`, `ResolvedConfig`, `SignalGate`

## Environment Variables

Required in `.env`:
- `TRADIER_TOKEN` — Tradier API token (data + order execution)
- `TRADIER_ACCOUNT_ID` — For live trading
- `ANTHROPIC_API_KEY` — For judge in the trading agent
- `PORT` — Default 3600
- `DB_PATH` — Default `./data/spxer.db`

Agent execution modes (mutually exclusive):
- `AGENT_EXECUTION_MODE=SIMULATION` — Live signals with locally-simulated orders (safest for testing)
- `AGENT_PAPER=true` — Live signals + Tradier paper account (not recommended — often broken)
- `AGENT_PAPER=false` — Live signals + Tradier production account (real trading)

Agent config: `AGENT_CONFIG_ID` (single) or `AGENT_CONFIG_IDS` (comma-separated) selects which config(s) from `replay_configs` table to load.

Third-party model keys: `KIMI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY` (with corresponding `*_BASE_URL`)

Other: `POLYGON_API_KEY` (historical data backfill), `LITELLM_BASE_URL` + `LITELLM_KEY` (LiteLLM proxy), `GDRIVE_REMOTE` (archival), `LOG_LEVEL`

## REST API (port 3601 — Replay Viewer)

**Status**: Replay viewer is active. ⚠️ Data service endpoints (port 3600) are deleted on this branch.

### Main UI & Config Management
- `GET /` — Main replay viewer HTML (charts, config search, results)
- `GET /admin` — Admin viewer (config CRUD, sweep management)
- `GET /sweep` — Sweep viewer (parameter sweep analysis)

### Replay Execution & Results
- `GET /api/dates?instrument=SPX|NDX` — Available replay dates
- `GET /api/configs` — All saved configs (filtered by day count unless `?all=1`)
- `GET /api/config/:id` — Single config details
- `GET /api/defaults` — Default config values
- `POST /api/run` — Trigger single-day replay
- `POST /api/run-batch` — Trigger multi-day parallel replay
- `GET /api/job/:jobId` — Check background job status
- `GET /api/jobs` — List all jobs
- `GET /api/results?configId=X&date=Y` — Replay trade results

### Analysis & Aggregation
- `GET /api/sweep?configId=X` — Parameter sweep results (multi-date aggregated)
- `GET /api/sweep/:configId/daily` — Daily P&L breakdown per date
- `GET /api/config/:configId/analysis?dates=YYYY-MM-DD,YYYY-MM-DD` — Trade analysis across dates
- `GET /api/or-levels?date=&orMinutes=30` — Opening Range levels (computed or cached)
- `GET /api/pivot-levels?date=` — Pivot point levels

### Historical Data
- `GET /api/bars?date=X&symbol=Y&tf=1m` — Historical 1m bars
- `GET /api/contracts?date=X` — Contracts available for a replay date

## Testing

Tests mirror `src/` structure under `tests/`. Uses Vitest with `globals: true` and `node` environment. Test timeout is 10s. Tests cover: bar builder, aggregator, indicator engine, contract tracker, scheduler, all three providers, storage layer, HTTP server, core modules, and monitor.

```
tests/
├── core/         — Core trading logic tests (signal-detector, position-manager, etc.)
├── monitor/      — Monitor infrastructure tests (account-monitor disabled)
├── pipeline/     — Bar builder, aggregator, indicator engine, contract tracker, scheduler
├── providers/    — Tradier, Yahoo, TradingView screener
├── server/       — HTTP API tests
├── storage/      — DB and query tests
└── smoke.test.ts — End-to-end smoke tests
```

## Design Decisions (Replay Focus)

- **Core modules are the single source of truth** — `src/core/` contains all deterministic trading logic (signal detection, exit conditions, risk checks, strike selection). Replay imports these directly. Never duplicate trading logic.
- **Higher timeframes (5m/15m/1h) are aggregated from 1m bars**, never fetched independently.
- **Contract symbol format** — Tradier canonical: `SPXW260318C05000000` (SPXW + YYMMDD + C/P + 8-digit zero-padded strike × 1000).
- **OTM only** — Strike selector targets $0.20-$8.00 OTM contracts in replay.
- **All ET timezone handling goes through `src/utils/et-time.ts`** — The server runs in UTC. **Never** use `new Date(date.toLocaleString(...))` — it silently misinterprets ET as UTC. Use: `getETOffsetMs()`, `todayET()`, `nowET()`, `etTimeToUnixTs()`.
- **Trade friction model** — Always-on $0.05 half-spread + $0.35 commission per side in all P&L calculations. See `src/core/friction.ts`.
- **Fill model (Phases 1-4)** — Execution realism on top of friction. See `docs/FILL-MODEL.md` for spec. Phase 4 includes participation-rate liquidity gates.
- **Immutable data** — Use object spreads, never mutate in-place.
- **Indicator computation** — Incremental state-based (see `src/core/indicator-engine.ts`), never from scratch.

## Database Architecture (Replay Focus)

Single database for all replay data:

| Database | Purpose |
|----------|---------|
| `data/spxer.db` | Configs (`replay_configs`), runs, results, sweeps, jobs |

**Optional data sources**:
- **Parquet** (`data/parquet/bars/{profile}/{date}.parquet`) — Historical bars (primary source)
- **SQLite replay_bars** — Backup if parquet missing
- **BRC cache files** (`data/cache/{date}_1m.full.brc`) — Binary optimized cache

**Bar loading priority**: (1) BRC cache → (2) Parquet → (3) SQLite

## Autoresearch Key Findings (Sessions 1-8)

| Finding | Score | Detail |
|---------|-------|--------|
| 180s cooldown optimal | 92.73 | s6: 81.8% WR, beats 120s/300s/600s |
| Strike range ±75-100 | 91.58 | s1: morning window, wide enough for emergencies |
| Option RSI 40/60 (tight) | 86.67 | s5: filters for quality signals |
| SL 80% > SL 50% | 85.26 | s3: hold winners longer |
| HMA essential | — | s7: removing drops score 83→49 |
| EMA hurts | — | s8: enabling drops score 83→54 |
| RSI thresholds don't matter | — | s2: 15/85 ≈ 20/80 ≈ 25/75 ≈ 30/70 |

## Known Issues on This Branch (feat/shorts-fresh-fill-study)

**See `CODE-REVIEW-2026-05-22.md` for full audit and recommendations.**

### Compilation Errors (15 Total) — MUST FIX

1. **OR-levels stub mismatch** (12 errors in `replay-routes.ts`)
   - File: `src/storage/or-levels.ts` is stubbed with wrong function signatures
   - Impact: Functions called with wrong arg count (e.g., `ensureOrLevelsTable()` called with db param but expects 0 args)
   - Fix: Update stub signatures to match call sites, or restore full implementation from git history

2. **Missing Config.config property** (1 error in `replay-server.ts:50`)
   - Impact: `res.json({ config: sessionConfig.config })` → property doesn't exist
   - Fix: Check `sessionConfig` shape and adjust response structure

3. **Query parameter type mismatches** (2 errors in `sweep-manager-routes.ts`)
   - Impact: `req.query` returns `string | string[]` but assigned as string
   - Fix: Add array handling logic

### Test Failures (27 Total) — Blocking Quality Gate

- 450 passing, 27 failing (94.3% pass rate)
- Failures likely due to OR-levels stub and missing implementations
- Action: Run `npm run test` with verbose output to identify root causes

### Stubbed Implementations

```
src/storage/or-levels.ts       — Opening Range level computation (STUB)
src/storage/pivot-levels.ts    — Pivot level computation (STUB?)
```

These were deleted from working tree; stubs added to prevent boot errors. Need restoration or full implementation.

### Architectural Debt

| Issue | Impact | Effort |
|-------|--------|--------|
| `replay-routes.ts` (3400+ lines) | Unmaintainable, mixed concerns | Split into 5 files |
| Config type duplication | Confusion between Config/ReplayConfig | Unify to single type |
| Indicator architecture split | Unclear which file owns what | Document in CLAUDE.md |

---

## For AI Agents Working In This Codebase

### Where to Start

1. **FIRST: Read CODE-REVIEW-2026-05-22.md** — Understand current status, blockers, and what's broken
2. **Start in `/src`** — All application logic lives in `src/`. Root scripts are entry points and utilities.
3. **Understand core trading logic** — Read `src/core/` — this is the single source of truth for signals, exits, risk, and strike selection.
4. **Follow the types** — All types defined in `src/types.ts`, `src/core/types.ts`, and `src/config/types.ts`. Don't create ad-hoc types.
5. **Understand the replay system** — Read `src/replay/machine.ts` → it's the heart of this branch

### Testing Requirements

- Unit tests for pure functions (indicator calculations, formatters, bar builders)
- Integration tests for API endpoints and data flows
- Replay validation for end-to-end testing (run `npx tsx src/replay/cli.ts backtest` with full date range)
- All changes require `npm run test` passing before commit

### Common Patterns

- **Immutable data**: Use object spreads, never mutate in-place
- **Indicator computation**: Incremental state-based (see `src/core/indicator-engine.ts`), never from scratch
- **Error handling**: Explicit at boundaries (API calls, file I/O); let internal guarantees work
- **Configuration**: Use `src/config.ts` for environment-dependent values, `Config` type for trading strategy. Execution routing (symbol, account, option prefix) is hardcoded per-agent, NOT in Config.
- **Logging**: Use `console.log` with timestamps for simple logging
- **Timezone handling**: Server runs in UTC. All ET conversions use `src/utils/et-time.ts` helpers (`getETOffsetMs`, `todayET`, `nowET`, `etTimeToUnixTs`). **Never** use `new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))` — it silently misinterprets ET as UTC.

## Operations Scripts (`scripts/ops/`)

A comprehensive suite of scripts for monitoring and automation:

| Script | Purpose |
|--------|---------|
| `check-environment.sh` | Environment verification (date/time, process status, resources) |
| `check-data-pipeline.sh` | Data service health check |
| `monitor-active-trading.sh` | Real-time active trading monitoring |
| `monitor-operational.sh` | Operational status monitoring |
| `monitor-signal-detection.sh` | Signal detection monitoring |
| `setup-complete-automation.sh` | Complete automation setup |
| `start-warmup.sh` | Pre-market warmup |
| `transition-from-warmup.sh` | Transition from warmup to active trading |

See `DAILY-OPS-CHECKLIST.md` for the complete operational checklist and `SERVICE-ARCHITECTURE.md` for details on the three-independent-services architecture.

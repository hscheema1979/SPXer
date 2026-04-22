# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SPXer

SPXer is three systems sharing a unified core:

1. **Data Service** (`npm run dev`) — An always-on 24/5 market data pipeline that polls SPX/ES futures, tracks ~250-480 SPXW 0DTE options contracts via a sticky band model, builds 1m OHLCV bars with a full indicator battery, and serves enriched data over REST + WebSocket on port 3600.

2. **Trading Agent** (`npm run agent`) — Deterministic execution driven by option contract HMA crosses, live by default (`AGENT_PAPER=false`). 0DTE SPX options on margin account (6YA51425). $15 OTM, up to 10 contracts, 15% of buying power.

3. **Replay System** (`npm run replay`) — A config-driven backtesting engine that replays historical days through the same signal detection → scanner → judge pipeline, using an in-memory bar cache for performance.

**Critical architecture principle**: Both the live agent and replay system import core trading logic from `src/core/`. The same `Config` object fed to either system produces identical signal detection, strike selection, position exit, and risk evaluation. Test in replay → deploy to live with confidence.

**Signal source**: Both systems use `detectSignals()` from `src/core/signal-detector.ts`, which detects HMA crosses on **option contract bars** (not the SPX underlying). The SPX underlying is used only as a direction gate (`requireUnderlyingHmaCross`) and for `scannerReverse` exit monitoring.

## Commands

```bash
# Data Service
npm run dev              # Start data service (tsx src/index.ts) on port 3600

# Trading Agents
npm run agent            # SPX trading agent (polling-based, paper mode)
npm run agent:live       # SPX agent with real orders (AGENT_PAPER=false)

# Event-Driven Handler (WORKING — replaces polling agent)
# Single config:
AGENT_CONFIG_ID="your-config-id" AGENT_PAPER=true npx tsx event_handler_mvp.ts
# Multiple configs in one process:
AGENT_CONFIG_IDS="config1,config2,config3" AGENT_PAPER=true npx tsx event_handler_mvp.ts

# Query Positions
npx tsx scripts/show-basket-positions.ts  # Show all positions by basket member

# Query Positions
npx tsx scripts/show-basket-positions.ts  # Show all positions by basket member

# Replay & Testing
npm run replay           # Single-day replay (tsx src/replay/cli.ts run)
npm run backtest         # Multi-day replay, no AI
npm run viewer           # Replay viewer web UI (tsx src/server/replay-server.ts)

# Development
npm run build            # TypeScript compile to dist/
npm run test             # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
```

## Architecture

### Shared Core (`src/core/`) — Single Source of Truth

Both the live agent and replay system import all deterministic trading logic from `src/core/`. **Never duplicate this logic.**

```
src/core/
├── types.ts              — Direction, Signal, Position, ExitCheck, CoreBar, PriceGetter
├── signal-detector.ts    — Config-driven: RSI crosses, HMA crosses, EMA crosses, price crosses
├── position-manager.ts   — Pure checkExit(): SL, TP, signal reversal, time exit
├── position-sizer.ts     — computeQty() from Config.sizing
├── risk-guard.ts         — Pure isRiskBlocked(): positions, trades/day, daily loss, cooldown
├── regime-gate.ts        — isRegimeBlocked() per regime SignalGate
├── strike-selector.ts    — selectStrike() OTM contract selection from Config.strikeSelector
├── indicator-engine.ts   — HMA, RSI, Bollinger, EMA, ATR, VWAP (incremental)
├── friction.ts           — Always-on baseline cost: half-spread + commission per side
├── fill-model.ts         — Order-type slippage on top of friction (SL book-walk, entry book-walk)
└── index.ts              — Barrel re-exports
```

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

### Data Service Pipeline (`src/index.ts` entry point)

```
Providers (fetch raw data)     Pipeline (process)           Storage + Serving
─────────────────────────     ──────────────────           ─────────────────
providers/tradier.ts    ──┐    pipeline/bar-builder.ts      storage/db.ts (SQLite WAL)
providers/yahoo.ts      ──┼──► pipeline/indicator-engine.ts storage/queries.ts
providers/tv-screener.ts──┘    pipeline/aggregator.ts       storage/archiver.ts (parquet → GDrive)
                               pipeline/spx/contract-tracker.ts  server/http.ts (REST API)
                               pipeline/spx/scheduler.ts         server/ws.ts (WebSocket broadcast)
```

Note: `src/pipeline/indicator-engine.ts` is a re-export shim — actual indicator logic lives in `src/core/indicator-engine.ts`. Tier-specific indicator computations are in `src/pipeline/indicators/tier1.ts` and `tier2.ts`.

**Time-based data flow**: No overnight data collection (Yahoo ES removed). Tradier SPX timesales start at 8:00 AM ET (RTH mode); SPX underlying indicators warm up pre-market from this poll. The option stream uses a **single-phase wake at 09:22 ET** — 8 minutes before market open. Pre-market SPX from Tradier is firm enough by 09:22 to pick the ideal ±100 strike band; one subscribe event (~200 contracts to Theta WS + Tradier WS) settles well before 9:30 so OPRA prints flow instantly at open. No re-lock phase, no subscribe-storm at market open. Controlled by `OPTION_STREAM_WAKE_ET` in `src/config.ts`. Market holidays and early-close days are hardcoded in `src/config.ts`. (The fill-model Phases 1–4 in `docs/FILL-MODEL.md` and bracket-rollout Phases in `docs/BRACKET-PLAN.md` are a different namespace — unrelated to the option-stream schedule.)

**Live data provider architecture**:
- **Options WS** — ThetaData is primary (`src/providers/thetadata-stream.ts`, `ws://127.0.0.1:25520/v1/events`), Tradier is cold standby (`src/pipeline/spx/option-stream.ts`). `thetaIsPrimary()` in `src/index.ts` returns `thetaStream.isConnected()` — pure connection-state switch, no hysteresis window. On ATM 0DTE, Theta fires OPRA trades continuously; if Theta's WS drops, Tradier takes over instantly. Both streams feed the same `PriceLine`; Tradier's onTick returns early whenever Theta is connected, so there's no double-count.
- **SPX underlying** — Tradier HTTP streaming PriceStream (`src/agent/price-stream.ts`) for full 1m OHLCV candle building.
- **Order execution** — Tradier is the only path. Account 6YA51425 (margin).
- **Historical backfill** — SPX from Polygon (`I:SPX` index aggregates), options from ThetaData REST (`fetchOptionTimesales`). The `replay_bars.source` column tracks origin (`'polygon'` | `'thetadata'` | `'live'` | `'aggregated'`). Replay engine reads all sources without filter — source merging is transparent. Polygon subscription is retained for SPX historical only.

**Contract lifecycle**: Contracts follow `UNSEEN → ACTIVE → STICKY → EXPIRED`. Once a contract enters the ±$100 strike band around SPX, it's tracked until expiry — never dropped early. This is the "sticky band model" in `contract-tracker.ts`.

**Indicator engine**: Incremental computation (not recomputed from scratch). Tier 1 (all instruments): HMA 5/19/25, EMA 9/21, RSI 14, Bollinger Bands, ATR 14, VWAP. Tier 2 (underlying only): EMA 50/200, SMA 20/50, Stochastic, CCI, Momentum, MACD, ADX. State is maintained per-symbol in memory via `IndicatorState`.

**Bar interpolation**: Options go minutes without trades. Gaps 2-60 min get linear interpolation (`synthetic: true, gapType: 'interpolated'`). Gaps >60 min get flat fill (`gapType: 'stale'`). Indicators are computed on synthetic bars for continuity.

**Live candle validation (PriceLine)**: For live 0DTE option bars, SPXer uses `PriceLine` (`src/pipeline/price-line.ts`) — a minimal price tracker that records only the last price per minute per symbol, then validates against REST quote mids before storing. This is simpler than full candle building and more resistant to stale/replay ticks from ThetaData reconnects. The validation flow at each minute boundary:
1. Tick stream (Theta or Tradier WS) feeds `PriceLine.processTick()` / `PriceLine.processQuote()`
2. `PriceLine.snapshotAndFlush()` collects forming price points from past minutes
3. Fetches `fetchBatchQuotes()` for active band contracts, sorted by ATM proximity (nearest strikes first for minimal validation lag)
4. For each symbol: if `|streamClose - restMid| / streamClose > 5%`, override close with REST mid
5. Bars are then built via `rawToBar()` and stored — H/L are carried forward from prior bars for context

**Status monitoring**: The data service runs a 5-minute status loop (see `src/index.ts`) that logs system health: uptime, provider status, SPX data freshness, tracked contract counts, and option stream connectivity. A standalone `scripts/status-monitor.sh` provides comprehensive monitoring (PM2, data service, broker positions, signals, errors, resources).

**Why PriceLine instead of candles**: SPX candles use full OHLCV (high-liquidity underlying). 0DTE options have sparse prints — H/L from quote-only bars are noise. PriceLine captures close-only which is all HMA needs. Full replay bars still come from historical parquet/SQLite with complete OHLCV data.

### Trading Agent (`spx_agent.ts`)

The live agent is **pure deterministic** — no LLM scanners or judges in the loop. The signal flow is:

1. **Entry trigger**: `detectSignals()` detects an HMA(fast)×HMA(slow) cross on **option contract bars** at `signalTimeframe`. A bullish cross on a call contract → buy that call. A bullish cross on a put contract → buy that put.
2. **Direction gate** (optional): If `requireUnderlyingHmaCross` is set, the SPX underlying HMA direction must agree with the contract side (SPX bullish → calls only, SPX bearish → puts only).
3. **Execution**: Strike selection → OTOCO bracket order (TP + SL at broker).
4. **Exit**: SPX underlying HMA cross on `exitTimeframe` reverses → `scannerReverse` → cancel OCO legs → market sell → immediately flip to opposite side.

**Basket agents (NOT WORKING)**: An experimental architecture using 6 specialized agents (runner-itm5/atm/otm5, scalp-itm5/atm/otm5) sharing account 6YA51425 via order tags was attempted. **Tradier's API does not persist the `tag` field**, breaking position separation. Basket agents are currently stopped. Use single-agent mode only.

The agent shares `src/core/` logic with the replay system. This is identical to how `src/replay/machine.ts` operates.

```
spx_agent.ts (main loop — margin account 6YA51425)
├── Uses detectSignals() from src/core/signal-detector.ts — SAME function replay uses

```
spx_agent.ts (main loop — margin account 6YA51425)
├── Uses detectSignals() from src/core/signal-detector.ts — SAME function replay uses
├── Config loaded from DB by AGENT_CONFIG_ID — same config tested in replay
├── Execution routing hardcoded: SPX/SPXW/account 6YA51425
├── agent/market-feed.ts          — fetches full snapshot from data service
├── agent/trade-executor.ts       — Tradier order execution (paper or live, OTOCO brackets)
├── agent/position-manager.ts     — broker interaction layer (reconcile, cancel OCO)
├── agent/risk-guard.ts           — RiskGuard class: daily loss state wrapper
├── agent/account-balance.ts      — Fetches buying power from Tradier (cached 5 min)
├── agent/price-stream.ts         — HTTP streaming for live tick prices
├── agent/audit-log.ts            — JSON audit trail of all decisions
└── agent/reporter.ts             — status file + activity log for monitoring
```

**Config**: Loaded from DB by `AGENT_CONFIG_ID` env var (same config tested in replay). Execution routing hardcoded in agent.

#### Modules still in codebase (used by replay, NOT by live agents)

```
agent/regime-classifier.ts    — classifies market regime (disabled in live config)
agent/market-narrative.ts     — per-scanner rolling narrative (disabled in live config)
agent/pre-session-agent.ts    — overnight + pre-market analysis
agent/judgment-engine.ts      — two-tier: LLM scanners → optional judge escalation
agent/model-clients.ts        — direct HTTP calls to all LLM providers
agent/price-action.ts         — price action triggers (session break, range expansion)
agent/types.ts                — agent-specific type definitions
```

### Replay System (`src/replay/`)

```
src/replay/
├── machine.ts        — Core replay engine: in-memory bar cache, imports all logic from src/core/
├── cli.ts            — Unified CLI: run, backtest, results, days, configs subcommands
├── config.ts         — Re-exports from src/config/defaults.ts
├── types.ts          — Re-exports Config as ReplayConfig
├── store.ts          — SQLite store for replay runs and results (data/spxer.db)
├── prompt-library.ts — 18 scanner prompts: 2 original + 8 session-specific + 5 regime + 3 calendar
├── metrics.ts        — ET time helpers, symbol filters, composite score computation
├── cli-config.ts     — CLI flag parsing for config overrides
├── framework.ts      — Cycle snapshot builder for agent injection
└── index.ts          — Barrel exports
```

**Performance-critical**: `machine.ts` uses an in-memory bar cache — loads all bars for a date once from SQLite, then iterates with binary search. Mar 20 (159K bars, 648 contracts) replays in ~5 seconds. NEVER go back to SQL-per-tick (caused OOM at 3+ GB per process with 8 parallel sessions).

**Edge framework paper** (`docs/edge-framework-paper.html`): A self-contained HTML paper with live data fetched from `/replay/api/sweep` endpoints. Charts (equity curves, quarterly walk-forward, monthly edge) pull from `/replay/api/sweep/:configId/daily` for configs with 267 days of data. Served at `GET /replay/paper`. The three chart render functions (`renderEquityCurve`, `renderQuarterChart`, `renderMonthlyChart`) call their respective API endpoints at page load; ensure the `renderHardcodedCharts()` flow is consistent with the chart canvas IDs.

**Storage architecture**: Two tiers — **parquet** for historical bar data, **SQLite** (`spxer.db`) for everything else.
- **Parquet** (`data/parquet/bars/{profile}/{date}.parquet`): All historical bar data (SPX, NDX, options). 268 dates × ~60K bars each. **Primary data source for replay** — the replay engine reads parquet first, falls back to SQLite `replay_bars` table only if parquet is missing for a date.
- **SQLite** (`data/spxer.db`): Single database for everything. Live pipeline data (`bars`, `contracts`), replay backfill (`replay_bars`), configs (`replay_configs`), results (`replay_runs`, `replay_results`, `replay_jobs`), leaderboard, optimizer results.
- **One DB, one env var**: `DB_PATH` (defaults to `data/spxer.db`). The old `REPLAY_DB_PATH` env var and separate `replay.db` file are gone — fully cleaned up 2026-04-22. `REPLAY_DB_DEFAULT` and `REPLAY_META_DB` in `src/storage/replay-db.ts` both resolve to `spxer.db`.
- **Replay bar loading priority**: (1) binary bar-cache file → (2) parquet → (3) SQLite `replay_bars` table. The live `bars` table is never read by replay.

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

Agent-specific: `AGENT_PAPER` (controls paper/live mode — default `false` in production via `ecosystem.config.js`. Set to `true` for paper mode). `AGENT_CONFIG_ID` selects which config from `replay_configs` table to load.

Third-party model keys: `KIMI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY` (with corresponding `*_BASE_URL`)

Other: `POLYGON_API_KEY` (historical data backfill), `LITELLM_BASE_URL` + `LITELLM_KEY` (LiteLLM proxy), `GDRIVE_REMOTE` (archival), `LOG_LEVEL`

## REST API (port 3600)

### Core Data Endpoints
- `GET /health` — Service status, uptime, mode, SPX price, DB size, provider health, tracked/active contracts, WS clients
- `GET /spx/snapshot` — Latest SPX (or ES overnight) bar with all indicators
- `GET /spx/bars?tf=1m&n=100` — SPX bar history (max 2000 bars)
- `GET /contracts/active` — All ACTIVE + STICKY contracts
- `GET /contracts/:symbol/bars?tf=1m&n=100` — Contract bar history
- `GET /contracts/:symbol/latest` — Latest 1m bar for a specific contract
- `GET /chain?expiry=YYYY-MM-DD` — Full options chain for an expiry
- `GET /chain/expirations` — Available tracked expiry dates
- `GET /underlying/context` — Market context snapshot (ES, NQ, VX, sectors via TradingView screener)

### Signal Endpoints
- `GET /signal/latest` — Last HMA cross signal (or `{ signal: null }` if none yet)

### Agent Endpoints (consumed by dashboard)
- `GET /agent/status` — Current agent status (from status file)
- `GET /agent/activity?n=50` — Recent agent activity log entries (max 200)

### Replay Viewer (mounted at `/replay`)
- `GET /replay` — Replay viewer HTML UI
- `GET /replay/api/dates` — Available replay dates
- `GET /replay/api/configs` — All saved configs
- `GET /replay/api/config/:id` — Single config details
- `GET /replay/api/defaults` — Default config values
- `GET /replay/api/results?configId=X&date=Y` — Replay results
- `GET /replay/api/bars?date=X&symbol=Y&tf=1m` — Historical bars for replay
- `GET /replay/api/contracts?date=X` — Contracts for a replay date
- `POST /replay/api/run` — Trigger a single-day replay
- `POST /replay/api/run-batch` — Trigger multi-day batch replay (background job)
- `GET /replay/api/job/:jobId` — Check batch job status
- `GET /replay/api/jobs` — List all batch jobs
- `GET /replay/api/sweep?configId=X` — Parameter sweep results
- `GET /replay/api/config/:configId/analysis?dates=X` — Per-config trade analysis
- `GET /replay/api/sweep/:configId/daily` — Daily P&L breakdown for sweep
- `GET /replay/api/live/*` — Proxy to live data service
- `GET /replay/sweep` — Sweep viewer HTML UI
- `GET /replay/paper` — Edge framework paper (live data from `/replay/api/sweep/:configId/daily`)

## WebSocket (port 3600, path `/ws`)

Real-time streaming of bars, signals, and market context. Connect to `ws://host:3600/ws`.

### Subscribe/Unsubscribe
```json
{ "action": "subscribe", "channel": "spx" }
{ "action": "subscribe", "channel": "signals" }
{ "action": "subscribe", "channel": "contract", "symbol": "SPXW260401C06600000" }
{ "action": "subscribe", "channel": "chain", "expiry": "2026-04-01" }
{ "action": "unsubscribe", "channel": "spx" }
```

### Message Types

| Type | Channel | Description |
|------|---------|-------------|
| `spx_bar` | `spx` | New 1m SPX/ES bar with all indicators. Fires each poll cycle (~10s). |
| `hma_cross_signal` | `signals`, `spx` | **HMA(fast)×HMA(slow) crossover on SPX underlying detected on candle close.** Informational — used by dashboards and monitors. The live agents do NOT use this WebSocket event for trade entries; they poll option contract bars directly and use `detectSignals()`. Fields: `direction`, `ts`, `price`, `hmaFast`, `hmaSlow`. |
| `contract_bar` | `contract:{symbol}` | New 1m bar for a tracked options contract. |
| `chain_update` | `chain:{expiry}` | Options chain refresh for an expiry date. |
| `market_context` | (all) | ES, NQ, VX, sector snapshot from TradingView screener. |
| `heartbeat` | (all) | Keepalive every 30s. |
| `service_shutdown` | (all) | Data service shutting down. |

### Signal-Driven Architecture

The `hma_cross_signal` WebSocket event fires from the data pipeline when `detectHmaCrossSignal()` sees HMA(fast)×HMA(slow) cross on the **SPX underlying** on a newly closed candle. This is consumed by dashboards and monitors.

**Live agents do not use this WebSocket event for trade decisions.** They poll the data service each cycle, fetch option contract bars at `signalTimeframe` via the REST API, and call `detectSignals()` directly — the same function the replay system uses. The entry trigger is an HMA cross on the **option contract's own price series**, not the SPX underlying.

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

## Design Decisions

- **ES and SPX are separate bar series** — no price stitching. Consumers request SPX; SPXer routes to the correct source by time of day.
- **Higher timeframes (5m/15m/1h) are aggregated from 1m bars**, never fetched independently.
- **Tradier batch quotes** — all options quotes use the batch endpoint (max 50 symbols/call), never one call per contract.
- **Contract symbol format** — Tradier canonical: `SPXW260318C05000000` (SPXW + YYMMDD + C/P + 8-digit zero-padded strike × 1000).
- **Archival** — Expired contracts exported to parquet via DuckDB, uploaded to Google Drive via rclone. Hot DB target < 500MB.
- **OTM only** — Strike selector targets $0.20-$8.00 OTM contracts. We don't buy ITM. On emergency signals, prefer ~$1.00 strikes for maximum gamma exposure.
- **Core modules are the single source of truth** — `src/core/` contains all deterministic trading logic (signal detection, exit conditions, risk checks, strike selection). The live agent wraps core functions with stateful classes for price fetching and daily loss tracking. The replay system calls core functions directly. Never duplicate trading logic in `src/agent/`.
- **Anticipation over reaction** — Scanners build narrative state across the session. When they escalate, it's "here's how we got here and what I'm watching" — not "I see something now."
- **Price action first, RSI second** — The system triggers on session high/low breaks, candle range spikes, and V-reversals. RSI is a confirmation filter, not the primary trigger.
- **Scanner prompts are neutral** — Raw OHLC bars + RSI value + contract chain. No guidance on what RSI means.
- **LLMs advise, code executes** — Scanners/judges classify regime (advisory). Strike selection and trade execution are deterministic — no LLM in the hot path.
- **All ET timezone handling goes through `src/utils/et-time.ts`** — The server runs in UTC. Never use the `new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))` round-trip pattern — it silently interprets the ET-formatted string as UTC, causing times to be 4–5 hours off. Use the shared helpers: `getETOffsetMs()`, `todayET()`, `nowET()`, `etTimeToUnixTs()`. These use `Intl.DateTimeFormat` internally and handle EST/EDT automatically.
- **Bracket orders (OTOCO) for server-side TP/SL** — Live orders use Tradier OTOCO: entry triggers an OCO pair (TP limit + SL stop). If the agent crashes, Tradier enforces exits. On early exit (scannerReverse), the agent cancels OCO legs before selling. Paper mode uses software-only monitoring. On startup, agents reconcile open positions from the broker via `positions.reconcileFromBroker()` — adopting orphaned positions and submitting missing OCO protection.
- **Dynamic position sizing** — 15% of account buying power per trade (fetched from Tradier via `src/agent/account-balance.ts`, cached 5 minutes). Refreshed daily. Falls back to `baseDollarsPerTrade` config value if API fetch fails.
- **Smart order types** — Market order if bid-ask spread ≤ $0.75 (configurable via `maxSpreadForMarket`). Limit order at ask price if spread is wider. Exits always use market orders (speed > price on exit). Logic in `src/agent/trade-executor.ts`.
- **Broker is the sole source of truth for P&L** — The live agent must NEVER compute P&L internally from its own fill records. On 2026-04-20 the agent reported -$12,593 daily P&L while the broker showed +$8,916 — a $21.5K error caused by: (a) using ask-at-signal-time as entry price instead of actual fill price, (b) only syncing broker P&L at session start then drifting all day on agent math, (c) bracket TP/SL fills at broker not getting P&L recorded (position just vanishes). The fix: `src/agent/broker-pnl.ts` polls Tradier's `/accounts/{id}/orders` endpoint (same-day accuracy with broker avg_fill_price), falling back to `/accounts/{id}/gainloss` for T+1 settled values. The agent's `dailyPnl` variable and the risk guard's max-daily-loss check must source from these endpoints, not from `(fillPrice - entryPrice) * qty * 100` calculations. **If you see agent code computing P&L from fill prices, that is a bug. Delete it and use the broker API.**
- **Position reconciliation on startup** — Agents query Tradier for open positions on boot and adopt orphaned ones, submitting missing OCO protection. Survives PM2 restarts and crashes without leaving unmanaged positions.
- **Execution routing is agent-owned, not config-owned** — The `Config` defines trading strategy (signals, exits, risk). The agent defines where orders go. The SPX agent hardcodes `{ symbol: 'SPX', optionPrefix: 'SPXW', strikeDivisor: 1, strikeInterval: 5, accountId: '6YA51425' }`. Test in replay → set CONFIG_ID → deploy.
- **Trade friction model** — Always-on $0.05 half-spread + $0.35 commission per side (`src/core/friction.ts`). Applied to all P&L calculations (backtest and live). `frictionEntry()` adds half-spread to buy price, typed exits (`frictionTpExit` / `frictionSlExit` / `frictionMarketExit`) apply the right exit cost per order type (TP limits pay no half-spread — you provide liquidity), `computeRealisticPnl()` wraps entry + exit + commission via an `exitKind` parameter.
- **Fill model (Phases 1-4)** — Execution realism on top of friction. See [`docs/FILL-MODEL.md`](docs/FILL-MODEL.md) for the full spec. Phase 1: TP/SL fill clamped to the exact level (not bar close) when `config.exit.exitPricing === 'intrabar'` — both-breached tie resolved by `config.position.intrabarTieBreaker`. Phase 2: size/spread/EOD-scaled slippage on SL stop-market fills (`slipSellPrice` in `src/core/fill-model.ts`). Phase 3: size-proportional book-walk on market buys (`slipBuyPrice`). Phase 4: participation-rate liquidity gate — caps qty to `floor(bar.volume × config.fill.participationRate)` and skips the trade entirely if the capped qty falls below `config.fill.minContracts`. All knobs live under `config.fill` and default to realistic-but-conservative values (see `src/config/defaults.ts:204`). Setting slippage knobs to 0 and omitting `participationRate` reproduces pre-phase behavior. This replaces the pre-2026-04 phantom-sizing regime where configs could "trade" thousands of contracts into 30-contract bars and TPs got credited from bar-close prices past the limit.

## Event-Driven Handler (WORKING — replaces polling agent)

**Status**: ✅ PROVEN — `event_handler_mvp.ts` successfully executed live paper trades on 2026-04-22. Complete E2E pipeline validated.

### Before: Polling Architecture (`spx_agent.ts` — 1585 lines)

```
every 10 seconds:
  fetch contract bars → detectSignals() → filter → enter
  check exits → close if TP/SL/reversal
```

**Problems**:
- Polling hallucinations — agent checks so frequently it catches transient states
- Noisy warnings, repeated status messages
- API load from continuous polling
- 10-30 second latency on signal detection

### After: Event-Driven Architecture (`event_handler_mvp.ts` — 350 lines, 78% reduction)

```
Data Service (src/index.ts):
  - Detects HMA crosses on ALL contract bars
  - Emits WebSocket events: `contract_signal:{hma_fast}_{hma_slow}`
  - No filtering — agents decide what they want

Event Handler (event_handler_mvp.ts):
  - Subscribes to WebSocket channels for HMA pairs used by configs
  - Loads N configs (single or multiple via AGENT_CONFIG_ID/IDS)
  - Each config filters signals independently:
    • HMA pair match (hmaFast/hmaSlow)
    • Direction match (call/put vs bullish/bearish)
    • Risk gates (positions, daily loss, cooldown, time window, close cutoff)
    • Health gate (data freshness)
    • Max positions gate
  - Executes entry via openPosition() when signal matches
  - Tracks basket member per position (for basket configs)
  - Polls exits every 10s (TP/SL) and P&L every 60s
```

**Benefits**:
- No hallucinations — only act on real state changes
- Multi-config support — one process runs N strategies
- ~1 second latency vs 10-30 second polling
- Simpler state management — per-config Map<configId, ConfigState>
- Clean separation — data service detects, handler executes

### Per-Config State Tracking

Each config maintains independent state:

```typescript
interface ConfigState {
  config: Config;
  positions: Map<string, OpenPosition>;
  lastEntryTs: number;
  dailyPnl: number;
  tradesCompleted: number;
  sessionSignalCount: number;
  basketMembers: Map<string, string>;  // positionId → basketMemberId
}
```

**Basket member tracking**: For basket configs (e.g., "spx-hma3x12-itm5-basket-3strike"), each position is tagged with which basket member (strike) it belongs to: `strike-7090`, `strike-7095`, `strike-7100`, etc. Non-basket configs use `"default"`.

### Order ID Tracking

Both internal and Tradier order IDs are tracked:

- **Internal**: `position.id` (UUID from `randomUUID()`)
- **Tradier IDs**: `tradierOrderId`, `bracketOrderId`, `tpLegId`, `slLegId`

This enables reconciliation and debugging via `scripts/show-basket-positions.ts`.

### WebSocket Channel Subscription

Event handler subscribes only to HMA pair channels used by loaded configs:

```
contract_signal:hma_3_12
contract_signal:hma_5_19
...
```

Message format:
```json
{
  "type": "contract_signal",
  "channel": "hma_3_12",
  "data": {
    "symbol": "SPXW260423P07090000",
    "strike": 7090,
    "expiry": "2026-04-23",
    "side": "put",
    "direction": "bearish",
    "price": 13.50,
    "hmaFastPeriod": 3,
    "hmaSlowPeriod": 12,
    "ts": 1713813600000
  }
}
```

### Implementation Status

| Component | Status |
|-----------|--------|
| Data service `contract_signal` emission | ✅ DONE |
| Event handler MVP | ✅ DONE (`event_handler_mvp.ts`) |
| Multi-config support | ✅ DONE |
| Per-config position tracking | ✅ DONE |
| Basket member tracking | ✅ DONE |
| Risk gates (all) | ✅ DONE |
| Exit polling (TP/SL) | ⏳ TODO — implement price fetch + evaluateExit() |
| Strike filtering | ⏳ TODO — implement selectStrike() with candidates |
| ecosystem.config.js | ⏳ TODO — add event handler process |

**See `EVENT_HANDLER_E2E_SUCCESS.md`** for complete validation report with live trade execution proof.

### Comparison: Polling vs Event-Driven

| Feature | Polling (`spx_agent.ts`) | Event-Driven (`event_handler_mvp.ts`) |
|---------|------------------------|--------------------------------------|
| Latency | 10-30 seconds | ~1 second |
| Code size | 1585 lines | 350 lines (-78%) |
| Signals | Polls contract bars | Reacts to WebSocket events |
| Multi-config | One process per config | N configs in one process |
| Hallucinations | Yes (transient states) | No (real state changes only) |
| Signal detection | `detectSignals()` per poll | `detectSignals()` once in data service |
| Entry logic | `evaluateEntry()` | `evaluateEntry()` (same) |
| Exit logic | `evaluateExit()` | `evaluateExit()` (same) |
| Risk gates | `isRiskBlocked()` | `isRiskBlocked()` (same) |

**Key Point**: The same config produces identical signal detection and trade logic in both architectures. Test in replay → deploy to event handler with confidence.

## Scanning & Judgment Agents

> **Note**: The live trading agent (`spx_agent.ts`) does **NOT** use scanners or judges — it is deterministic execution with `scanners.enabled: false` and `judges.enabled: false`. The scanner/judge infrastructure below is used by the replay system, live-monitor, and autoresearch.

### Scanners (Tier 1) — "What do you see?"
Fast, cheap models called every 15-60s with raw market data.

| Model | Provider | Speed | API |
|-------|----------|-------|-----|
| **Kimi K2.5** | Moonshot | ~2.6s | api.kimi.com/coding/ |
| **ZAI GLM-5** | Zhipu AI | ~3-5s | api.z.ai/api/anthropic |
| **MiniMax M2.7** | MiniMax | ~40-47s | api.minimax.io/anthropic |

### Judges (Tier 2) — "Should we trade?"
Claude models that review scanner output + full market context. `AGENT_ACTIVE_JUDGE` env var selects which judge's decision is executed (default: sonnet).

| Model | Speed | Notes |
|-------|-------|-------|
| **Claude Haiku** | Fast | Quick tiebreaker, momentum reader |
| **Claude Sonnet** | Medium | Structured, decisive (default judge) |
| **Claude Opus** | Slow | Deep reasoning, sometimes overly cautious |

### Model Call Strategy: Direct HTTP Only

**All LLM calls use direct HTTP via `fetch` + `AbortController`, NOT the Agent SDK's `query()` iterator.** The SDK iterator does not support cancellation — timeouts leave iterators running in the background, causing OOM in batch workloads.

All calls route through `askModel()` in `src/agent/model-clients.ts` with `forceDirect=true`. All providers use the Anthropic Messages API format (`/v1/messages`).

## PM2 Processes

All processes managed via `ecosystem.config.js`. Start with `pm2 start ecosystem.config.js`.

| Name | Purpose |
|------|---------|
| spxer | Data pipeline — collects SPX/ES/options bars, serves REST + WebSocket (port 3600) |
| event-handler | Event-driven trading agent — supports basket configs (single process, multi-strike) |
| metrics-collector | Ops metrics collection (Prometheus pushgateway) |
| replay-viewer | Replay viewer web UI (port 3601) |
| daily-journal | Cron job — generates trading journal at 4:15 PM ET |

### Basket Configs in the Event Handler

**STATUS**: ✅ **WORKING** — Basket configs are supported natively by the event handler. No account-lock needed — one process handles multiple strike offsets internally.

**Architecture**:
- Basket configs (e.g., `spx-hma3x12-itm5-basket-3strike-tp125x-sl25-3m-15c-$10000`) define multiple strike members (ITM5, ATM, OTM5)
- The event handler loads the basket config and tracks which member each position belongs to via `basketMembers: Map<positionId, basketMemberId>`
- When a signal fires, all basket members are evaluated independently
- Each member enters its own position based on its strike offset
- Positions are tracked separately but managed in one process

**Position sizing**:
- If config has `$10000` base sizing and 3 members, total exposure = $30K per signal
- For a $50K account, that's 60% of buying power (aggressive but manageable)
- For an $80K account, that's 37.5% (safer)

**Running basket configs**:
```bash
# Paper mode
AGENT_CONFIG_ID="spx-hma3x12-itm5-basket-3strike-tp125x-sl25-3m-15c-$10000" AGENT_PAPER=true npm run handler

# Live mode
AGENT_CONFIG_ID="spx-hma3x12-itm5-basket-3strike-tp125x-sl25-3m-15c-$10000" AGENT_PAPER=false npm run handler
```

**Why this works better than multiple agents**:
- No account-lock needed (single process)
- No Tradier tag field dependency
- Position separation via internal tracking, not broker tags
- Simpler deployment (one PM2 process instead of 3 or 6)

## Replay Library

`replay-library/` contains per-day markdown replay logs and SCORECARD.md. 22 trading days backfilled (Feb 20 → Mar 20, 2026) from Polygon.

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

## For AI Agents Working In This Codebase

### Where to Start

1. **Start in `/src`** — All application logic lives in `src/`. Root scripts are entry points and utilities.
2. **Understand the data pipeline** — Read `src/index.ts`, then `src/pipeline/` and `src/providers/`.
3. **Understand core trading logic** — Read `src/core/` — this is the single source of truth for signals, exits, risk, and strike selection.
4. **Follow the types** — All types defined in `src/types.ts`, `src/core/types.ts`, and `src/config/types.ts`. Don't create ad-hoc types.
5. **Check this file first** — Design decisions and known patterns documented above. Read before major changes.

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

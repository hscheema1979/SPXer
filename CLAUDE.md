# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SPXer

SPXer is three systems sharing a unified core:

1. **Data Service** (`npm run dev`) — An always-on 24/5 market data pipeline that polls SPX/ES futures, tracks ~250-480 SPXW 0DTE options contracts via a sticky band model, builds 1m OHLCV bars with a full indicator battery, and serves enriched data over REST + WebSocket on port 3600.

2. **Trading Agents** — Deterministic execution driven by option contract HMA crosses, live by default (`AGENT_PAPER=false`). Two agents run in parallel:
   - **SPX Agent** (`npm run agent`) — 0DTE SPX options on margin account (6YA51425). $15 OTM, up to 10 contracts, 15% of buying power.
   - **XSP Agent** (`npm run agent:xsp`) — 1DTE XSP (Mini-SPX, 1/10th size) options on cash account (6YA58635, ~$1,200). 1 contract, trades all day.

3. **Replay System** (`npm run replay`) — A config-driven backtesting engine that replays historical days through the same signal detection → scanner → judge pipeline, using an in-memory bar cache for performance.

**Critical architecture principle**: Both the live agent and replay system import core trading logic from `src/core/`. The same `Config` object fed to either system produces identical signal detection, strike selection, position exit, and risk evaluation. Test in replay → deploy to live with confidence.

**Signal source**: Both systems use `detectSignals()` from `src/core/signal-detector.ts`, which detects HMA crosses on **option contract bars** (not the SPX underlying). The SPX underlying is used only as a direction gate (`requireUnderlyingHmaCross`) and for `scannerReverse` exit monitoring.

## Commands

```bash
npm run dev              # Start data service (tsx src/index.ts)
npm run agent            # Start SPX trading agent (paper mode)
npm run agent:live       # Start SPX agent with real orders (AGENT_PAPER=false)
npm run agent:xsp        # Start XSP trading agent (paper mode)
npm run agent:xsp:live   # Start XSP agent with real orders (AGENT_PAPER=false)
npm run build            # TypeScript compile to dist/
npm run test             # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
npm run monitor          # Live parallel AI scanner monitor (tsx scripts/monitor/live-monitor.ts)
npm run replay           # Single-day replay (tsx src/replay/cli.ts run)
npm run backtest         # Multi-day replay, no AI (tsx src/replay/cli.ts backtest --no-scanners --no-judge)
npm run replay:22day     # 22-day parallel replay (bash wrapper)
npm run viewer           # Replay viewer web UI (tsx src/server/replay-server.ts)
npx vitest run tests/pipeline/bar-builder.test.ts   # Run a single test file

# Replay CLI (unified — "backtest" is just replay with --no-scanners --no-judge)
npx tsx src/replay/cli.ts run 2026-03-20                          # Single day with AI
npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge # Single day, deterministic
npx tsx src/replay/cli.ts backtest --dates=2026-03-18,2026-03-19  # Multi-day batch
npx tsx src/replay/cli.ts results --config=default                # View results
npx tsx src/replay/cli.ts days                                    # List available dates

# Autoresearch (parameter optimization)
npx tsx scripts/autoresearch/verify-metric.ts --no-scanners                    # Run with defaults
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19 --cooldownSec=180 --label=test1
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
├── friction.ts           — Trade friction model: half-spread + commission per side
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
                               pipeline/contract-tracker.ts  server/http.ts (REST API)
                               pipeline/scheduler.ts         server/ws.ts (WebSocket broadcast)
```

Note: `src/pipeline/indicator-engine.ts` is a re-export shim — actual indicator logic lives in `src/core/indicator-engine.ts`. Tier-specific indicator computations are in `src/pipeline/indicators/tier1.ts` and `tier2.ts`.

**Time-based source switching**: `scheduler.ts` auto-switches between Yahoo `ES=F` (overnight 6PM-9:30AM ET) and Tradier SPX timesales (RTH 9:30AM-4:15PM ET). Market holidays and early-close days are hardcoded in `src/config.ts`.

**Contract lifecycle**: Contracts follow `UNSEEN → ACTIVE → STICKY → EXPIRED`. Once a contract enters the ±$100 strike band around SPX, it's tracked until expiry — never dropped early. This is the "sticky band model" in `contract-tracker.ts`.

**Indicator engine**: Incremental computation (not recomputed from scratch). Tier 1 (all instruments): HMA 5/19/25, EMA 9/21, RSI 14, Bollinger Bands, ATR 14, VWAP. Tier 2 (underlying only): EMA 50/200, SMA 20/50, Stochastic, CCI, Momentum, MACD, ADX. State is maintained per-symbol in memory via `IndicatorState`.

**Bar interpolation**: Options go minutes without trades. Gaps 2-60 min get linear interpolation (`synthetic: true, gapType: 'interpolated'`). Gaps >60 min get flat fill (`gapType: 'stale'`). Indicators are computed on synthetic bars for continuity.

### Trading Agents (`agent.ts`, `agent-xsp.ts`)

The live agents are **pure deterministic** — no LLM scanners or judges in the loop. The signal flow is:

1. **Entry trigger**: `detectSignals()` detects an HMA(fast)×HMA(slow) cross on **option contract bars** at `signalTimeframe`. A bullish cross on a call contract → buy that call. A bullish cross on a put contract → buy that put.
2. **Direction gate** (optional): If `requireUnderlyingHmaCross` is set, the SPX underlying HMA direction must agree with the contract side (SPX bullish → calls only, SPX bearish → puts only).
3. **Execution**: Strike selection → OTOCO bracket order (TP + SL at broker).
4. **Exit**: SPX underlying HMA cross on `exitTimeframe` reverses → `scannerReverse` → cancel OCO legs → market sell → immediately flip to opposite side.

Both agents share `src/core/` logic. This is identical to how `src/replay/machine.ts` operates.

#### SPX Agent (`agent.ts`)

```
agent.ts (main loop — margin account 6YA51425)
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

#### XSP Agent (`agent-xsp.ts`)

Same signal pipeline as the SPX agent and replay — option contract HMA crosses drive entry — but executes on XSP (Mini-SPX):
- **XSP options**: 1/10th size of SPX, European/cash-settled
- **1DTE options**: Next-day expiry
- **Strike conversion**: SPX strikes ÷ 10 (SPX 5700 → XSP 570, `strikeDivisor: 10`)
- **Cash account**: 6YA58635 (~$1,200), 1 contract at a time
- **15% of cash buying power** per trade (fetched from Tradier, cached 5 min)
- **Config**: Same config as SPX agent (loaded from DB by ID). Execution routing hardcoded in agent.
- **Signal TF**: Contract bars fetched at `signalTimeframe` directly from the data API — not the pre-aggregated snapshot bars (those copy 1m indicators and are wrong for trading decisions).

#### Account Monitor (`account-monitor.ts`)

Unified LLM-powered oversight agent using the Pi SDK — monitors BOTH accounts, does NOT trade:
- Uses Claude Haiku 4.5 for fast, structured assessments
- Pre-collects all data via `collectPreLLMData()` (no expensive LLM tool round-trips)
- Market-hours-aware scheduling: 30s RTH, 5min pre-market, 2min post-close, 30min overnight, off weekends/holidays
- Alert deduplication: suppresses identical alerts within 5-min windows, emits summaries for persistent conditions
- Session reset every 20 cycles to prevent context window bloat (was causing OOM/restarts)
- 8 tools: `get_positions`, `get_orders`, `get_quotes`, `get_balance`, `get_market_snapshot`, `get_agent_status`, `check_system_health`, `log_observation` (all query both accounts)
- Logs to `logs/account-monitor.log` with severity levels (info/warn/alert)
- Has `read` and `bash` tools for ad-hoc investigation
- Uses `src/monitor/` for all infrastructure (see below)

### Unified Account Monitor (`src/monitor/`)

Shared infrastructure for the XSP monitor agent, extracted for reuse and testability:

```
src/monitor/
├── engine.ts     — Market hours scheduler, alert deduplication, session management
├── tools.ts      — 8 Pi SDK tool definitions (positions, orders, quotes, balance, etc.)
├── prompts.ts    — System prompt and mode-specific prompt builders for the monitor LLM
└── types.ts      — AccountKey, Severity, AccountConfig, ACCOUNTS map (SPX + XSP)
```

The engine determines monitor mode (`pre-market`, `rth`, `post-close`, `overnight`, `closed`) based on ET time and adjusts polling intervals accordingly. Tool definitions query Tradier, the data service, and agent status files. `account-monitor.ts` is the entry point that wires these together with the Pi SDK.

#### Modules still in codebase (used by replay/monitoring, NOT by live agents)

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

**One database**: All replay tables (`replay_runs`, `replay_results`) live in `spxer.db` alongside market data and configs. There is no separate `replay.db`.

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
├── monitor/      — Account monitor tests
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
- **Position reconciliation on startup** — Agents query Tradier for open positions on boot and adopt orphaned ones, submitting missing OCO protection. Survives PM2 restarts and crashes without leaving unmanaged positions.
- **Execution routing is agent-owned, not config-owned** — The `Config` defines trading strategy (signals, exits, risk). The agent defines where orders go. SPX agent hardcodes `{ symbol: 'SPX', optionPrefix: 'SPXW', strikeDivisor: 1, strikeInterval: 5, accountId: '6YA51425' }`. XSP agent hardcodes `{ symbol: 'XSP', optionPrefix: 'XSP', strikeDivisor: 10, strikeInterval: 1, accountId: '6YA58635' }`. Both agents load the same config by ID — no "live variant" configs needed. Test in replay → set CONFIG_ID → deploy.
- **Trade friction model** — Always-on $0.05 half-spread + $0.35 commission per side (`src/core/friction.ts`). Applied to all P&L calculations (backtest and live). `frictionEntry()` adds half-spread to buy price, `frictionExit()` subtracts from sell price, `computeRealisticPnl()` wraps both + commission.

## Scanning & Judgment Agents

> **Note**: Live trading agents (`agent.ts`, `agent-xsp.ts`) do **NOT** use scanners or judges — they are deterministic execution with `scanners.enabled: false` and `judges.enabled: false`. The scanner/judge infrastructure below is used by the replay system, live-monitor, and autoresearch.

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
| spxer-agent | SPX 0DTE trading agent — margin account 6YA51425 (`AGENT_PAPER=false`) |
| spxer-xsp | XSP 1DTE trading agent — cash account 6YA58635 (`AGENT_PAPER=false`) |
| account-monitor | Unified LLM-powered oversight — both accounts (Pi SDK, doesn't trade) |
| replay-viewer | Replay viewer web UI (port 3601) |

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

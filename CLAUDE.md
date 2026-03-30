# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SPXer

SPXer is three systems sharing a unified core:

1. **Data Service** (`npm run dev`) — An always-on 24/5 market data pipeline that polls SPX/ES futures, tracks ~250-480 SPXW 0DTE options contracts via a sticky band model, builds 1m OHLCV bars with a full indicator battery, and serves enriched data over REST + WebSocket on port 3600.

2. **Trading Agent** (`npm run agent`) — A multi-model autonomous trading agent that consumes the data service, runs 3 parallel LLM scanners (Kimi K2.5, GLM-5, MiniMax M2.7) for setup detection, escalates to a Claude judge for trade decisions, and executes via Tradier. Paper mode by default.

3. **Replay System** (`npm run replay`) — A config-driven backtesting engine that replays historical days through the same signal detection → scanner → judge pipeline, using an in-memory bar cache for performance.

**Critical architecture principle**: Both the live agent and replay system import core trading logic from `src/core/`. The same `Config` object fed to either system produces identical signal detection, strike selection, position exit, and risk evaluation. Test in replay → deploy to live with confidence.

## Commands

```bash
npm run dev              # Start data service (tsx src/index.ts)
npm run agent            # Start trading agent in paper mode
npm run agent:live       # Start trading agent with real orders (AGENT_PAPER=false)
npm run build            # TypeScript compile to dist/
npm run test             # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
npm run monitor          # Live parallel AI scanner monitor (6 models x 2 variants)
npm run replay           # Single-day replay (tsx src/replay/cli.ts run)
npm run backtest         # Multi-day replay, no AI (tsx src/replay/cli.ts backtest --no-scanners --no-judge)
npm run replay:22day     # 22-day parallel replay (bash wrapper)
npm run viewer           # Replay viewer web UI (replay-server.ts)
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
└── indicator-engine.ts   — HMA, RSI, Bollinger, EMA, ATR, VWAP (incremental)
```

### Timezone Helpers (`src/utils/et-time.ts`)

All UTC↔ET conversions must use these shared helpers. The server runs in UTC — never construct a `Date` from a locale-formatted ET string.

```
src/utils/
└── et-time.ts
    ├── getETOffsetMs(now?)    — UTC minus ET in ms (14.4M for EDT, 18M for EST)
    ├── todayET(now?)          — today's date in ET as 'YYYY-MM-DD'
    ├── nowET(now?)            — current ET time as { h, m, s }
    └── etTimeToUnixTs(time)   — '16:00' ET today → Unix seconds
```

Used by: `risk-guard.ts`, `position-manager.ts`, `scheduler.ts`, `contract-tracker.ts`. Add new ET-dependent logic here, not inline.

### Unified Config System (`src/config/`)

```
src/config/
├── types.ts          — Canonical type: Config (17 sections), ModelRecord, PromptRecord, ResolvedConfig
├── defaults.ts       — DEFAULT_CONFIG, DEFAULT_MODELS, mergeConfig(), validateConfig()
├── manager.ts        — ConfigManager: CRUD for configs/models/prompts in spxer.db
└── seed.ts           — seedDefaults(): populates models, prompts, default config on first run
```

All subsystems share the same `Config` type. Configs are stored as JSON in the `configs` table of `spxer.db`. `agent-config.ts` (project root) is the live agent's config — transitional, will eventually load from DB.

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

**Time-based source switching**: `scheduler.ts` auto-switches between Yahoo `ES=F` (overnight 6PM-9:30AM ET) and Tradier SPX timesales (RTH 9:30AM-4:15PM ET). Market holidays and early-close days are hardcoded in `config.ts`.

**Contract lifecycle**: Contracts follow `UNSEEN → ACTIVE → STICKY → EXPIRED`. Once a contract enters the ±$100 strike band around SPX, it's tracked until expiry — never dropped early. This is the "sticky band model" in `contract-tracker.ts`.

**Indicator engine**: Incremental computation (not recomputed from scratch). Tier 1 (all instruments): HMA 5/19/25, EMA 9/21, RSI 14, Bollinger Bands, ATR 14, VWAP. Tier 2 (underlying only): EMA 50/200, SMA 20/50, Stochastic, CCI, Momentum, MACD, ADX. State is maintained per-symbol in memory via `IndicatorState`.

**Bar interpolation**: Options go minutes without trades. Gaps 2-60 min get linear interpolation (`synthetic: true, gapType: 'interpolated'`). Gaps >60 min get flat fill (`gapType: 'stale'`). Indicators are computed on synthetic bars for continuity.

### Trading Agent (`agent.ts` entry point)

The agent is a stateful wrapper that uses core modules for all trading decisions:

```
agent.ts (main loop)
├── Uses src/core/ for:          signal detection, strike selection,
│                                 position exit (via PositionManager),
│                                 risk guard (via RiskGuard wrapper)
├── agent/market-feed.ts          — fetches full snapshot from data service
├── agent/regime-classifier.ts    — classifies market regime
├── agent/market-narrative.ts     — per-scanner rolling narrative
├── agent/pre-session-agent.ts    — overnight + pre-market analysis (runs at 9:20 ET)
├── agent/judgment-engine.ts      — two-tier: LLM scanners → optional judge escalation
├── agent/model-clients.ts        — direct HTTP calls to all LLM providers
├── agent/price-action.ts         — price action triggers (session break, range expansion)
├── agent/trade-executor.ts       — Tradier order execution (paper or live)
├── agent/position-manager.ts     — PositionManager class: state + HTTP price fetch,
│                                   delegates exit logic to core.checkExit()
├── agent/risk-guard.ts           — RiskGuard class: daily loss state,
│                                   delegates risk checks to core.isRiskBlocked()
├── agent/audit-log.ts            — JSON audit trail of all decisions
└── agent/reporter.ts             — status file + activity log for monitoring
```

**Regime classifier gates signals**: Each regime (time-of-day + trend detection) defines which signal types are allowed/suppressed via `SignalGate`.

**Two-tier assessment**: Scanners run every 15-60s (cheap/free models). If any scanner flags confidence >= 0.5, the judge is invoked with full context.

**Per-scanner MarketNarrative**: Each scanner maintains its own `MarketNarrative` — builds overnight context, tracks session trajectory, provides escalation briefs. The judge doesn't receive isolated signals; it receives context-rich escalations.

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
└── framework.ts      — Cycle snapshot builder for agent injection
```

**Performance-critical**: `machine.ts` uses an in-memory bar cache — loads all bars for a date once from SQLite, then iterates with binary search. Mar 20 (159K bars, 648 contracts) replays in ~5 seconds. NEVER go back to SQL-per-tick (caused OOM at 3+ GB per process with 8 parallel sessions).

**One database**: All replay tables (`replay_runs`, `replay_results`) live in `spxer.db` alongside market data and configs. There is no separate `replay.db`.

### Autoresearch System (`scripts/autoresearch/`)

Parameter optimization loop: modify config → run replay → measure composite score → keep/discard.

**Composite score**: `(winRate * 40) + (sharpe * 30) + (avgDailyPnl > 0 ? 20 : 0) + (maxLoss > -500 ? 10 : 0)`. Range 0-100.

**verify-metric.ts CLI flags**: `--dates`, `--no-scanners`, `--strikeSearchRange`, `--rsiOversold`, `--rsiOverbought`, `--optionRsiOversold`, `--optionRsiOverbought`, `--stopLossPercent`, `--takeProfitMultiplier`, `--activeStart`, `--activeEnd`, `--cooldownSec`, `--maxDailyLoss`, `--enableHmaCrosses`, `--enableEmaCrosses`, `--label`.

## Key Types (`src/types.ts`)

- `Bar` — OHLCV + `synthetic` flag + `gapType` + `indicators` (flat JSON blob)
- `Contract` — Options contract with `ContractState` lifecycle
- `Timeframe` — `'1m' | '5m' | '15m' | '1h' | '1d'`
- `IndicatorState` — Rolling window state for incremental indicator computation

`src/core/types.ts`: `CoreBar`, `Signal`, `Position`, `ExitCheck`, `TradeResult`, `Direction`, `SignalType`, `ExitReason`, `PriceGetter`

`src/config/types.ts`: `Config` (17 sections), `ModelRecord`, `PromptRecord`, `ResolvedConfig`, `SignalGate`

## Environment Variables

Required in `.env`:
- `TRADIER_TOKEN` — Tradier API token (data + order execution)
- `TRADIER_ACCOUNT_ID` — For live trading
- `ANTHROPIC_API_KEY` — For judge in the trading agent
- `PORT` — Default 3600
- `DB_PATH` — Default `./data/spxer.db`

Agent-specific: `AGENT_PAPER` (controls paper/live mode — all other agent settings come from `agent-config.ts` via unified `Config` type)

Third-party model keys: `KIMI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY` (with corresponding `*_BASE_URL`)

## REST API (port 3600)

- `GET /health` — Service status, uptime, mode, SPX price, DB size
- `GET /spx/snapshot` — Latest SPX bar with all indicators
- `GET /spx/bars?tf=1m&n=100` — SPX bar history
- `GET /contracts/active` — All ACTIVE + STICKY contracts
- `GET /contracts/:symbol/bars?tf=1m&n=100` — Contract bar history
- `GET /chain?expiry=YYYY-MM-DD` — Full options chain for an expiry
- `GET /chain/expirations` — Available tracked expiry dates

## Testing

Tests mirror `src/` structure under `tests/`. Uses Vitest with `globals: true` and `node` environment. Test timeout is 10s. Tests cover: bar builder, aggregator, indicator engine, contract tracker, scheduler, all three providers, storage layer, and HTTP server.

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

## Scanning & Judgment Agents

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

| Name | Purpose |
|------|---------|
| spxer | Data pipeline — collects SPX/ES/options bars (port 3600) |
| live-monitor | Parallel AI scanner monitor (6 models x 2 variants) |
| spx | SPX-0DTE dashboard frontend (port 3502) |

## Replay Library

`replay-library/` contains per-day markdown replay logs and SCORECARD.md. 22 trading days backfilled (Feb 18 → Mar 19, 2026) from Polygon.

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

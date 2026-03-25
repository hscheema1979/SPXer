# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SPXer

SPXer is two things in one repo:

1. **Data Service** (`npm run dev`) — An always-on 24/5 market data pipeline that polls SPX/ES futures, tracks ~250-480 SPXW 0DTE options contracts via a sticky band model, builds 1m OHLCV bars with a full indicator battery, and serves enriched data over REST + WebSocket on port 3600.

2. **Trading Agent** (`npm run agent`) — A multi-model autonomous trading agent that consumes the data service, runs 3 parallel LLM scanners (Kimi K2.5, GLM-5, MiniMax M2.7) for setup detection, escalates to a Claude judge for trade decisions, and executes via Tradier. Paper mode by default.

3. **Replay System** (`src/replay/`) — A config-driven backtesting engine that replays historical days through the same signal detection → scanner → judge pipeline, using an in-memory bar cache for performance.

## Commands

```bash
npm run dev              # Start data service (tsx src/index.ts)
npm run agent            # Start trading agent in paper mode
npm run agent:live       # Start trading agent with real orders (AGENT_PAPER=false)
npm run build            # TypeScript compile to dist/
npm run test             # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
npm run monitor          # Live parallel AI scanner monitor (6 models x 2 variants)
npm run replay           # Full-day replay with AI judge calls
npm run replay:22day     # 22-day parallel replay (bash wrapper)
npm run backtest         # Multi-day deterministic backtester (no AI calls)
npx vitest run tests/pipeline/bar-builder.test.ts   # Run a single test file

# Autoresearch (parameter optimization)
npx tsx scripts/autoresearch/verify-metric.ts --no-scanners                    # Run with defaults
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19 --cooldownSec=180 --label=test1
```

## Architecture

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

```
agent.ts (main loop)
├── agent/market-feed.ts        — fetches full snapshot from data service
├── agent/regime-classifier.ts  — classifies market regime (MORNING_MOMENTUM, MEAN_REVERSION, TRENDING_*, GAMMA_EXPIRY, NO_TRADE)
├── agent/market-narrative.ts   — per-scanner rolling narrative: overnight build, trajectory tracking, escalation briefs
├── agent/pre-session-agent.ts  — overnight + pre-market analysis (runs at 9:20 ET)
├── agent/judgment-engine.ts    — two-tier: 3 LLM scanners → optional judge escalation
├── agent/model-clients.ts      — direct HTTP calls to all LLM providers
├── agent/signal-detector.ts    — deterministic signal detection (RSI breaks, EMA/HMA crosses)
├── agent/price-action.ts       — price action trigger patterns (session break, range expansion, RSI velocity)
├── agent/strike-selector.ts    — deterministic OTM strike selection
├── agent/trade-executor.ts     — Tradier order execution (paper or live)
├── agent/position-manager.ts   — open position monitoring
├── agent/risk-guard.ts        — daily loss limits, position limits, time cutoffs
├── agent/audit-log.ts         — JSON audit trail of all decisions
└── agent/reporter.ts           — status file + activity log for monitoring
```

**Regime classifier gates signals**: Each regime (time-of-day + trend detection) defines which signal types are allowed/suppressed via `SignalGate`. This is the first filter before any trade consideration.

**Two-tier assessment**: Scanners run every 15-60s (cheap/free models). If any scanner flags confidence >= 0.5, the judge is invoked with full context. The active judge is configurable via `AGENT_ACTIVE_JUDGE` env var.

**Per-scanner MarketNarrative**: Each scanner maintains its own `MarketNarrative` instance that builds context throughout the day:
- **Overnight**: Pre-session agent reads ES bars, builds overnight narrative (range, character, VIX, key levels)
- **Pre-market**: Implied open, auction range, regime expectation
- **Intraday**: Each cycle appends events — SPX price, RSI, regime, notable moves
- **Trajectory tracking**: Session SPX high/low, RSI high/low with timestamps, key moves logged
- **Escalation brief**: When escalating, the scanner builds a full narrative brief including trajectory ("RSI traveled from 18→85 in 47 minutes"), overnight context, recent session events, and the scanner's own evolving interpretation

The judge doesn't receive isolated signals — it receives context-rich escalations.

### Unified Config System (`src/config/`)

```
src/config/
├── types.ts          — Canonical type definitions: Config, ModelRecord, PromptRecord, SignalGate, ResolvedConfig
├── defaults.ts       — DEFAULT_CONFIG, DEFAULT_MODELS, mergeConfig(), validateConfig()
├── manager.ts        — ConfigManager class: CRUD for configs, models, prompts; subsystem binding; DB table creation
└── seed.ts           — seedDefaults(): populates models, prompts, default config on first run
```

**Single source of truth**: All subsystems (live agent, replay, autoresearch, monitor) share the same `Config` type. Configs are stored as JSON in the `configs` table of `spxer.db`. Models and prompts have their own tables (`models`, `prompts`). Active config bindings (`active_configs`) map subsystem names to config IDs.

**`agent-config.ts`** (project root): Live agent configuration derived from autoresearch findings. Uses `Config` type. Transitional — will eventually load from DB via `ConfigManager.loadForSubsystem('live-agent')`.

### Replay System (`src/replay/`)

```
src/replay/
├── machine.ts        — Core replay engine: in-memory bar cache, signal → scanner → judge → position mgmt
├── config.ts         — Re-exports from src/config/defaults.ts
├── types.ts          — Re-exports Config as ReplayConfig, plus replay-specific types
├── store.ts          — SQLite store for replay runs and results (data/spxer.db)
├── prompt-library.ts — 18 scanner prompts: 2 original + 8 session-specific + 5 regime + 3 calendar
├── metrics.ts        — ET time helpers, symbol filters, composite score computation
├── cli-config.ts     — CLI flag parsing for config overrides
├── framework.ts      — Cycle snapshot builder for agent injection
└── index.ts          — Re-exports
```

**Performance-critical**: `machine.ts` uses an in-memory bar cache — loads all bars for a date once from SQLite, then iterates with binary search. Mar 20 (159K bars, 648 contracts) replays in ~5 seconds. NEVER go back to SQL-per-tick (caused OOM at 3+ GB per process with 8 parallel sessions).

**One database**: All replay tables (`replay_runs`, `replay_results`) live in `spxer.db` alongside market data and configs. There is no separate `replay.db`.

### Autoresearch System (`scripts/autoresearch/`)

Parameter optimization loop: modify config → run replay → measure composite score → keep/discard.

```
scripts/autoresearch/
├── verify-metric.ts              — Runs replay with config overrides, outputs composite score (0-100)
├── param-search.ts               — Automated parameter sweep
├── config-optimizer.ts           — Config optimization driver
└── sessions/                     — 10 session briefs (each tests one dimension)
    ├── session-01-time-otm.md    — Strike range + time windows
    ├── session-02-rsi.md         — RSI thresholds
    ├── session-03-stoploss.md    — Stop loss %
    ├── session-04-tp-exit.md     — Take profit multiplier
    ├── session-05-option-rsi.md  — Option RSI thresholds
    ├── session-06-cooldown.md    — Judge escalation cooldown
    ├── session-07-hma.md         — HMA cross signals
    ├── session-08-ema.md         — EMA cross signals
    ├── session-09-prompts.md     — Scanner prompt variants (AI calls)
    ├── session-10-calendar.md    — Economic calendar context
    └── runner-hybrid.ts          — Hybrid session runner
```

**Composite score**: `(winRate * 40) + (sharpe * 30) + (avgDailyPnl > 0 ? 20 : 0) + (maxLoss > -500 ? 10 : 0)`. Range 0-100.

**verify-metric.ts CLI flags**: `--dates`, `--no-scanners`, `--strikeSearchRange`, `--rsiOversold`, `--rsiOverbought`, `--optionRsiOversold`, `--optionRsiOverbought`, `--stopLossPercent`, `--takeProfitMultiplier`, `--activeStart`, `--activeEnd`, `--cooldownSec`, `--maxDailyLoss`, `--enableHmaCrosses`, `--enableEmaCrosses`, `--label`.

## Key Types (`src/types.ts`)

- `Bar` — OHLCV + `synthetic` flag + `gapType` + `indicators` (flat JSON blob)
- `Contract` — Options contract with `ContractState` lifecycle
- `Timeframe` — `'1m' | '5m' | '15m' | '1h' | '1d'`
- `IndicatorState` — Rolling window state for incremental indicator computation

`src/replay/types.ts` adds: `ReplayConfig` (full config shape with RSI, signals, position, regime, judge, scanner, sizing, escalation, risk, exit sections), `Trade`, `ReplayResult`, `CycleSnapshot`.

## Environment Variables

Required in `.env`:
- `TRADIER_TOKEN` — Tradier API token (data + order execution)
- `TRADIER_ACCOUNT_ID` — For live trading
- `ANTHROPIC_API_KEY` — For judge in the trading agent
- `PORT` — Default 3600
- `DB_PATH` — Default `./data/spxer.db`

Agent-specific: `AGENT_PAPER`, `AGENT_ACTIVE_JUDGE`, `AGENT_MAX_DAILY_LOSS`, `AGENT_MAX_POSITIONS`, `AGENT_MAX_RISK_PER_TRADE`, `AGENT_CUTOFF_ET`

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
- **Anticipation over reaction** — Scanners build narrative state across the session: session trajectory, overnight context, pre-market setup, notable moves. When they escalate, it's "here's how we got here and what I'm watching" — not "I see something now."
- **Agentic over simple or overly complex** — Simple signal systems (RSI >80 = buy puts) are too reactive. Overly complex indicator systems are fragile. An agentic system sits between: scanners observe, build narrative, detect patterns, and escalate with context.
- **Price action first, RSI second** — The system triggers on session high/low breaks, candle range spikes, and V-reversals. RSI is a confirmation filter, not the primary trigger.
- **Scanner prompts are neutral** — Raw OHLC bars + RSI value + contract chain. No guidance on what RSI means. We test if models are naturally good market readers.
- **LLMs advise, code executes** — Scanners/judges classify regime (advisory). Strike selection and trade execution are deterministic — no LLM in the hot path.

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

**All LLM calls (scanners and judges) use direct HTTP via `fetch` + `AbortController`, NOT the Agent SDK's `query()` iterator.** The SDK iterator does not support cancellation — timeouts leave iterators running in the background, causing OOM in batch workloads.

All calls route through `askModel()` in `src/agent/model-clients.ts` with `forceDirect=true`. All providers use the same Anthropic Messages API format (`/v1/messages`) — only the base URL and API key differ.

| Model | Base URL | API Key |
|-------|----------|---------|
| **Claude** | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| **Kimi K2.5** | `https://api.kimi.com/coding` | `KIMI_API_KEY` |
| **ZAI GLM-5** | `https://api.z.ai/api/anthropic` | `GLM_API_KEY` |
| **MiniMax M2.7** | `https://api.minimax.io/anthropic` | `MINIMAX_API_KEY` |

## Scripts

```
scripts/
├── backtest/                    — Replay and backtesting scripts
│   ├── backtest-multi.ts        — Multi-day deterministic backtester (no AI, fast)
│   ├── backtest-no-regime.ts    — Same without regime filter (A/B comparison)
│   ├── replay-full.ts           — Full-day replay with AI judge calls (slow)
│   ├── replay-machine.ts        — Machine-based replay runner
│   ├── replay-price-action.ts   — Price action focused replay
│   ├── run-replay.ts            — CLI replay runner
│   └── view-results.ts          — View stored replay results
├── backfill/                    — Historical data import
│   ├── backfill-polygon.ts      — Historical option data from Polygon/Massive API
│   ├── backfill-spx.ts          — Historical SPX bars
│   ├── seed-from-dash.ts        — Import from SPX-0DTE dashboard DB
│   ├── compute-indicators.ts    — Recompute indicators on existing bars
│   └── fix-indicators.ts        — Fix indicator data issues
├── monitor/                     — Live monitoring
│   ├── live-monitor.ts          — 6 models x 2 variants parallel monitor
│   └── orchestrator.ts          — Monitor orchestration
├── autoresearch/                — Parameter optimization (see Autoresearch section)
└── analysis/                    — Post-hoc analysis scripts
```

## PM2 Processes

| Name | Purpose |
|------|---------|
| spxer | Data pipeline — collects SPX/ES/options bars (port 3600) |
| live-monitor | Parallel AI scanner monitor (6 models x 2 variants) |
| spx | SPX-0DTE dashboard frontend (port 3502) |

## Known Bugs (Fixed, March 19-20 2026)

1. **Call/Put parsing** — `isCall = sym.includes('C0')` didn't match `C6xxx` format. Every call recommendation was entered as a put. Fixed.
2. **TP below entry** — Judge returned SPX underlying price as option TP. Sanity check added.
3. **DST bug** — Hardcoded UTC-5 offset instead of Intl timezone in position-manager.ts and risk-guard.ts. Fixed.
4. **MiniMax model name** — Was `MiniMax-M1`, corrected to `MiniMax-M2.7`.
5. **Indicator pipeline resets** — RSI/EMA reset 5 times during March 19 session due to data gaps causing re-initialization.
6. **Promise.allSettled contention** — 6 parallel `query()` calls serialize through claude session, exceeding timeouts. Changed to sequential for judges, parallel only for independent API providers.

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

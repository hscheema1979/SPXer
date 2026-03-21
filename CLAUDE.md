# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is SPXer

SPXer is two things in one repo:

1. **Data Service** (`npm run dev`) — An always-on 24/5 market data pipeline that polls SPX/ES futures, tracks ~250-480 SPXW 0DTE options contracts via a sticky band model, builds 1m OHLCV bars with a full indicator battery, and serves enriched data over REST + WebSocket on port 3600.

2. **Trading Agent** (`npm run agent`) — A multi-model autonomous trading agent that consumes the data service, runs 3 parallel LLM scanners (Kimi K2.5, GLM-5, MiniMax M2.7) for setup detection, escalates to a Claude Opus judge for trade decisions, and executes via Tradier. Paper mode by default.

## Commands

```bash
npm run dev              # Start data service (tsx src/index.ts)
npm run agent            # Start trading agent in paper mode
npm run agent:live       # Start trading agent with real orders (AGENT_PAPER=false)
npm run build            # TypeScript compile to dist/
npm run test             # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
npx vitest run tests/pipeline/bar-builder.test.ts   # Run a single test file
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
├── agent/judgment-engine.ts    — two-tier: 3 LLM scanners → optional Sonnet judge escalation
├── agent/model-clients.ts      — Claude Agent SDK query() with env overrides for third-party models
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

**Two-tier assessment**: Scanners run every 15-60s (cheap/free models). If any scanner flags confidence >= 0.5, the Sonnet judge is invoked with full context. The active judge is configurable via `AGENT_ACTIVE_JUDGE` env var.

**Per-scanner MarketNarrative**: Each scanner maintains its own `MarketNarrative` instance that builds context throughout the day:
- **Overnight**: Pre-session agent reads ES bars, builds overnight narrative (range, character, VIX, key levels)
- **Pre-market**: Implied open, auction range, regime expectation
- **Intraday**: Each cycle appends events — SPX price, RSI, regime, notable moves
- **Trajectory tracking**: Session SPX high/low, RSI high/low with timestamps, key moves logged
- **Escalation brief**: When escalating, the scanner builds a full narrative brief including trajectory ("RSI traveled from 18→85 in 47 minutes"), overnight context, recent session events, and the scanner's own evolving interpretation

The judge doesn't receive isolated signals — it receives context-rich escalations. A scanner escalating without narrative context can't justify its signal past the judge.

## Key Types (`src/types.ts`)

- `Bar` — OHLCV + `synthetic` flag + `gapType` + `indicators` (flat JSON blob)
- `Contract` — Options contract with `ContractState` lifecycle
- `Timeframe` — `'1m' | '5m' | '15m' | '1h' | '1d'`
- `IndicatorState` — Rolling window state for incremental indicator computation

## Environment Variables

Required in `.env`:
- `TRADIER_TOKEN` — Tradier API token (data + order execution)
- `TRADIER_ACCOUNT_ID` — For live trading
- `ANTHROPIC_API_KEY` — For Opus judge in the trading agent
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
- **OTM only** — Strike selector targets $0.20-$8.00 OTM contracts. We don't buy ITM. On emergency signals, prefer ~$1.00 strikes for maximum gamma exposure. "We're not collecting dividends."
- **Anticipation over reaction** — A human trader doesn't just react to each bar. They watch a story unfold, track trajectory, and anticipate what's coming. The system works the same way. Scanners build narrative state across the session: session trajectory (SPX/RSI high/low with timestamps), overnight context, pre-market setup, notable moves, their own notes. When they escalate, it's not "I see something now" — it's "here's how we got here and what I'm watching."
- **Agentic over simple or overly complex** — Simple signal systems (RSI >80 = buy puts) are too reactive and too simplistic to capture real market dynamics. Overly complex indicator systems are fragile and overfit to historical data. An agentic system sits between: scanners observe, build narrative, detect patterns, and escalate with context. The judge weighs the full story. This is how a human analyst would work.
- **Price action first, RSI second** — The system should trigger on session high/low breaks, candle range spikes, and V-reversals. RSI is a confirmation filter, not the primary trigger.
- **Scanner prompts are neutral** — Don't tell the models what RSI means or what to think. Give them raw OHLC bars + RSI value + contract chain and let them form their own view. We're testing if they're naturally good market readers, not building an echo chamber.
- **LLMs advise, code executes** — Scanners/judges classify regime (advisory). Strike selection and trade execution are deterministic — no LLM in the hot path. Sub-second execution.

## Scanning & Judgment Agents

### Scanners (Tier 1) — "What do you see?"
Fast, cheap models called every 15-60s with raw market data. They assess conditions and flag setups. All use Claude Agent SDK `query()` with `env` overrides to route to third-party APIs.

| Model | Provider | Speed | Personality | API |
|-------|----------|-------|-------------|-----|
| **Kimi K2.5** | Moonshot | ~2.6s | Cautious, analytical. Wants confirmation before committing. | api.kimi.com/coding/ |
| **ZAI GLM-5** | Zhipu AI | ~3-5s | Fundamentals-focused. Considers macro context. | api.z.ai/api/anthropic |
| **MiniMax M2.7** | MiniMax | ~40-47s | Aggressive, decisive. Picks specific strikes. Only model to respond AND say BUY on first live signal (March 20). | api.minimax.io/anthropic |

### Judges (Tier 2) — "Should we trade?"
Claude models that review scanner output + full market context and make the final call. `AGENT_ACTIVE_JUDGE` env var selects which judge's decision is executed (default: sonnet).

| Model | Speed | Personality |
|-------|-------|-------------|
| **Claude Haiku** | Fast | Quick tiebreaker, momentum reader |
| **Claude Sonnet** | Medium | Structured, decisive, good at formatted output |
| **Claude Opus** | Slow | Deep reasoning, considers edge cases, sometimes overly cautious |

### Prompt Philosophy
All models receive the same neutral prompt — raw OHLC bars, RSI value, and the contract chain. No guidance on what RSI means, no "emergency" language, no bias. Two variants run for each model: **+REGIME** (includes regime classifier tag) and **-REGIME** (no regime context). This tests whether the regime classifier adds value.

### Known Issue: Judge Timeout
All judges run via `Promise.allSettled` in parallel, but they share a single `query()` session which can cause contention and 60s+ timeouts under load. Third-party scanners (Kimi, GLM, MiniMax) use separate HTTP endpoints and work independently. Potential fix: run Claude judges via LiteLLM proxy or direct API instead of Agent SDK.

## Known Bugs (Fixed, March 19-20 2026)

1. **Call/Put parsing** — `isCall = sym.includes('C0')` didn't match `C6xxx` format. Every call recommendation was entered as a put. Fixed.
2. **TP below entry** — Judge returned SPX underlying price as option TP. Sanity check added.
3. **DST bug** — Hardcoded UTC-5 offset instead of Intl timezone in position-manager.ts and risk-guard.ts. Fixed.
4. **MiniMax model name** — Was `MiniMax-M1`, corrected to `MiniMax-M2.7`.
5. **Indicator pipeline resets** — RSI/EMA reset 5 times during March 19 session due to data gaps causing re-initialization.
6. **Promise.allSettled contention** — 6 parallel `query()` calls serialize through claude session, exceeding timeouts. Changed to sequential for judges, parallel only for independent API providers.

## Backtesting & Replay

### Scripts
- `backtest-multi.ts` — Multi-day deterministic backtester (no AI calls, runs in seconds)
- `backtest-no-regime.ts` — Same but no regime filter (A/B comparison)
- `live-monitor.ts` — Live parallel monitor (6 models x 2 variants: +regime/-regime)
- `replay-full.ts` — Full-day replay with AI judge calls (slow, uses API)
- `replay.ts` — 4-moment replay (original, deprecated)
- `backfill-polygon.ts` — Historical option data from Polygon/Massive API
- `backfill-spx.ts` — Historical SPX bars backfill
- `seed-from-dash.ts` — Import from SPX-0DTE dashboard DB

### Replay Library
`replay-library/` contains per-day markdown replay logs and SCORECARD.md. 22 trading days backfilled (Feb 18 → Mar 19, 2026) from Polygon.

### Backtest Targets
- Win rate > 40%
- Average P&L positive per day
- No single day loses more than $500
- Emergency oversold/overbought trades consistently caught

### Current Backtest Status (March 20, post-iteration)
- **42.9% win rate** (target: >40%) ✅ — 3 wins / 7 trades across 21 days
- **$66 avg P&L/day** (target: >$0) ✅
- **-$445 max day loss** (target: >-$500) ✅
- **4/7 emergencies caught** (target: >80%) ❌ — 3 missed are data gaps (Polygon strike range too narrow)
- Key fix: strike search range widened from ±50 to ±200, stop loss widened from 50% to 70%
- 14/21 days have zero signals (Polygon data: only 42 contracts/day in $100 strike band)
- Optimized params: RSI 25/75 triggers, 70% stop, 5x TP, gamma zone trades allowed

## PM2 Processes

| Name | Purpose |
|------|---------|
| spxer | Data pipeline — collects SPX/ES/options bars (port 3600) |
| live-monitor | Parallel AI scanner monitor (6 models x 2 variants) |
| spx | SPX-0DTE dashboard frontend (port 3502) |
| litellm | LiteLLM proxy for MiniMax via Chutes (port 4010) |

## March 19, 2026 — Key Reference Day

Full storyboard replay exists in the conversation history and `replay-library/2026-03-19-full-day-replay.md`. Key moments:
- 09:50 RSI=85.7 overbought (put entered, stopped out -55% — morning momentum trap)
- 11:30 RSI=19.3 oversold (call→put bug, wrong direction)
- 14:34 RSI=8.4 EMERGENCY oversold (the day's key moment)
  - C6600: $1.62 → $33.82 = +1,986%
  - C6615: $0.55 → $23.20 = +4,118%
  - System entered a put (bug) and exited +22% instead of catching the 20-bagger
- 14:57 RSI=82.2 overbought (put entered during explosive rally, -85%)
- Perfect day P&L with fixes: +$8,480. Actual: -$991.

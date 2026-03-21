<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# SPXer — 0DTE SPX Options Trading Agent

## Purpose

SPXer is a dual-mode autonomous trading system:

1. **Data Service** (`npm run dev`) — Always-on 24/5 market data pipeline that collects SPX/ES futures prices, tracks ~250-480 SPXW 0DTE options contracts via sticky band model, builds 1-minute OHLCV bars with a full indicator battery (HMA, EMA, RSI, Bollinger Bands, VWAP, ADX, MACD, etc.), and serves enriched data over REST + WebSocket (port 3600).

2. **Trading Agent** (`npm run agent`) — Multi-model autonomous trading agent that consumes the data service, runs 3 parallel LLM scanners (Kimi K2.5, GLM-5, MiniMax M2.7) for market setup detection, escalates to a Claude judge for trade decisions, and executes via Tradier API in paper mode (or live with `AGENT_PAPER=false`).

The agent is agentic not reactive: scanners build rolling narrative throughout the day, tracking session trajectory and overnight context. Judges receive context-rich escalations, not isolated signals.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Project dependencies and scripts (tsx, vitest, better-sqlite3, express, ws, Claude SDK) |
| `tsconfig.json` | TypeScript configuration |
| `vitest.config.ts` | Test runner configuration |
| `ecosystem.config.js` | PM2 process management configuration |
| `.env.example` | Environment variable template (Tradier API, ports, database) |
| `CLAUDE.md` | Technical architecture & design decisions |
| `README.md` | Project overview & current sprint status |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Main application source (data service + trading agent) — see `src/AGENTS.md` |
| `tests/` | Test suite (unit, integration) — see `tests/AGENTS.md` |
| `docs/` | Architecture specs and design docs — see `docs/AGENTS.md` |
| `replay-library/` | Historical trading replays (22 days × daily markdown + SCORECARD) |
| `logs/` | Execution logs, agent status, activity trails |
| `data/` | SQLite database (WAL mode) with market data & contract history |

## Root-Level Scripts

| File | Purpose |
|------|---------|
| `agent.ts` | Trading agent entry point (paper mode default) |
| `live-monitor.ts` | Parallel AI model monitor (6 models × 2 variants: ±regime) |
| `replay-agent.ts` | Agent that runs replay backtests with AI judge calls |
| `backtest-multi.ts` | Deterministic multi-day backtester (no AI calls, fast) |
| `backtest-no-regime.ts` | Deterministic backtester without regime filtering (A/B comparison) |
| `replay-full.ts` | Full-day replay with AI judge execution (slow, uses API) |
| `param-sweep.ts` | Parameter sweep for RSI thresholds and stop-loss tuning |
| `backfill-spx.ts` | Historical SPX bars backfill from Tradier |
| `backfill-polygon.ts` | Historical option data from Polygon/Massive API |
| `seed-from-dash.ts` | Import historical data from SPX-0DTE dashboard DB |
| `review-*` | Analysis scripts for hypothesis/execution plan review |
| `debug-pm*.ts` | PM2 process debugging utilities |

## For AI Agents

### Working In This Directory

When implementing features in SPXer:

1. **Start in `/src`** — All application logic lives in `src/`. Root scripts are utilities/monitoring.
2. **Understand the data pipeline** — Read `src/index.ts`, then `src/pipeline/` and `src/providers/` to understand how market data flows.
3. **Understand the agent architecture** — Read `src/agent/judgment-engine.ts` and `src/agent/market-narrative.ts` for the two-tier assessment model.
4. **Follow the types** — All types defined in `src/types.ts` and `src/agent/types.ts`. Don't create ad-hoc types.
5. **Test incrementally** — Run tests in `tests/` before committing. Use `npm run test:watch` during development.
6. **Check CLAUDE.md** — Technical decisions and known issues documented there. Read before major changes.

### Testing Requirements

- Unit tests for pure functions (indicator calculations, formatters, bar builders)
- Integration tests for API endpoints and data flows
- Replay scripts for end-to-end validation (run `backtest-multi.ts` with full date range)
- All changes require `npm run test` passing before commit

### Common Patterns

- **Immutable data**: Use object spreads, never mutate in-place
- **Indicator computation**: Incremental state-based (see `src/pipeline/indicator-engine.ts`), never from scratch
- **Error handling**: Explicit at boundaries (API calls, file I/O); let internal guarantees work
- **Configuration**: Use `src/config.ts` for environment-dependent values
- **Logging**: Use `console.log` with timestamps for simple logging

### Architecture Principles

1. **Data → Pipeline → Storage → Server** — Clean separation of concerns
2. **Sticky band model** — Contracts tracked once in ±$100 strike band around SPX, never dropped early
3. **Two-tier judgment** — Scanners flag (15-60s cycle), judges decide (on escalation only)
4. **Narrative over signals** — Context matters. Build trajectory, overnight setup, session events. Escalate with story.
5. **Deterministic execution** — Strike selection and trading are code, not LLM-based (sub-second execution)

## Dependencies

### Internal
- `src/config.ts` — Global configuration (all modules depend on this)
- `src/types.ts` — Shared type definitions (Bar, Contract, Timeframe, etc.)
- `src/pipeline/` — OHLCV bar construction, indicator computation, contract tracking
- `src/providers/` — Data fetching from Tradier, Yahoo, TradingView Screener
- `src/storage/` — SQLite database layer
- `src/server/` — HTTP REST API and WebSocket server (port 3600)
- `src/agent/` — Trading agent logic (regime classifier, scanners, judge, executor)

### External
- **Data**: Tradier API (options data, order execution), Yahoo Finance (ES futures overnight)
- **LLM**: Anthropic Claude SDK (Haiku/Sonnet/Opus judges), third-party APIs (Kimi, GLM, MiniMax)
- **Database**: SQLite with WAL mode (`better-sqlite3`)
- **Server**: Express (HTTP), WS (WebSocket)

## Environment Variables

```bash
# Required
TRADIER_TOKEN=...              # Tradier API token (data + orders)
TRADIER_ACCOUNT_ID=...         # For live trading
ANTHROPIC_API_KEY=...          # For Claude judges
PORT=3600                       # Data service port

# Optional
AGENT_PAPER=true               # Paper trading (default true)
AGENT_ACTIVE_JUDGE=sonnet      # Which judge to execute (haiku|sonnet|opus)
AGENT_MAX_DAILY_LOSS=500        # Daily loss limit in dollars
AGENT_MAX_POSITIONS=5           # Max open trades
AGENT_MAX_RISK_PER_TRADE=200    # Risk per trade
AGENT_CUTOFF_ET=16:00           # Stop trading after this ET time

# Third-party scanners (optional)
KIMI_API_KEY=...
KIMI_BASE_URL=https://api.kimi.com/coding/
GLM_API_KEY=...
GLM_BASE_URL=https://api.z.ai/api/anthropic
MINIMAX_API_KEY=...
MINIMAX_BASE_URL=https://api.minimax.io/anthropic

# Database
DB_PATH=./data/spxer.db

# Monitoring
LOG_LEVEL=info
```

## Commands

```bash
# Data Service
npm run dev                 # Start data pipeline + HTTP/WS server (port 3600)

# Trading Agent
npm run agent              # Paper trading (no real orders)
npm run agent:live         # Live trading (real orders, requires AGENT_PAPER=false)

# Testing
npm run test               # Run all tests (vitest)
npm run test:watch         # Watch mode

# Building
npm run build              # TypeScript → JavaScript (dist/)
npm start                  # Run compiled JavaScript

# Backtesting & Replay
npx tsx backtest-multi.ts --from 2026-02-20 --to 2026-03-20
npx tsx replay-full.ts --date 2026-03-20
npx tsx live-monitor.ts    # Parallel 6-model monitor
```

## Key Concepts

### Market Data Pipeline

1. **Providers** fetch raw data (Tradier options quotes, Yahoo ES, TradingView screener)
2. **Pipeline** processes: bar building, indicator computation, contract tracking, aggregation
3. **Storage** persists to SQLite (WAL mode for concurrent reads/writes)
4. **Server** exposes REST API (`/spx/snapshot`, `/contracts/active`, `/chain`) and WebSocket broadcast

### Trading Agent Loop

1. **Market Feed** snapshots current state from data service
2. **Regime Classifier** tags market regime (MORNING_MOMENTUM, MEAN_REVERSION, TRENDING_UP/DOWN, GAMMA_EXPIRY, NO_TRADE)
3. **Signal Detector** looks for: RSI extremes (>80 or <25), price action breaks, HMA/EMA crosses
4. **Market Narrative** builds rolling context: overnight setup, trajectory, notable moves
5. **Judgment Engine** runs 3 scanners, optionally escalates to judge on confidence threshold
6. **Strike Selector** picks deterministic OTM strike (not LLM-chosen)
7. **Trade Executor** places order via Tradier API
8. **Position Manager** monitors open trades
9. **Risk Guard** enforces daily loss limits, position limits, time cutoffs
10. **Audit Log** records every decision in JSON for replay/analysis

### Sticky Band Contract Model

- Contracts start `UNSEEN` until they enter ±$100 strike band around SPX
- Once `ACTIVE`, they transition to `STICKY` and are tracked until expiry
- **Never dropped early** — ensures we don't miss opportunities near expiration
- Band auto-adjusts as SPX moves

### Two-Tier Assessment

**Tier 1 (Scanners)**: Run every 15-60s (cheap). Called "scanners" because they assess ("scan") conditions and flag setups.
- Kimi K2.5 (cautious, wants confirmation)
- GLM-5 (fundamentals-focused, macro context)
- MiniMax M2.7 (aggressive, decisive, fastest response)

**Tier 2 (Judges)**: Run on escalation only (expensive). Called "judges" because they weigh the full context and make the final call.
- Claude Haiku (fast tiebreaker)
- Claude Sonnet (structured, decisive)
- Claude Opus (deep reasoning, edge cases)

Scanners don't trade — they escalate. Judges decide. Code executes.

<!-- MANUAL: Add any manually curated notes below this line -->

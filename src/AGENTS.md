<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# src — Application Source Code

## Purpose

All application source code for the data service (`src/index.ts`) and trading agent (`agent.ts` at root). This directory contains the complete pipeline: data fetching, OHLCV bar construction, indicator computation, contract tracking, SQLite persistence, HTTP/WebSocket serving, regime classification, multi-model judgment, and trade execution.

## Core Entry Points

| File | Description |
|------|-------------|
| `index.ts` | Data service main loop — polls providers, builds bars, computes indicators, tracks contracts, broadcasts on WebSocket |
| `config.ts` | Global configuration — API tokens, ports, database path, market holidays, poll intervals |
| `types.ts` | Shared type definitions — Bar, Contract, Timeframe, IndicatorState, ScreenerSnapshot |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `providers/` | Data fetching — Tradier (options/SPX), Yahoo (ES futures), TradingView screener — see `providers/AGENTS.md` |
| `pipeline/` | OHLCV bar construction, indicator computation, contract tracking, aggregation, scheduling — see `pipeline/AGENTS.md` |
| `storage/` | SQLite database layer with WAL mode, schema, queries, parquet archival — see `storage/AGENTS.md` |
| `server/` | HTTP REST API (Express) and WebSocket broadcast server (WS) — see `server/AGENTS.md` |
| `agent/` | Trading agent logic — regime classifier, scanners, judge, market narrative, strike selector, executor — see `agent/AGENTS.md` |

## Data Flow Architecture

```
Providers (fetch)         Pipeline (process)        Storage (persist)      Server (serve)
──────────────────        ───────────────────       ─────────────────      ──────────────
providers/tradier.ts ──┐  pipeline/bar-builder.ts   storage/db.ts          server/http.ts (REST)
providers/yahoo.ts ────┼──────────►───────────────► storage/queries.ts ──► server/ws.ts (broadcast)
providers/tv-screener.ts  pipeline/indicator-engine pipeline/archiver.ts
                          pipeline/aggregator.ts
                          pipeline/contract-tracker
                          pipeline/scheduler.ts
```

**Flow**:
1. Providers fetch raw OHLCV data from APIs
2. Bar builder converts raw data to Bar objects
3. Indicator engine computes technical indicators incrementally
4. Contract tracker maintains sticky band model (±$100 around SPX)
5. Aggregator creates higher timeframes from 1m bars
6. Storage layer persists to SQLite
7. Server exposes REST API and broadcasts on WebSocket
8. Scheduler switches data sources based on market hours (ES overnight, SPX RTH)

## For AI Agents

### Working In This Directory

1. **Understand the data pipeline first** — Read `src/index.ts` to see the main loop. Then explore each provider, pipeline stage, and storage layer in order.
2. **Types guide structure** — All types are in `types.ts` and `agent/types.ts`. Don't create ad-hoc types; extend existing ones.
3. **Incremental indicators** — Indicators use state-based incremental computation (see `pipeline/indicator-engine.ts`). Never compute from scratch.
4. **Immutability** — Use object spreads. Never mutate bars, contracts, or indicator state in-place.
5. **Error handling** — Validate inputs at API boundaries. Let internal invariants work (e.g., bars are always sorted by time).
6. **Testing** — Each module has a corresponding test file in `tests/`. Add tests with your changes.

### Testing Requirements

- **Unit tests**: Pure functions (bar building, indicators, formatters)
- **Integration tests**: API calls, storage queries, server endpoints
- **Run before commit**: `npm run test` must pass
- **Replay validation**: Run `backtest-multi.ts` with your changes to validate end-to-end

### Common Patterns

- **Bar objects**: Always include metadata (synthetic flag, gap type) for gap handling
- **Contracts**: State machine (UNSEEN → ACTIVE → STICKY → EXPIRED), never drop from sticky band
- **Providers**: Return raw OHLCV data; pipeline handles conversion and processing
- **Indicators**: Store state (rolling window, EMA values, ADX state) to compute incrementally per new bar
- **Storage**: Use parameterized queries (prepared statements) to avoid SQL injection

## Key Architecture Decisions

### Time-Based Source Switching

Scheduler auto-switches data sources based on market hours:
- **Overnight (6 PM-9:30 AM ET)**: ES futures from Yahoo Finance (`ES=F`)
- **RTH (9:30 AM-4:15 PM ET)**: SPX from Tradier timesales

Decision made because ES data is available 24/5, SPX only during regular trading hours. Tradier batch quotes much faster for options chains than per-contract calls.

### Sticky Band Contract Model

Once a contract enters the ±$100 strike band around SPX, it's marked STICKY and tracked until expiry. **Never dropped early.** Rationale: allows us to catch late reversals near expiration. Contract symbol format: Tradier canonical (e.g., `SPXW260318C05000000` = SPX + YYMMDD + C/P + 8-digit zero-padded strike × 1000).

### Incremental Indicator Computation

Indicators compute from rolling window state, not from scratch each bar. Per-symbol state maintained in memory via `IndicatorState`. Tier 1 indicators (HMA, EMA, RSI, Bollinger Bands, ATR, VWAP) on all instruments. Tier 2 (EMA 50/200, SMA, Stochastic, CCI, MACD, ADX) on underlying only.

### Bar Interpolation

Options have gaps (no trades for minutes). Gaps ≤60 min get linear price interpolation (synthetic bar flag). Gaps >60 min get flat-fill (stale). Indicators computed on synthetic bars for continuity. Rationale: ensures momentum indicators work across gaps without false reversals.

### WAL Mode Database

SQLite runs in WAL (write-ahead log) mode to support concurrent readers (WebSocket broadcast, query API) while writer updates bars. Archiver exports expired contracts to parquet → Google Drive to keep hot DB < 500 MB.

## Dependencies

### Internal
- All modules depend on `config.ts` (environment-dependent values)
- All modules depend on `types.ts` (shared type definitions)
- `pipeline/` modules depend on `providers/` (raw data)
- `storage/` depends on `pipeline/` (bars, contracts)
- `server/` depends on `storage/` (query results)
- `agent/` depends on all above (full system context)

### External
- **HTTP clients**: `axios` (Tradier API), `openai` SDK (for model routing)
- **Database**: `better-sqlite3` (SQLite)
- **Server**: `express` (REST API), `ws` (WebSocket)
- **AI**: `@anthropic-ai/sdk` (Claude API), `@anthropic-ai/claude-agent-sdk` (agent SDK)
- **Data**: `dotenv` (environment loading)

## Key Files by Purpose

### Configuration & Types
- `config.ts` — Global configuration (API keys, ports, database path, market hours, poll intervals)
- `types.ts` — Bar, Contract, Timeframe, IndicatorState, ChainContract, ScreenerSnapshot

### Data Providers
- `providers/tradier.ts` — Tradier API client (options quotes, SPX timesales, batch quotes)
- `providers/yahoo.ts` — Yahoo Finance client (ES futures overnight)
- `providers/tv-screener.ts` — TradingView screener client (additional market data)

### Pipeline (Data Processing)
- `pipeline/bar-builder.ts` — Convert raw OHLCV to Bar objects, handle gap interpolation
- `pipeline/indicator-engine.ts` — Incremental indicator computation (HMA, EMA, RSI, Bollinger, ATR, VWAP, MACD, ADX, etc.)
- `pipeline/aggregator.ts` — Build higher timeframes (5m, 15m, 1h, 1d) from 1m bars
- `pipeline/contract-tracker.ts` — Sticky band model, UNSEEN → ACTIVE → STICKY → EXPIRED state machine
- `pipeline/scheduler.ts` — Determine market mode (RTH vs overnight), decide which data source to poll

### Storage (Persistence)
- `storage/db.ts` — SQLite database initialization, WAL mode setup
- `storage/queries.ts` — All database operations (upsertBar, upsertContract, getAllActiveContracts, etc.)
- `storage/archiver.ts` — Export expired contracts to parquet, upload to Google Drive via rclone

### Server (Serving)
- `server/http.ts` — Express REST API (GET /health, /spx/snapshot, /contracts/active, /chain, etc.)
- `server/ws.ts` — WebSocket server broadcast (broadcasts new bars, contract updates in real-time)

### Agent (Trading)
- `agent/market-feed.ts` — Snapshot current market state from data service
- `agent/regime-classifier.ts` — Tag market regime (MORNING_MOMENTUM, MEAN_REVERSION, TRENDING_UP/DOWN, GAMMA_EXPIRY, NO_TRADE)
- `agent/market-narrative.ts` — Build rolling narrative throughout the day (overnight context, session trajectory, notable events)
- `agent/pre-session-agent.ts` — Overnight + pre-market analysis (runs at 9:20 ET)
- `agent/signal-detector.ts` — Deterministic signal detection (RSI extremes, EMA/HMA crosses, price action breaks)
- `agent/price-action.ts` — Price action pattern detection (session high/low breaks, range expansion, V-reversals)
- `agent/judgment-engine.ts` — Two-tier: 3 LLM scanners (Kimi, GLM, MiniMax) → optional Sonnet judge escalation
- `agent/model-clients.ts` — Claude Agent SDK query() with env overrides for third-party model routing
- `agent/strike-selector.ts` — Deterministic OTM strike selection (greedy: cheapest contract in target range)
- `agent/trade-executor.ts` — Tradier order execution (paper or live)
- `agent/position-manager.ts` — Monitor open positions, track P&L
- `agent/risk-guard.ts` — Daily loss limits, position limits, time cutoffs
- `agent/audit-log.ts` — JSON audit trail of all decisions
- `agent/reporter.ts` — Status file + activity log for monitoring
- `agent/replay-framework.ts` — Backtesting harness for replay scripts
- `agent/types.ts` — Agent-specific types (TradeDecision, MarketSnapshot, ContractState, etc.)

<!-- MANUAL: Add any manually curated notes about src/ architecture below -->

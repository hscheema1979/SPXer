# Multi-Ticker Expansion Plan

**Date:** 2026-03-29
**Status:** Planning
**Goal:** Expand SPXer's HMA-based trading strategy to high-liquidity single-stock options (TSLA, NVDA, AMZN, META, AAPL, etc.)

---

## Current State

SPXer is a working system with two live agents:

| Agent | Product | Account | Strategy |
|-------|---------|---------|----------|
| `spxer-agent` | SPX 0DTE (SPXW) | Margin ($25k) | HMA3×17 scannerReverse, 10 contracts |
| `spxer-xsp` | XSP 1DTE | Cash ($1.2k) | HMA3×17 single-shot, 1 contract |

Both use the same HMA(3)×HMA(17) cross signal derived from SPX price data. The entire pipeline — data collection, indicator computation, signal detection, strike selection, position management, and trade execution — is built for SPX.

---

## What Needs to Change (and What Doesn't)

### ✅ Already Generic (no changes needed)
- **Indicator engine** (`src/core/indicator-engine.ts`) — computes HMA, RSI, EMA, BB, etc. on any symbol's bars. Keyed by `(symbol, timeframe)`.
- **Position manager** (`src/core/position-manager.ts`) — checkExit logic is symbol-agnostic.
- **Risk guard** (`src/core/risk-guard.ts`) — daily loss limits, trade counts, cutoffs. All config-driven.
- **Position sizer** (`src/core/position-sizer.ts`) — computes qty from price and config. Generic.
- **Friction model** (`src/core/friction.ts`) — spread + commission. Configurable per product.
- **Config system** (`src/config/types.ts`) — already has `execution` block for multi-symbol/multi-account.
- **Trade executor** (`src/agent/trade-executor.ts`) — supports symbol conversion, account override via `Config.execution`.
- **Replay engine** (`src/replay/machine.ts`) — reads bars from DB by symbol. Already generic if bars exist.

### 🟡 Needs Generalization (medium effort)
- **Data pipeline** (`src/index.ts`) — hardcoded to fetch SPX quotes and SPX options chains. Needs to support multiple underlyings.
- **Market feed** (`src/agent/market-feed.ts`) — fetches from SPXer data service, assumes SPX endpoints. Needs per-ticker bar fetching.
- **Contract tracker** (`src/pipeline/contract-tracker.ts`) — manages the sticky band model for SPXW contracts. Needs per-underlying tracking.
- **Strike selector** (`src/core/strike-selector.ts`) — generic but references "spxPrice" parameter name. Trivially renameable.
- **Server/API** (`src/server/http.ts`) — exposes `/spx/snapshot`, `/spx/bars`. Needs per-ticker routes or parameterized routes.
- **Bar builder** (`src/pipeline/bar-builder.ts`) — generic, but options symbol parsing assumes SPXW format.

### 🔴 Needs New Code (significant effort)
- **Per-ticker HMA parameter tuning** — SPX's 3×17 periods may not work for TSLA's volatility profile. Each ticker needs its own backtest sweep.
- **Expiry selection** — SPX has daily expiry (0DTE). Stocks have weekly/monthly. Need logic to pick the right expiry.
- **Earnings calendar** — avoid trading through binary events. Need an earnings date database.
- **Assignment risk management** — stock options are American-style. If ITM at expiry, you get assigned shares. Need guardrails.
- **Historical data backfill** — need 1-year of 1-minute bars + options data per ticker for backtesting.

---

## Architecture: Multi-Ticker Design

### Option A: One Process Per Ticker (Recommended)

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Data Service    │  │  Data Service    │  │  Data Service    │
│  SPX (:3600)     │  │  TSLA (:3601)    │  │  NVDA (:3602)    │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
    ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
    │ Agent   │         │ Agent   │         │ Agent   │
    │ SPX     │         │ TSLA    │         │ NVDA    │
    └─────────┘         └─────────┘         └─────────┘
```

**Pros:** Complete isolation. One ticker crashing doesn't affect others. Easy to add/remove. Each has its own tuned config.

**Cons:** More PM2 processes. Slightly more memory. Separate DB or shared DB with symbol namespacing.

### Option B: Single Data Service, Multiple Agents

```
┌──────────────────────────────────┐
│  Data Service (:3600)            │
│  SPX + TSLA + NVDA + ...        │
└──────┬───────┬───────┬──────────┘
       │       │       │
  ┌────┴──┐ ┌──┴───┐ ┌─┴─────┐
  │ Agent │ │ Agent│ │ Agent │
  │ SPX   │ │ TSLA │ │ NVDA  │
  └───────┘ └──────┘ └───────┘
```

**Pros:** One data service, lower memory. Shared DB. Simpler deployment.

**Cons:** Coupling — data service changes affect all tickers. Options chain fetching for multiple underlyings may hit Tradier rate limits.

### Recommendation: Option B with ticker isolation in the agent layer

One data service tracks all underlyings and their options. Separate agent processes per ticker, each with their own config. Shared SQLite DB with symbol-based namespacing (already how it works).

---

## Implementation Phases

### Phase 1: Multi-Ticker Data Pipeline (1-2 days)
**Goal:** Data service tracks multiple underlyings and their options chains.

#### 1.1 Generalize `src/index.ts`
- Extract the SPX-specific polling loop into a `TickerPipeline` class
- Constructor takes: `{ symbol, optionPrefix, strikeInterval, strikeBand }`
- Each ticker gets its own polling cycle, bar builder, contract tracker
- SPX remains the first instance; TSLA/NVDA added as config

```typescript
// New: src/pipeline/ticker-pipeline.ts
interface TickerConfig {
  symbol: string;              // 'TSLA', 'NVDA'
  optionPrefix: string;        // 'TSLA', 'NVDA' (stock options use ticker as prefix)
  strikeInterval: number;      // 1 for stocks (vs 5 for SPX)
  strikeBand: number;          // ±$20 for TSLA (vs ±$100 for SPX)
  pollMs: number;              // 5000ms for RTH
  optionPollMs: number;        // 15000ms for options
}
```

#### 1.2 Generalize providers
- `fetchQuote(symbol)` — already supports any symbol via Tradier
- `fetchOptionsChain(symbol, expiry)` — already generic
- `fetchExpirations(symbol)` — already generic
- `fetchTimesales(symbol)` — already generic
- Only `fetchSpxQuote()` is SPX-specific → rename to `fetchQuote(symbol)`

#### 1.3 Generalize server routes
- `/ticker/:symbol/bars` — bars for any tracked underlying
- `/ticker/:symbol/snapshot` — latest bar with indicators
- `/ticker/:symbol/contracts` — active options contracts
- Keep existing `/spx/*` routes as aliases for backward compatibility

#### 1.4 Track multiple underlyings in DB
- Bars table already uses `(symbol, timeframe, ts)` as key — no change needed
- Contracts table already uses `symbol` — no change needed
- Just need to poll and store bars for each tracked ticker

### Phase 2: Historical Data Backfill (1 day)
**Goal:** 1 year of 1-minute bars + options data for target tickers.

#### 2.1 Stock bars backfill
- Extend `backfill-polygon.ts` to fetch stock bars (not just SPX)
- Polygon API supports all US equities — same API, different symbol
- Need: TSLA, NVDA, AMZN, META, AAPL 1-minute bars, 1 year

#### 2.2 Options data backfill
- Polygon option bars for each ticker's options
- Challenge: stock options have many more expiries (weekly + monthly)
- Focus on weekly options only (closest to 0DTE behavior)
- Filter: only options expiring within 1-5 days of trade date

### Phase 3: Per-Ticker Parameter Sweep (2-3 days)
**Goal:** Find optimal HMA periods, TP/SL, OTM distance for each ticker.

#### 3.1 Run existing sweep infrastructure
- `backtest-multi.ts` already supports config-driven replays
- Create configs for each ticker with parameter variations:
  - HMA fast: [3, 5, 7]
  - HMA slow: [13, 15, 17, 19, 21]
  - TP: [1.2x, 1.4x, 1.6x, 2.0x]
  - SL: [50%, 60%, 70%, 80%]
  - OTM distance: [$1, $2, $3, $5] (stock-relative)
  - Exit strategy: [takeProfit, scannerReverse]

#### 3.2 Key differences to validate per ticker

| Parameter | SPX Expectation | Stock Expectation |
|-----------|-----------------|-------------------|
| HMA periods | 3×17 (fast) | May need slower — stocks trend longer |
| TP multiplier | 1.4x (small) | May support higher — more volatile |
| SL percent | 70% (deep) | May need tighter — gap risk |
| OTM distance | $15 (~0.26%) | $1-5 (~0.5-2%) — relatively further OTM |
| Exit strategy | scannerReverse | Likely takeProfit — no daily expiry to force flat |
| Trades/day | ~11 (flip model) | Fewer — hold longer, wider moves |

#### 3.3 Evaluate results
- Same metrics: Sharpe, profit factor, win rate, max drawdown
- Compare with/without friction (stock options have tighter spreads)
- Identify which tickers are worth trading vs. not

### Phase 4: Agent Per Ticker (1 day)
**Goal:** Deploy trading agents for validated tickers.

#### 4.1 Create per-ticker config files
```
agent-config.ts          # SPX (existing)
agent-xsp-config.ts      # XSP (existing)
agent-tsla-config.ts     # TSLA (new)
agent-nvda-config.ts     # NVDA (new)
```

#### 4.2 Create per-ticker agent entry points
- Each agent reads from the shared data service
- Each has its own config with tuned parameters
- Each can target a different account or share one

#### 4.3 OR: Generic agent launcher
Instead of separate files per ticker, create a single generic agent:

```bash
# Generic launcher — reads config from DB by id
npx tsx agent-generic.ts --config tsla-hma5x19-tp2x
npx tsx agent-generic.ts --config nvda-hma3x17-tp14x
```

This is cleaner long-term but requires the config to live in DB.

#### 4.4 PM2 ecosystem update
```javascript
// ecosystem.config.js
{ name: 'agent-tsla', script: 'npm', args: 'run agent:tsla' },
{ name: 'agent-nvda', script: 'npm', args: 'run agent:nvda' },
```

### Phase 5: Stock-Specific Guardrails (1 day)
**Goal:** Handle risks unique to stock options.

#### 5.1 Earnings calendar
- Integrate earnings dates (free API: Alpha Vantage, or Tradier corporate calendar)
- Auto-disable trading on earnings day and day before
- Config flag: `skipEarningsWindow: true`

#### 5.2 Assignment protection
- Monitor time-to-expiry: close any ITM position before 3:00 PM on expiry day
- Never hold through expiry if ITM (assignment = forced share delivery)
- Add to `checkExit()`: `if (isITM && minutesToExpiry < 60) → force close`

#### 5.3 Gap risk management
- Stocks can gap 3-10% overnight on news
- For overnight holds (1DTE+): tighter stops, smaller position sizes
- Config: `overnightStopPercent: 30` vs intraday `stopLossPercent: 70`

#### 5.4 Halt detection
- Stocks can halt (LULD halts). Options stop trading too.
- If position monitor gets no price for 5+ minutes during RTH → alert, don't panic-sell
- Log halt detection events

---

## Target Ticker Criteria

Not every stock is worth trading. Requirements:

| Criterion | Threshold | Why |
|-----------|-----------|-----|
| Average daily volume | >50M shares | Liquidity for underlying |
| Options volume | >100k contracts/day | Tight spreads |
| Weekly options | Must have weeklys | Need short-dated for theta strategy |
| Average IV | >30% | Need premium to make TP viable |
| Price | $50-$500 | Too cheap = wide % spreads; too expensive = high notional risk |
| Bid-ask spread | <$0.05 ATM | Execution quality |

### Tier 1 Candidates (highest priority)
| Ticker | Price | Avg Vol | Options Vol | Weeklys | IV |
|--------|-------|---------|-------------|---------|-----|
| TSLA | ~$275 | 80M+ | 2M+ | ✅ | 55%+ |
| NVDA | ~$120 | 200M+ | 3M+ | ✅ | 45%+ |
| AMZN | ~$195 | 50M+ | 500k+ | ✅ | 35%+ |
| META | ~$580 | 20M+ | 400k+ | ✅ | 35%+ |
| AAPL | ~$220 | 60M+ | 800k+ | ✅ | 25%+ |

### Tier 2 Candidates (validate later)
| Ticker | Notes |
|--------|-------|
| AMD | High IV, good volume, but lower options liquidity |
| GOOGL | Good volume but IV often too low |
| MSFT | Very liquid but low IV — may not generate enough premium |
| QQQ | ETF — like SPY but Nasdaq. Cash account friendly |
| IWM | ETF — Russell 2000. High IV, different from SPX |

---

## Estimated Timeline

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| Phase 1: Multi-ticker data pipeline | 1-2 days | None |
| Phase 2: Historical backfill | 1 day | Phase 1 |
| Phase 3: Parameter sweep | 2-3 days | Phase 2 (compute time) |
| Phase 4: Agent deployment | 1 day | Phase 3 results |
| Phase 5: Stock guardrails | 1 day | Phase 4 |
| **Total** | **6-8 days** | |

---

## Immediate Next Steps

1. **Validate SPX/XSP live execution first** — Run both agents in paper mode for 1-2 trading days. Confirm trades match replay expectations. Don't expand until the base case works.

2. **Backfill TSLA + NVDA 1-minute bars** — Use Polygon API. Start with these two because they have the highest options liquidity and IV.

3. **Run parameter sweep on TSLA** — Use existing `backtest-multi.ts` infrastructure. Find optimal HMA periods and TP/SL for TSLA's volatility profile.

4. **Generalize data pipeline** — Extract SPX-specific code from `src/index.ts` into a reusable `TickerPipeline` class.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| SPX parameters don't transfer | Wasted effort | Phase 3 catches this — don't deploy without backtest validation |
| Stock options assignment | Forced share delivery, margin call | Phase 5 ITM auto-close guardrail |
| Earnings blowup | 5-10% gap, total loss of position | Earnings calendar filter |
| Tradier rate limits | Missing data, stale prices | Stagger polling per ticker, prioritize active positions |
| Over-diversification | Spread too thin, can't monitor | Start with 2 tickers max, prove it, then expand |
| Correlated losses | All tickers drop together in selloff | Different from SPX index — single stocks have idiosyncratic moves. But in a crash, correlation goes to 1. Position size accordingly. |

---

## Project Rename Consideration

As the system expands beyond SPX, consider renaming from "SPXer" to something ticker-agnostic:

- **OptionsEngine** — descriptive, generic
- **AlphaHMA** — references the core strategy
- **TradeForge** — sounds cool but uninformative
- **Keep "SPXer"** — it's the origin story, and everyone knows what it does

Recommendation: Keep SPXer for now. Rename if/when stocks become the primary focus.

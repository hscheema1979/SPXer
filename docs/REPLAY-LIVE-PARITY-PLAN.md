# Replay ↔ Live Parity Plan

## Problem Statement

The replay system and live agent are supposed to run the same strategy, but they use different code paths for every critical decision: signal detection, entry logic, position management, exit conditions, and HMA cross tracking. The result is that a config tested in replay produces completely different behavior when deployed live. This defeats the entire purpose of the backtest→deploy workflow.

## Current Architecture (Broken)

```
REPLAY (src/replay/machine.ts)          LIVE AGENT (agent.ts)
─────────────────────────────           ──────────────────────
Config from DB (--config-id)            Config from DB (store.getConfig)
                                        
SPX HMA cross: inline detectHmaCross()  SPX HMA cross: PositionManager.updateHmaCross()
  - uses bar cache by timestamp           - uses BarSummary from market-feed
  - compares bars[n-1] vs bars[n-2]       - compares closedBar (n-2) vs prev state
  - supports multi-timeframe               - 1m only, different HMA key lookup
                                        
Option signals: detectSignals() from     Option signals: runCoreSignalDetection()
  src/core/ on contract bars from cache    - calls detectSignals() but constructs
  at each timestamp                         CoreBar map from MarketSnapshot
                                           - different dedup (prevContractBarTs)
                                           - different OTM/HMA filtering after
                                        
Entry: escalation pipeline                Entry: direct from signal
  signalTriggersJudge → shouldEscalate    - selectStrike() → executeBuy()
  judges.length===0 → auto-buy            - no escalation concept at all
  selectStrike inline (different impl)    
                                        
Exit: checkExit() from src/core/         Exit: checkExit() from src/core/
  called inline per bar per position       called via PositionManager.monitor()
  price from bar cache                     price from Tradier API quotes
                                        
Position state: openPositions Map         Position state: PositionManager class
  key: ${symbol}_${ts} (BUG)               key: random UUID
  no persistence                           no persistence (crash = lost)
                                        
Flip: on signal_reversal exit,            Flip: on signal_reversal from monitor(),
  find best opposite contract,              agent.ts handles flip in main loop
  enter immediately at bar price            selectStrike → executeBuy
```

**Key divergences:**
1. HMA cross detection uses different code, different bar sources, different dedup logic
2. Entry path is completely different (escalation pipeline vs direct)
3. Position keys allow duplicates in replay (`symbol_ts`) 
4. Replay has no concept of order fills, rejections, or spread-based order types
5. Live agent has no concept of the escalation/judge pipeline it was built around

## Target Architecture

One shared decision function that both replay and live call. It is **pure** — it does NOT mutate state. It takes current state + market data in, returns decisions + proposed state updates out. The caller decides whether and how to apply those updates.

Replay applies instantly (perfect fills). Live applies after order confirmation (real fills, rejections, timeouts).

```
src/core/
├── signal-detector.ts     — detectSignals()         (exists, shared)
├── position-manager.ts    — checkExit()             (exists, shared)
├── risk-guard.ts          — isRiskBlocked()          (exists, shared)
├── strike-selector.ts     — selectStrike()           (exists, shared)
├── position-sizer.ts      — computeQty()             (exists, shared)
├── friction.ts            — frictionEntry/Exit()      (exists, shared)
├── indicator-engine.ts    — HMA/RSI/EMA computation   (exists, shared)
└── NEW: strategy-engine.ts — tick() function          (THE MISSING PIECE)
```

### Two-Speed Data Model

tick() consumes two distinct data streams at different speeds. Getting this right is the key to parity:

**Closed candles (1m bars)** — For signal detection and HMA cross detection. These fire once per minute when a candle closes. Both replay and live produce identical candle data: complete OHLCV with indicators computed on final values. **All trading decisions are made on closed candles.** This is what makes the strategy deterministic.

**Live tick prices** — For position monitoring (SL/TP/trailing stop) and strike selection. In live, the `PriceStream` (HTTP streaming) and `OptionStream` (WebSocket streaming) push every trade and quote sub-second, cached per-symbol. In replay, the "tick price" is just the closed bar's close at that timestamp. tick() receives both and uses them for different purposes:

```
                    ┌─────────────────────────────────────┐
                    │           tick() function            │
                    │                                      │
  Closed candles ──►│  Step 1: HMA cross detection         │
  (spxBars)         │  Step 6: Entry signal detection       │
                    │         (detectSignals on candles)    │
                    │                                      │
  Live tick      ──►│  Step 2: Position exit monitoring     │
  prices            │         (SL/TP/trailing at live px)  │
  (positionPrices,  │  Step 6b: Strike selection            │
   candidates,      │         (OTM distance + price band   │
   spxPrice)        │          from live tick prices)       │
                    │                                      │
                    │  Steps 3-5: Gates (risk/time/cooldown)│
                    └─────────────────────────────────────┘
```

**Why this matters:** In the old architecture, the live agent checked exits against Tradier REST quotes (polled every 5-30s) while replay checked against bar close prices (exact 1m resolution). With streaming, live exit monitoring gets every tick — faster than replay, not slower. The candle-based decisions (signals, HMA crosses) are identical in both systems because they only fire on closed candles.

**Price freshness by purpose:**

| Purpose | Data source | Freshness (live) | Freshness (replay) |
|---------|-------------|-------------------|---------------------|
| HMA cross detection | `spxBars` (closed candles) | 1m (candle close) | 1m (bar timestamp) |
| Signal detection | `contractBars` (closed candles) | 1m (candle close) | 1m (bar timestamp) |
| Position SL/TP monitoring | `positionPrices` (tick cache) | Sub-second | 1m (bar close) |
| Strike OTM distance | `spxPrice` (tick or bar close) | Sub-second | 1m (bar close) |
| Contract price band filter | `candidates[].price` (tick cache) | Sub-second | 1m (bar close) |

### Data Flow: Live vs Replay

**The 1m bar with full indicators is the foundation. Higher timeframes are aggregated from 1m.**

```
LIVE (data service — src/index.ts)
──────────────────────────────────
WebSocket ticks (SPX + ~160 options contracts)
  │
  ▼
1m Candle Builder (per symbol)
  ├── Accumulates ticks into forming candle
  ├── On minute boundary: close candle
  │     ├── computeIndicators(bar, tier)  → HMA 3/5/15/17/19/25, EMA, RSI, BB, ATR, VWAP, KC
  │     ├── upsertBars([bar])             → stored in DB at 1m
  │     └── aggregateAndStore(recent1m)   → aggregate to 3m/5m/10m/15m/1h
  │           ├── aggregate(bars1m, '3m', 180)  → proper OHLCV
  │           ├── computeIndicators(bar3m)      → indicators ON the 3m bar
  │           └── upsertBars([bar3m])           → stored in DB at 3m
  │           (repeat for 5m, 10m, 15m, 1h)
  │
  ▼
DB has bars at all timeframes, each with its own indicators
  ├── SPX 1m:  HMA(3)=6580.12, HMA(17)=6578.50, RSI=55.2, ...
  ├── SPX 3m:  HMA(3)=6579.80, HMA(17)=6577.90, RSI=54.8, ...  ← different values!
  ├── SPX 5m:  HMA(3)=6579.50, HMA(17)=6577.20, RSI=53.1, ...
  └── Options: same pattern per contract per timeframe

Tick cache (separate from candles — sub-second freshness)
  ├── PriceStream.getPrice('SPX')           → latest SPX tick
  └── OptionStream.getPrice('SPXW...')      → latest option tick


REPLAY (bar cache — src/replay/machine.ts)
──────────────────────────────────────────
loadBarCache(db, start, end, symbolFilter, timeframe)
  ├── Loads pre-computed bars from DB at the requested timeframe
  ├── Bars already have indicators (computed during live collection or backfill)
  ├── ensureHmaPeriods() fills in any missing HMA periods on-the-fly
  └── getTfCache(tf) loads each timeframe once, deduplicates
```

**How each TickInput field is populated:**

| Field | Live | Replay |
|-------|------|--------|
| `spxDirectionBars` | Closed bars from DB at `config.signals.directionTimeframe`. `stripFormingCandle()` applied. | `getSpxBarsAt(getTfCache(directionTf), ts)` |
| `spxExitBars` | Closed bars from DB at `config.signals.exitTimeframe`. Same array as direction if same TF. | `getSpxBarsAt(getTfCache(exitTf), ts)` |
| `contractBars` | Closed bars from DB at `config.signals.signalTimeframe`. Already clean (candle builder only emits closed). | `getContractBarsAt(getTfCache(signalTf), ...)` |
| `positionPrices` | `PriceStream.getPrice(symbol)` — sub-second tick cache | Bar close at ts (= 1m resolution) |
| `spxPrice` | `PriceStream.getPrice('SPX')` — live tick | Last SPX bar close at ts |
| `candidates` | Contract pool + `OptionStream.getPrice(symbol)` per contract — live tick prices | Contract bar close at ts |

**Key architectural point:** Candle data (`spxDirectionBars`, `spxExitBars`, `contractBars`) comes from the DB at the config's timeframe — already aggregated and with indicators computed. Tick data (`positionPrices`, `spxPrice`, `candidates`) comes from the streaming tick cache for sub-second freshness. Signal decisions are candle-gated (deterministic). Position monitoring uses tick prices (as fast as possible).

**Data source divergence:** Replay uses Polygon backfill data (exchange-reported, clean 1m OHLCV). Live uses Tradier WebSocket streaming (real-time ticks aggregated into 1m candles). These are different data sources — the bars won't be byte-identical. But both are real tick-level data, and with streaming replacing the old 30s REST polling, the quality gap is as small as it can be. The remaining difference is inherent to any live-vs-backtest comparison: different feeds, different latencies, slightly different tick populations.

### strategy-engine.ts — The Orchestrator

```typescript
/**
 * Core position for the strategy engine. Minimal — no broker-specific fields.
 * The live agent wraps this with broker metadata (orderId, bracketId, etc).
 */
interface CorePosition {
  id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTs: number;
  highWaterPrice: number;
}

/**
 * Strategy state — owned and persisted by the caller.
 * Passed into tick() each cycle. tick() does NOT mutate this.
 *
 * Direction and exit HMA crosses are tracked separately because the config
 * may use different timeframes for each (e.g., 3m direction, 5m exit).
 */
interface StrategyState {
  positions: Map<string, CorePosition>;   // open positions (keyed by symbol)
  // Direction HMA state (entry gating — from directionTimeframe)
  directionCross: Direction | null;       // last direction cross direction
  prevDirectionHmaFast: number | null;
  prevDirectionHmaSlow: number | null;
  lastDirectionBarTs: number | null;      // dedup: only fire once per closed candle
  // Exit HMA state (signal reversal — from exitTimeframe)
  exitCross: Direction | null;            // last exit cross direction
  prevExitHmaFast: number | null;
  prevExitHmaSlow: number | null;
  lastExitBarTs: number | null;
  // Trade state
  lastEntryTs: number;                    // for cooldown enforcement
  dailyPnl: number;                       // running total, updated by caller after fills
  tradesCompleted: number;                // running count, updated by caller after fills
}

/**
 * Market data snapshot for one tick cycle.
 *
 * KEY DISTINCTION: Two types of price data serve different purposes.
 *
 * CLOSED CANDLES (spxBars, contractBars):
 *   Complete 1m OHLCV bars with final indicator values.
 *   Used for: HMA cross detection, signal detection, entry decisions.
 *   Source (live): For SPX, fetched from data service /spx/bars then stripFormingCandle() applied.
 *     For options, OptionCandleBuilder closes candle on minute boundary → indicators computed →
 *     upsertBars() → available from DB. The forming candle lives ONLY inside OptionCandleBuilder
 *     internal state and is never exposed to tick().
 *   Source (replay): Bar cache lookup at timestamp — all bars are already closed.
 *   MUST contain only closed candles. tick() uses bars[bars.length - 1] as the last closed candle.
 *
 * LIVE TICK PRICES (positionPrices, spxPrice, candidates[].price):
 *   Most recent trade/quote price for each symbol.
 *   Used for: SL/TP monitoring (positionPrices), OTM distance calculation (spxPrice),
 *     contract price band filtering and position sizing (candidates[].price).
 *   Source (live): PriceStream.getPrice() for SPX and open positions (HTTP streaming, sub-second).
 *     OptionStream.prices for contract pool candidates (WebSocket streaming, sub-second).
 *   Source (replay): Bar close price at current timestamp (same as candle close — collapses to one value).
 *   These are intentionally MORE FREQUENT than candle closes in live — a position can hit SL
 *   between candle closes and we want to catch it immediately, not wait for the next bar.
 *
 * THE FORMING CANDLE PROBLEM:
 *   The data service /spx/bars endpoint returns all bars including the currently forming candle.
 *   This forming candle has unstable HMA values that change every poll cycle (10-30s). If passed
 *   to tick(), a cross might appear mid-candle on partial data, then disappear at candle close.
 *   The live caller MUST call stripFormingCandle() to remove the last bar if its timestamp
 *   is >= the current minute floor. Replay has no forming candle (all bars are historical).
 *   See "Forming Candle Problem" section for the stripFormingCandle() implementation.
 *
 *   For options: OptionCandleBuilder handles this internally — it only emits closed candles
 *   via its onClose callback. The forming candle is never written to DB or exposed via API.
 *   So contractBars from the DB are already clean. No stripping needed.
 */
interface TickInput {
  ts: number;                              // current unix seconds

  // ── CLOSED CANDLE DATA (for signal detection) ──
  /** SPX bars on the DIRECTION timeframe (config.signals.directionTimeframe).
   *  CLOSED candles only. Live: stripFormingCandle() applied.
   *  Used for HMA cross entry gating. */
  spxDirectionBars: CoreBar[];
  /** SPX bars on the EXIT timeframe (config.signals.exitTimeframe).
   *  CLOSED candles only. Used for HMA cross exit reversal detection.
   *  Same array as spxDirectionBars when config uses the same TF for both. */
  spxExitBars: CoreBar[];
  /** Option contract bars on the SIGNAL timeframe (config.signals.signalTimeframe).
   *  CLOSED candles only. Already clean from DB (OptionCandleBuilder only emits closed). */
  contractBars: Map<string, CoreBar[]>;

  // ── LIVE TICK DATA (for position monitoring + strike selection) ──
  spxPrice: number;                        // current SPX price — live: PriceStream tick cache; replay: last bar close
  closeCutoffTs: number;                   // EOD cutoff in unix seconds
  candidates: StrikeCandidate[];           // contracts with LIVE tick prices. Live: pool + OptionStream.prices; replay: bar close prices
  positionPrices: Map<string, number>;     // LIVE tick price per open position. Live: PriceStream.getPrice(); replay: bar close
}

/**
 * tick() output — decisions only, no side effects.
 */
interface TickResult {
  /** Positions to exit this tick, in priority order. */
  exits: Array<{
    positionId: string;
    symbol: string;
    reason: ExitReason;
    decisionPrice: number;         // price tick() used to make the decision
    pnl: { pnlPct: number; pnl$: number };  // estimated P&L at decisionPrice
    flipTo: 'call' | 'put' | null; // non-null if exit.strategy=scannerReverse
  }>;

  /** Position to enter this tick, or null. */
  entry: {
    symbol: string;
    side: 'call' | 'put';
    strike: number;
    price: number;                 // decision price (replay fills here; live fills at broker price)
    qty: number;
    stopLoss: number;
    takeProfit: number;
    direction: Direction;
    reason: string;
  } | null;

  /** Updated direction HMA state (caller must persist). */
  directionState: {
    directionCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
    freshCross: boolean;           // true if a new cross fired this tick
  };

  /** Updated exit HMA state (caller must persist). */
  exitState: {
    exitCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
  };

  /** Why no entry was made (for logging/debugging). */
  skipReason: string | null;
}
```

### tick() decision sequence

`tick()` runs the following steps in this exact order. It is deterministic — same inputs produce same outputs.

**Step 1: Detect SPX HMA crosses** (uses CLOSED candles only)

Two crosses are tracked independently because the config may use different timeframes for each:

**Step 1a: Direction cross** (from `input.spxDirectionBars`)
- Get the last bar from `input.spxDirectionBars` — the most recent closed candle at the direction timeframe
- **Caller contract:** all bars MUST be closed candles. The caller strips the forming candle (live) or provides only historical bars (replay). tick() uses `bars[bars.length - 1]` as the last closed candle.
- Read HMA fast/slow values from the bar's indicators (keys from `config.signals.hmaCrossFast`/`hmaCrossSlow`)
- Compare to `state.prevDirectionHmaFast` / `state.prevDirectionHmaSlow` to detect crossover
- If `state.lastDirectionBarTs === closedBar.ts`: no-op (already processed this candle)
- Output: updated `directionState` in result, `freshCross: true` if cross detected
- This cross **gates entry decisions** (step 6)

**Step 1b: Exit cross** (from `input.spxExitBars`)
- Same logic as 1a but against `state.prevExitHmaFast` / `state.prevExitHmaSlow`
- When config uses the same TF for direction and exit, the caller passes the same bars array and this produces the same result — slightly redundant but correct
- This cross **triggers signal_reversal exits** (step 2)

**Step 2: Check exits for all open positions** (uses LIVE tick prices + exit cross)
- For each position in `state.positions`:
  - Get current price from `input.positionPrices` — the **latest tick price**, not a bar close
  - If no price available: skip price-dependent exits (SL/TP), but still check time exits and signal reversal
  - Update high-water mark (tracked in returned exit, caller applies)
  - Call `checkExit(position, currentPrice, config, context)` from `src/core/`
  - `context.hmaCrossDirection` = `exitState.exitCross` (the exit-timeframe cross, not the direction cross)
  - If exit: add to `result.exits` with `flipTo` if strategy is `scannerReverse`
- Exits are returned regardless of whether entry is possible

**Step 3: Risk guard** (only if considering entry)
- Call `isRiskBlocked()` with current state counts
- `openPositions`: `state.positions.size` MINUS positions being exited this tick
- `tradesCompleted`: `state.tradesCompleted`
- `dailyPnl`: `state.dailyPnl`
- If blocked: `result.entry = null`, `result.skipReason = reason`

**Step 4: Time window gate**
- Convert `input.ts` to ET `HH:MM`
- Check against `config.timeWindows.activeStart` / `activeEnd`
- If outside: `result.entry = null`, `result.skipReason = 'outside active window'`
- Note: exits (step 2) still happen outside the window — we always protect capital

**Step 5: Cooldown gate**
- Compute elapsed = `input.ts - state.lastEntryTs`
- If elapsed < `config.judges.escalationCooldownSec`: skip entry
- `result.skipReason = 'cooldown (Xs remaining)'`

**Step 6: Entry decision** (only runs if steps 3-5 all pass)

Three entry triggers, checked in priority order:

a) **Flip-on-reversal**: If step 2 produced exits with `flipTo !== null`:
   - Direction = the flip direction (opposite of exited position)
   - Don't require a fresh direction cross — the exit reversal IS the signal

b) **Fresh direction cross**: If step 1a detected a new cross (`directionState.freshCross === true`) and no position is open in `state.positions` (after removing positions being exited this tick):
   - Direction = `directionState.directionCross`

c) **No entry trigger**: If neither (a) nor (b), `result.entry = null`

When an entry trigger fires:
- If `config.signals.requireUnderlyingHmaCross` and `directionState.directionCross` is null: skip
- Determine side: bullish → call, bearish → put
- Call `selectStrike()` on `input.candidates` with the direction
  - **Candidates carry live tick prices**, not bar close prices. In live, this means the contract prices used for OTM distance calculation and price band filtering ($0.20–$8.00) come from the OptionStream tick cache (sub-second freshness). In replay, these are bar close prices (same as candle close — no difference in resolution).
  - **Candidates come from the pre-built contract pool** (live) or the bar cache (replay). In live, the pool is built once at ~9:15 ET from `OptionStream.buildContractPool(esPrice)` — ~160 symbols covering ±100 pts × calls/puts × 2 expiries. No chain polling or incremental discovery needed at trade time. In replay, candidates are built from contracts with bars at the current timestamp.
  - **`spxPrice` is used for OTM distance**: `selectStrike()` computes distance as `|candidate.strike - spxPrice|`. In live, `spxPrice` comes from the PriceStream tick cache, so the OTM distance is computed against the live SPX price, not the last closed candle's close.
- If no qualifying strike found: `result.entry = null`, `result.skipReason = 'no qualifying contract'`
- Compute effective entry via `frictionEntry(price)`
- Compute SL: `effectiveEntry * (1 - config.position.stopLossPercent / 100)`
- Compute TP: `effectiveEntry * config.position.takeProfitMultiplier`
- Compute qty: `computeQty(effectiveEntry, config)`
- Return the entry decision

> **Note on detectSignals():** The current plan has tick() calling `detectSignals()` on `contractBars` to find option-level HMA/RSI crosses as a confirmation step. In practice, the live agents run with `requireUnderlyingHmaCross: true` and option-level signal detection disabled — the SPX HMA cross alone gates entry, and `selectStrike()` picks the best contract by price/distance. If we later re-enable option-level signals, `contractBars` provides the closed candle data needed. For now, `selectStrike()` on `candidates` is the entry path.

**Step 7: Return result** — no state mutation, no side effects.

### What tick() does NOT do:
- Mutate `StrategyState` (caller does this after execution)
- Submit orders or interact with any broker
- Fetch prices or read from any database
- Know about Tradier, OTOCO brackets, paper mode, or WebSocket
- Handle order rejections, partial fills, or slippage
- Enforce market hours (caller's responsibility)
- Know whether it's running in replay or live
- Know whether prices came from a WebSocket stream or a bar cache

## Integration: Replay

### Current replay architecture (what tick() replaces)

The replay machine (`src/replay/machine.ts`) currently has all decision logic **inline** in the main `for (const ts of timestamps)` loop:

```
loadBarCache() → all SPX + contract 1m bars into memory (binary search per TF)
  ↓
for each 1m timestamp:
  1. getSpxBarsAt(directionCache, ts)    → HMA cross on direction timeframe → spxDirectionCross
     getSpxBarsAt(exitCache, ts)         → HMA cross on exit timeframe → spxExitCross
  2. for each openPosition:
       getPosPriceAt(cache1m, ...)       → bar close price at ts
       checkExit() from core             → SL/TP/reversal/time exit (uses spxExitCross)
       if signal_reversal → flip         → inline strike selection + entry (DIFFERENT from step 7)
  3. detectSignals() from core           → option contract HMA/RSI/EMA crosses (on signalCache TF)
  4. filter by OTM distance, price, underlying HMA requirement, KC gate, regime
  5. isRiskBlocked() from core           → max positions, trades, daily loss, cooldown
  6. escalation pipeline                 → signal+scanner→judge (or auto-buy if no judges)
  7. open position inline                → computeQty, frictionEntry, push to openPositions map
```

**Problems this creates:**
- Step 2 flip uses **different strike selection code** than step 7 entry (inline distance-based loop vs `selectStrike()`)
- Position keys use `${symbol}_${ts}` in the flip path, `symbol` alone in the entry path — flip allows duplicate entries for the same contract
- HMA cross detection is inline (not the same code path as live agent's `updateHmaCross()`)
- Escalation pipeline (steps 3-4-6) doesn't exist in the live agent — it goes HMA cross → `selectStrike()` → enter
- Risk guard is checked AFTER signal detection — wasted compute on signals that get blocked
- Direction and exit HMA crosses are tracked separately on potentially different timeframes, but the live agent collapses them into one `hmaCrossDirection`

### Config is the source of truth

The whole point of this plan is: **test in replay → deploy to live with confidence.** That means the live agent must execute the exact same `Config` object that was backtested. Not a hand-maintained copy in `agent-config.ts` — the same config, loaded from the DB.

**Today's problem:** `agent-config.ts` is a hand-maintained Config that diverges from backtested configs. The agent code also ignores config fields it should respect (e.g., `directionTimeframe`, `exitTimeframe`). This breaks the replay→live contract: a config validated in replay doesn't execute the same way in live.

**The fix:** The live agent loads its config from the DB by ID. You select the config you want to run live, and the agent executes it exactly as replay did. `agent-config.ts` is deleted.

```
Replay:     Config from DB (--config-id=hma3x17-undhma-otm15-tp14x-sl70)
              → tick() executes exactly this config
              → Produces 2,862 trades, $2M P&L across 249 days

Live agent: SAME Config loaded from DB by ID
              → tick() executes exactly this config
              → Same signals, same exits, same strike selection
              → Only difference: real fills vs instant fills
```

### Multi-timeframe support

The `Config.signals` type has 7 timeframe fields: `signalTimeframe`, `directionTimeframe`, `exitTimeframe`, plus per-signal overrides. The replay system already supports all of them. Over 500 MTF configs have been backtested in parameter sweeps (`sw2-*`, `sw3-*`, `sw4-*`, `sweep-*` with combinations of `3md3me`, `3md5me`, `5md3me`, `5md5me`). This is not aspirational — it's active research.

**tick() must support MTF because any config you select for live must execute exactly as it did in replay.** If you choose `sweep-f5s19-3md5me-sl80-tp5` (HMA 5×19, 3m direction, 5m exit, SL 80%, TP 5×), the live agent needs to execute it exactly as replay did.

**The direction/exit split:** The replay machine tracks two separate HMA crosses:
- `spxDirectionCross` — on `directionTimeframe` (e.g., `3m`) — gates entry decisions
- `spxExitCross` — on `exitTimeframe` (e.g., `5m`) — triggers `signal_reversal` exits

These can be on different timeframes. tick() needs both.

**Updated TickInput for MTF:**

```typescript
interface TickInput {
  ts: number;
  /** SPX bars on the DIRECTION timeframe — for HMA cross entry gating */
  spxDirectionBars: CoreBar[];
  /** SPX bars on the EXIT timeframe — for HMA cross exit reversal.
   *  Same as spxDirectionBars when config uses the same TF for both. */
  spxExitBars: CoreBar[];
  /** Option contract bars on the SIGNAL timeframe — for detectSignals() */
  contractBars: Map<string, CoreBar[]>;
  spxPrice: number;
  closeCutoffTs: number;
  candidates: StrikeCandidate[];
  positionPrices: Map<string, number>;
}
```

**Updated StrategyState for MTF:**

```typescript
interface StrategyState {
  positions: Map<string, CorePosition>;
  // Direction HMA state (entry gating)
  directionCross: Direction | null;
  prevDirectionHmaFast: number | null;
  prevDirectionHmaSlow: number | null;
  lastDirectionBarTs: number | null;
  // Exit HMA state (signal reversal)
  exitCross: Direction | null;
  prevExitHmaFast: number | null;
  prevExitHmaSlow: number | null;
  lastExitBarTs: number | null;
  // Trade state
  lastEntryTs: number;
  dailyPnl: number;
  tradesCompleted: number;
}
```

**Updated TickResult:**

```typescript
interface TickResult {
  exits: Array<{ ... }>;
  entry: { ... } | null;
  /** Direction HMA state (caller must persist) */
  directionState: {
    directionCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
    freshCross: boolean;
  };
  /** Exit HMA state (caller must persist) */
  exitState: {
    exitCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
  };
  skipReason: string | null;
}
```

**tick() Step 1 becomes two sub-steps:**
- 1a: Detect direction cross from `spxDirectionBars` → used for entry gating (step 6)
- 1b: Detect exit cross from `spxExitBars` → used for `signal_reversal` exit (step 2)

When the config uses the same TF for both (most common), the caller passes the same bars array for both fields. tick() processes them independently — slightly redundant but correct and simple.

**The 1m bar universe is the foundation. Everything else is derived from it.**

The data service builds 1m candles with a full indicator battery (HMA 3/5/15/17/19/25, EMA 9/21, RSI 14, BB, ATR, VWAP, KC, plus tier 2). These 1m bars are the single source of truth — stored in the DB, served over the API, and used by both replay and live.

When a config needs a higher timeframe (3m direction, 5m exit, etc.), the caller:
1. Takes the 1m bars
2. Aggregates OHLCV into the target period (proper open/high/low/close, not sampled)
3. Runs `computeIndicators()` on the aggregated bars to get HMA/RSI/etc. at that timeframe
4. Passes the result to tick()

```
                    1m bar universe (data service)
                    ├── HMA 3/5/15/17/19/25
                    ├── EMA 9/21, RSI 14, BB, ATR, VWAP, KC
                    └── stored in DB, served via /spx/bars
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         config: 1m      config: 3m      config: 5m
         (pass through)  (aggregate)     (aggregate)
              │               │               │
              ▼               ▼               ▼
         1m bars with    3m OHLCV with   5m OHLCV with
         1m indicators   3m indicators   5m indicators
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                          tick()
```

This is already how replay works — `loadBarCache()` loads pre-aggregated bars from the DB at the config's timeframe, and `ensureHmaPeriods()` computes any missing HMA periods from close prices. The live agent needs to do the same thing: aggregate from 1m, compute indicators on the result.

The pipeline aggregator (`src/pipeline/aggregator.ts`) already builds proper OHLCV from 1m bars. The indicator engine (`src/core/indicator-engine.ts`) already tracks state per-symbol/per-timeframe. The pieces exist — they just need to be wired through the live agent's data path.

> **Bug to fix:** The live market feed's `aggregate()` in `market-feed.ts` copies the last 1m bar's indicator values to the aggregated bar — this is **wrong**. HMA(3) on 3m bars is computed from 3m close prices, not the HMA(3) from the last 1m bar in the window. The live path must use proper aggregation + indicator recomputation, same as replay.

**How the caller resolves timeframes:**

```
Replay caller:
  // Bars at each TF are pre-loaded from DB (already aggregated + indicators computed)
  const dirBars = getSpxBarsAt(getTfCache(config.signals.directionTimeframe), ts);
  const exitTf = config.signals.exitTimeframe || config.signals.directionTimeframe;
  const exitBars = (exitTf === config.signals.directionTimeframe)
    ? dirBars
    : getSpxBarsAt(getTfCache(exitTf), ts);

Live caller:
  // Start from 1m bars, aggregate + compute indicators for each config TF
  const bars1m = stripFormingCandle(closedSpxBars);
  const dirBars = aggregateWithIndicators(bars1m, config.signals.directionTimeframe);
  const exitTf = config.signals.exitTimeframe || config.signals.directionTimeframe;
  const exitBars = (exitTf === config.signals.directionTimeframe)
    ? dirBars
    : aggregateWithIndicators(bars1m, exitTf);
```

### What tick() replaces vs what stays

```
DETERMINISTIC MODE (judges=0, scanners=off):   NON-DETERMINISTIC MODE:
  tick() handles everything:                     tick() handles exits + HMA cross
    - HMA cross detection                        Scanner/judge pipeline handles entry
    - Position exit monitoring                    tick() returns exits + directionState/exitState
    - Risk/time/cooldown gates                   Caller uses exits but ignores entry
    - Strike selection via selectStrike()        Judge picks target symbol
    - Entry decision                             Entry path still diverges from live
  One code path, same as live agent
```

**For this plan, we focus on deterministic mode.** The live agents run deterministic (no scanners, no judges). The scanner/judge pipeline stays in `machine.ts` for research configs but is outside the scope of replay↔live parity.

### Branch point in runReplay()

```typescript
// After bar cache loading, HMA/KC computation, timestamps built...

const isDeterministic = !config.scanners.enabled && judges.length === 0;

if (isDeterministic) {
  // ── tick()-based loop — same code path as live agent ──
  const { trades: deterministicTrades } = runDeterministicReplay(
    config, cache1m, timestamps, CLOSE_CUTOFF, SYMBOL_FILTER
  );
  trades.push(...deterministicTrades);
} else {
  // ── Legacy pipeline — scanners, judges, regime, MTF ──
  // (existing code stays as-is for research)
  ...existing inline loop...
}
```

This keeps the existing scanner/judge pipeline working for research while routing deterministic configs through the `tick()`-based path.

### runDeterministicReplay() — the tick() loop

```typescript
function runDeterministicReplay(
  config: ReplayConfig,
  tfCacheMap: Map<string, BarCache>,  // pre-loaded caches per timeframe
  cache1m: BarCache,                   // 1m cache (always loaded — for prices + candidates)
  timestamps: number[],               // 1m timestamps (iteration granularity)
  closeCutoffTs: number,
  symbolFilter: string,
): { trades: Trade[] } {
  const trades: Trade[] = [];
  const state: StrategyState = createInitialState();
  const strikeRange = config.strikeSelector.strikeSearchRange;

  // Resolve timeframes from config
  const dirTf = config.signals.directionTimeframe || '1m';
  const exitTf = config.signals.exitTimeframe || dirTf;
  const signalTf = config.signals.signalTimeframe || '1m';
  const dirCache = tfCacheMap.get(dirTf) ?? cache1m;
  const exitCache = (exitTf === dirTf) ? dirCache : (tfCacheMap.get(exitTf) ?? cache1m);
  const signalCache = tfCacheMap.get(signalTf) ?? cache1m;

  for (const ts of timestamps) {
    // ── Resolve bars at each config timeframe ──
    // All bars in the cache are already closed (no forming candle in replay)
    const spxDirBars = getSpxBarsAt(dirCache, ts);
    if (spxDirBars.length < 5) continue;
    const spxExitBars = (exitTf === dirTf) ? spxDirBars : getSpxBarsAt(exitCache, ts);

    // SPX price from 1m cache (finest granularity, for OTM distance + position prices)
    const spx1m = getSpxBarsAt(cache1m, ts);
    const spxPrice = spx1m.length > 0 ? spx1m[spx1m.length - 1].close : spxDirBars[spxDirBars.length - 1].close;

    // Contract bars at the signal timeframe
    const contractBars = getContractBarsAt(signalCache, spxPrice, strikeRange, ts);

    // Position prices from 1m cache (bar close = "tick price" in replay)
    const positionPrices = new Map<string, number>();
    for (const [, pos] of state.positions) {
      const price = getPosPriceAt(cache1m, pos.side, pos.strike, symbolFilter, ts);
      if (price != null) positionPrices.set(pos.symbol, price);
    }

    // Strike candidates from 1m cache (finest price resolution)
    const candidates: StrikeCandidate[] = [];
    for (const [sym, bars] of getContractBarsAt(cache1m, spxPrice, strikeRange, ts)) {
      if (bars.length === 0) continue;
      const strike = cache1m.contractStrikes.get(sym);
      if (strike == null) continue;
      const parsed = parseOptionSymbol(sym);
      if (!parsed) continue;
      candidates.push({
        symbol: sym,
        side: parsed.isCall ? 'call' : 'put',
        strike,
        price: bars[bars.length - 1].close,
        volume: bars[bars.length - 1].volume,
      });
    }

    // ── Call tick() — same function the live agent calls ──
    const result = tick(state, {
      ts,
      spxDirectionBars: spxDirBars as CoreBar[],
      spxExitBars: spxExitBars as CoreBar[],
      contractBars: contractBars as Map<string, CoreBar[]>,
      spxPrice,
      closeCutoffTs,
      candidates,
      positionPrices,
    }, config);

    // ── Apply HMA state (always, even if no trades) ──
    state.directionCross = result.directionState.directionCross;
    state.prevDirectionHmaFast = result.directionState.prevHmaFast;
    state.prevDirectionHmaSlow = result.directionState.prevHmaSlow;
    state.lastDirectionBarTs = result.directionState.lastBarTs;
    state.exitCross = result.exitState.exitCross;
    state.prevExitHmaFast = result.exitState.prevHmaFast;
    state.prevExitHmaSlow = result.exitState.prevHmaSlow;
    state.lastExitBarTs = result.exitState.lastBarTs;

    // ── Apply exits (instant fill at decision price) ──
    for (const exit of result.exits) {
      const pos = state.positions.get(exit.positionId)!;
      trades.push({
        symbol: pos.symbol, side: pos.side, strike: pos.strike, qty: pos.qty,
        entryTs: pos.entryTs, entryET: etLabel(pos.entryTs), entryPrice: pos.entryPrice,
        exitTs: ts, exitET: etLabel(ts), exitPrice: exit.decisionPrice,
        reason: exit.reason, pnlPct: exit.pnl.pnlPct, pnl$: exit.pnl['pnl$'],
        signalType: '',
      });
      state.positions.delete(exit.positionId);
      state.dailyPnl += exit.pnl['pnl$'];
      state.tradesCompleted++;
    }

    // ── Apply entry (instant fill at decision price) ──
    if (result.entry) {
      state.positions.set(result.entry.symbol, {
        id: result.entry.symbol,
        symbol: result.entry.symbol,
        side: result.entry.side,
        strike: result.entry.strike,
        qty: result.entry.qty,
        entryPrice: result.entry.price,
        stopLoss: result.entry.stopLoss,
        takeProfit: result.entry.takeProfit,
        entryTs: ts,
        highWaterPrice: result.entry.price,
      });
      state.lastEntryTs = ts;
    }
  }

  // ── EOD: force-close any remaining positions ──
  const finalTs = timestamps[timestamps.length - 1];
  for (const [, pos] of state.positions) {
    const curPrice = getPosPriceAt(cache1m, pos.side, pos.strike, symbolFilter, finalTs) ?? pos.entryPrice;
    const { pnlPct, 'pnl$': pnl$ } = computeRealisticPnl(pos.entryPrice, curPrice, pos.qty);
    trades.push({
      symbol: pos.symbol, side: pos.side, strike: pos.strike, qty: pos.qty,
      entryTs: pos.entryTs, entryET: etLabel(pos.entryTs), entryPrice: pos.entryPrice,
      exitTs: finalTs, exitET: etLabel(finalTs), exitPrice: curPrice,
      reason: 'time_exit', pnlPct, pnl$, signalType: '',
    });
  }

  return { trades };
}
```

### Replay price model and known divergence

In replay, every price lookup returns a bar close — there's no distinction between "closed candle OHLCV" and "latest tick". The bar close at timestamp `ts` IS the tick price at that moment.

The key consequence: **replay checks SL/TP once per minute (on bar close), while live checks sub-second (on every tick).** This creates a systematic divergence:

| Scenario | Replay behavior | Live behavior | Divergence |
|----------|----------------|---------------|------------|
| Price spikes past TP then reverts within the minute | Replay sees bar close (post-revert), may miss TP | Live catches TP at the spike | Replay **under-reports** TP wins |
| Price drops past SL then recovers within the minute | Replay sees bar close (post-recovery), may miss SL | Live catches SL at the drop | Replay **under-reports** SL losses |
| Price gaps through SL on bar open | Replay exits at bar close (better than SL) | Live exits at first tick past SL (worse slippage) | Replay **optimistic** on gap losses |

Net effect: replay slightly underestimates both wins and losses that happen intra-minute. For the HMA cross strategy where trades last 5-60 minutes, most exits happen on candle-close events (signal reversal, time exit) not price targets, so this divergence is small in practice.

### What stays in machine.ts (not replaced by tick())

- **Bar cache loading** — `loadBarCache()`, `ensureHmaPeriods()`, `ensureKcFields()`
- **Multi-timeframe support** — `getTfCache()`, per-signal-type TF overrides (used by legacy pipeline only)
- **Scanner/judge pipeline** — for non-deterministic configs (when scanners/judges enabled)
- **Regime classification** — `classify()`, `isRegimeBlocked()` (disabled in live, but kept for research)
- **Metrics computation** — `computeMetrics()`, result storage
- **`runReplay()` orchestration** — session timestamps, DB access, result persistence

**Replay makes no assumptions about order execution. tick() says enter at $5.60, replay records $5.60.** Friction model (half-spread + commission) is already baked into `frictionEntry()` / `computeRealisticPnl()` for P&L calculation.

## Integration: Live Agent

```typescript
// In agent.ts — replace runCycle() internals

// ── Config: loaded from DB — same config that was validated in replay ──
const config = store.getConfig(process.env.AGENT_CONFIG_ID || 'hma3x17-undhma-otm15-tp14x-sl70');

// Resolve timeframes from config (used throughout the cycle)
const dirTf = config.signals.directionTimeframe || '1m';
const exitTf = config.signals.exitTimeframe || dirTf;
const signalTf = config.signals.signalTimeframe || '1m';

// State loaded from session file on startup, persisted after each cycle
let state: StrategyState = loadSessionState() ?? createInitialState();

async function runCycle() {
  // ── 0. Reconcile with broker BEFORE making decisions ──
  await reconcileWithBroker(state);

  // ── 1. Fetch market data ──
  const snap = await fetchMarketSnapshot();
  // snap.spx.bars1m → closed + forming 1m candles from data service

  // ── 2. Build tick input ──

  // Strip forming candle, then aggregate 1m → config timeframes
  // Data service stores bars at all TFs (1m, 3m, 5m, etc.) with indicators.
  // We fetch at the config's timeframe directly from the API/DB.
  const bars1m = stripFormingCandle(snap.spx.bars1m.map(toCoreBar));
  const spxDirBars = (dirTf === '1m') ? bars1m : fetchBarsAtTf('SPX', dirTf);
  const spxExitBars = (exitTf === dirTf) ? spxDirBars
    : (exitTf === '1m') ? bars1m : fetchBarsAtTf('SPX', exitTf);

  // Contract bars at signal timeframe (already closed — candle builder only emits closed)
  const contractBars = fetchContractBarsAtTf(snap.contracts, signalTf);

  // Candidates: pre-built pool + LIVE tick prices from OptionStream
  const candidates = buildCandidatesFromPool(optionStream);

  // Position prices: LIVE tick prices from PriceStream (sub-second)
  const positionPrices = new Map<string, number>();
  for (const [, pos] of state.positions) {
    const cached = priceStream.getPrice(pos.symbol);
    if (cached) positionPrices.set(pos.symbol, cached.last);
  }

  // SPX price: LIVE tick from PriceStream
  const spxLive = priceStream.getPrice('SPX');
  const spxPrice = spxLive?.last ?? bars1m[bars1m.length - 1]?.close ?? 0;

  // ── 3. Get decisions from tick() ──
  const result = tick(state, {
    ts: Math.floor(Date.now() / 1000),
    spxDirectionBars: spxDirBars,
    spxExitBars,
    contractBars,
    spxPrice,
    closeCutoffTs: computeCloseCutoff(),
    candidates,
    positionPrices,
  }, config);

  // ── 4. Apply HMA state (always, even if no trades) ──
  state.directionCross = result.directionState.directionCross;
  state.prevDirectionHmaFast = result.directionState.prevHmaFast;
  state.prevDirectionHmaSlow = result.directionState.prevHmaSlow;
  state.lastDirectionBarTs = result.directionState.lastBarTs;
  state.exitCross = result.exitState.exitCross;
  state.prevExitHmaFast = result.exitState.prevHmaFast;
  state.prevExitHmaSlow = result.exitState.prevHmaSlow;
  state.lastExitBarTs = result.exitState.lastBarTs;

  // ── 5. Execute exits FIRST — must confirm before entries ──
  let allExitsSucceeded = true;
  for (const exit of result.exits) {
    const pos = state.positions.get(exit.positionId);
    if (!pos) continue;

    // 5a. Cancel OTOCO bracket legs if present
    if (pos.bracketOrderId) {
      await cancelOcoLegs(pos.bracketOrderId);
    }

    // 5b. Submit sell order
    const sellResult = await submitSellOrder(pos);

    if (sellResult.filled) {
      const realPnl = computeRealisticPnl(pos.entryPrice, sellResult.fillPrice, pos.qty);
      state.positions.delete(exit.positionId);
      state.dailyPnl += realPnl['pnl$'];
      state.tradesCompleted++;
      logAuditExit(pos, sellResult.fillPrice, exit.reason, realPnl);
    } else if (sellResult.rejected) {
      console.error(`[agent] Exit rejected for ${pos.symbol}: ${sellResult.reason}`);
      allExitsSucceeded = false;
    } else if (sellResult.timeout) {
      pos.pendingExitOrderId = sellResult.orderId;
      allExitsSucceeded = false;
    }
  }

  // ── 6. Execute entry ONLY if all exits succeeded ──
  if (result.entry && allExitsSucceeded) {
    if (state.positions.size >= (config.position.maxPositionsOpen ?? 1)) {
      console.log(`[agent] Skipping entry — still at max positions after exits`);
    } else {
      const quote = await fetchContractQuote(result.entry.symbol);
      const orderType = chooseOrderType(quote.bid, quote.ask);
      const buyResult = await submitBuyOrder(result.entry, orderType);

      if (buyResult.filled) {
        const actualEntry = frictionEntry(buyResult.fillPrice);
        const actualSL = actualEntry * (1 - config.position.stopLossPercent / 100);
        const actualTP = actualEntry * config.position.takeProfitMultiplier;

        const pos: CorePosition = {
          id: result.entry.symbol,
          symbol: result.entry.symbol,
          side: result.entry.side,
          strike: result.entry.strike,
          qty: result.entry.qty,
          entryPrice: buyResult.fillPrice,
          stopLoss: actualSL,
          takeProfit: actualTP,
          entryTs: Math.floor(Date.now() / 1000),
          highWaterPrice: buyResult.fillPrice,
        };
        state.positions.set(pos.id, pos);
        state.lastEntryTs = pos.entryTs;

        if (!config.execution?.disableBracketOrders) {
          const bracket = await submitOtocoBracket(pos, actualTP, actualSL);
          pos.bracketOrderId = bracket.orderId;
        }

        logAuditEntry(pos, buyResult);
      } else if (buyResult.rejected) {
        console.error(`[agent] Entry rejected: ${buyResult.reason}`);
      } else if (buyResult.timeout) {
        const pendingPos = { ...result.entry, pendingFill: true, orderId: buyResult.orderId };
        state.positions.set(pendingPos.symbol, pendingPos as any);
        state.lastEntryTs = Math.floor(Date.now() / 1000);
      }
    }
  }

  // ── 7. Persist state ──
  saveSession(state);
}
```

## Forming Candle Problem

The #1 divergence risk between replay and live.

**Replay:** Every bar in the cache is a completed candle at its timeframe. HMA values are final.

**Live:** The data service stores closed candles via `upsertBars()` — the candle builder's internal forming candle is never written to DB. However, the `/spx/bars` REST endpoint returns bars from the DB which may include a bar for the current minute if a previous poll cycle wrote a partial bar. The live caller MUST strip any bar whose timestamp is in the current forming period.

**The fix for 1m bars:** Strip the last bar if its timestamp is >= the current minute floor.

```typescript
function stripFormingCandle(bars: CoreBar[], periodSec: number = 60): CoreBar[] {
  if (bars.length === 0) return bars;
  const now = Math.floor(Date.now() / 1000);
  const currentPeriodStart = now - (now % periodSec);
  const lastBar = bars[bars.length - 1];
  if (lastBar.ts >= currentPeriodStart) {
    return bars.slice(0, -1);
  }
  return bars;
}
```

**For higher timeframes (3m, 5m):** The same principle applies but the period is larger. A 3m bar is "forming" for 3 minutes. The caller passes the period in seconds:
- `stripFormingCandle(bars1m, 60)` — strip if in current minute
- `stripFormingCandle(bars3m, 180)` — strip if in current 3-minute window
- `stripFormingCandle(bars5m, 300)` — strip if in current 5-minute window

**For option contract bars:** The `OptionCandleBuilder` only emits closed candles via its `onClose` callback. The forming candle lives in the builder's internal state and is never written to DB. So contract bars fetched from the DB are already clean — no stripping needed.

**tick() contract:** All bars in `spxDirectionBars`, `spxExitBars`, and `contractBars` MUST be closed candles. tick() uses `bars[bars.length - 1]` as the last closed candle. If a forming candle is included, HMA cross detection fires on unstable data and produces false signals.

## Data Quality: Streaming Options Contracts

### The Problem (Current — REST Polling)

Option contract bars differ between replay and live:

| Aspect | Replay (Polygon) | Live (Data Service — Current) |
|--------|------------------|-------------------------------|
| Source | Exchange-reported 1m OHLCV | Quote snapshots every 30s via `fetchBatchQuotes()`, aggregated into 1m candles |
| Gaps | None (Polygon fills all minutes) | 2-60 min gaps get linear interpolation (`synthetic: true`), >60 min flat fill (`stale`) |
| HMA stability | Computed on clean data | Computed on mix of real and synthetic bars — synthetic bars can create false HMA crosses |
| Volume | Real exchange volume | Estimated from session volume deltas |
| OHLC accuracy | True exchange OHLC | Open = first snapshot price in the minute. High/Low = max/min of 1-2 snapshots per minute (misses intra-minute extremes) |

This is the **single biggest source of replay↔live divergence**. With 30s polling, each 1-minute candle gets at most 2 price samples. That's not a candle — it's a connect-the-dots approximation. Real 0DTE options can swing 50% intra-minute; a 30s poll catches none of that.

### The Fix: Tradier WebSocket Streaming

Tradier provides a WebSocket streaming API (`wss://ws.tradier.com/v1/markets/events`) that pushes real-time `trade` and `quote` events for subscribed symbols. The data service already uses HTTP streaming for SPX via `PriceStream` (`src/agent/price-stream.ts`). We extend the same pattern to options contracts, but use WebSocket (not HTTP streaming) because:

1. **WebSocket allows symbol updates without reconnection** — just resend the subscription payload with the existing session ID
2. **One connection for all ~160 contracts** — Tradier doesn't publish hard symbol limits, just "ask for what you need"
3. **Sub-second price updates** — every trade and quote change is pushed, not polled

### Session Lifecycle

```
~9:15 ET — Agent wakes up
├── Fetch ES=F last price from data service (futures trading all night, tight SPX proxy)
├── Center = round(ES price) to nearest $5
├── Build contract pool:
│   ├── ±100 points from center = ±20 strikes at $5 intervals = 40 strikes
│   ├── × calls + puts = 80 contracts per expiry
│   ├── × 2 expiries (today 0DTE + tomorrow 1DTE) = ~160 contracts
│   └── + SPX underlying = ~161 symbols
├── POST /v1/markets/events/session → get sessionId (5-min TTL to connect)
├── Connect wss://ws.tradier.com/v1/markets/events
├── Send: { symbols: [...all 161], filter: ["trade","quote"], sessionid, linebreak: true }
└── Stream is live — pre-market CBOE GTH quotes start flowing in

9:30 ET — Bell rings
├── Volume floods in, trades arrive sub-second
├── Candle builder receives every tick → true 1m OHLCV
├── First complete candle closes at 9:31
├── By 9:35: 5 clean candles with real OHLCV
├── By 9:45 (activeStart): HMA has enough data for reliable signals

During the day (9:30–16:15)
├── Strike pool is FIXED — no reconnecting, no chasing contracts
├── SPX moves ±50 points? Still covered (pool is ±100)
├── Candle builder produces exchange-quality bars from tick data
├── Gaps virtually eliminated — if a contract trades, we see it instantly
└── Only truly illiquid far-OTM contracts might still gap (and we don't trade those)

4:15 ET — Close
├── Close the WebSocket connection
├── Expire today's 0DTE contracts
├── Persist any final bars
└── Done
```

**Why center on ES at 9:15?** ES futures have been trading all night and are a tight proxy for where SPX will open. The data service already tracks ES overnight via Yahoo. By 9:15 the overnight session is well-established. Building ±100 points of coverage means even a ±50 point gap-open is fully covered.

#### ES→SPX Offset: The Fair Value Basis

ES trades at a **premium** to SPX. This is structural — it reflects the cost of carry (risk-free rate × days to futures expiry). From our data (10 trading days, Mar 17–Apr 1, 2026):

```
Close-to-close spread (ES - SPX):
  Mean:    48.73 pts
  Median:  45.73 pts
  Stdev:   12.94 pts
  Range:   32.65 – 68.02 pts

Intraday spread at matching timestamps:
  Mean:    52.35 pts (3,994 samples across all days)
  P25:     43.43 pts
  P75:     54.50 pts
```

The spread is **not fixed** — it shrinks ~0.56 pts/day as ES approaches quarterly expiry (June 19, 2026). This is the futures basis decaying:

```
ES basis ≈ SPX × risk_free_rate × (DTE / 365)
         ≈ 6,500 × 0.0313 × (DTE / 365)
         ≈ 0.56 × DTE

At 80 DTE (early April): ~45 pts
At 60 DTE (late April):  ~34 pts  
At 40 DTE (mid May):     ~22 pts
At 20 DTE (early June):  ~11 pts
```

**Recommended formula for pool centering:**

```typescript
function estimateSpxFromES(esPrice: number): number {
  // Use previous day's close spread if available (MAE: 10.73 pts)
  // Otherwise use fair value model (MAE: ~17 pts)
  const prevCloseSpread = getPreviousCloseSpread(); // from DB
  if (prevCloseSpread !== null) {
    return esPrice - prevCloseSpread;
  }
  
  // Fallback: fair value model
  // ES quarterly expiry = third Friday of current quarter's last month
  const daysToExpiry = getDaysToESExpiry();
  const basis = 0.56 * daysToExpiry; // ~3.1% annualized carry
  return esPrice - basis;
}
```

**Accuracy for pool centering (does the estimated SPX center give us coverage?):**

| Method | MAE | Max Error | Within ±100 band? |
|--------|-----|-----------|-------------------|
| Previous day's close spread | 10.73 pts | 21.87 pts | ✅ Always (worst case uses 22 of 100 pts margin) |
| Fixed 45-pt offset | 17.15 pts | 52.31 pts | ✅ Always (worst case uses 52 of 100 pts margin) |
| Fair value model (0.56 × DTE) | ~17 pts | ~25 pts | ✅ Always |

**Any of these methods work.** The ±100 point band provides 50+ points of margin even in the worst case. The previous day's close spread is most accurate but the simplest approach (fixed 45 pts) is fine for pool centering — we're not trying to predict SPX to the penny, just center 160 contracts within range.

> **Note on ES contract rolls:** ES rolls quarterly (Mar/Jun/Sep/Dec). At rollover, the front-month switches and the basis resets higher. The data service already handles this (tracks `ES=F` continuous contract via Yahoo). The fair value model adjusts automatically via DTE. The previous-close-spread method adapts within one day.

**Why is the pool fixed?** Reconnecting mid-session to add/remove symbols means briefly losing the stream for all contracts. With ±100 points of coverage (40 strikes × 2 types × 2 expiries), SPX would need to move >100 points intraday to escape the pool. That's a >1.5% move — it happens maybe 5-10 times a year, and on those days you want stable data more than ever.

### Architecture Changes

```
src/pipeline/
├── option-stream.ts       — NEW: WebSocket streaming client for options
│   ├── OptionStream class (extends/replaces PriceStream pattern)
│   ├── createSession() → POST /v1/markets/events/session
│   ├── connect() → wss://ws.tradier.com with auto-reconnect
│   ├── buildContractPool(esPrice) → symbol list
│   ├── onTick(symbol, trade/quote) → forward to candle builder
│   └── updateSymbols(symbols) → resend subscription (no reconnect needed with WS)
├── option-candle-builder.ts — NEW: tick-to-candle aggregator for streamed options
│   ├── Maintains per-symbol candle state (same pattern as SPX candle builder in index.ts)
│   ├── processTick(symbol, price, volume, ts) → updates forming candle
│   ├── closeCandle(symbol) → emits completed Bar, resets state
│   └── Timer-based candle close on minute boundaries (safety net)
```

**Changes to `src/index.ts`:**
- Replace `pollOptions()` interval with `OptionStream` lifecycle
- Keep `pollOptions()` as fallback (if stream disconnects, degrade gracefully to polling)
- `initOptionStream()` at startup instead of / in addition to polling interval
- SPX stream (`PriceStream`) stays as-is — already working well

**Changes to `src/pipeline/contract-tracker.ts`:**
- Pool is built once at ~9:15 from `buildContractPool(esPrice)` instead of discovered incrementally via chain polling
- `updateBand()` still tracks ACTIVE/STICKY states, but the initial set comes from the pre-built pool
- New: `buildPool(centerPrice, band, interval, expiries) → ChainEntry[]` helper

**What stays the same:**
- Bar storage (`upsertBars`) — same format, just better data
- Indicator computation — same incremental engine, just fed real ticks instead of poll snapshots
- Higher timeframe aggregation — `aggregateAndStore()` runs on each closed 1m candle, producing 3m/5m/etc. with proper indicators. This is the same pipeline SPX bars already go through.
- WebSocket broadcast to clients — same `contract_bar` messages

### OptionStream Class

```typescript
import WebSocket from 'ws';
import { config } from '../config';

const TRADIER_BASE = 'https://api.tradier.com/v1';

interface StreamTick {
  type: 'trade' | 'quote';
  symbol: string;
  price?: number;    // trade: last price
  size?: number;     // trade: volume
  bid?: number;      // quote: bid
  ask?: number;      // quote: ask
  ts: number;        // unix ms
}

type TickCallback = (tick: StreamTick) => void;

export class OptionStream {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private symbols: string[] = [];
  private callback: TickCallback | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;  // more generous — this is the primary data feed
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageTs = 0;

  onTick(cb: TickCallback): void { this.callback = cb; }

  /** Build the contract pool centered on a price */
  static buildContractPool(
    centerPrice: number,
    band: number,        // default: 100
    interval: number,    // default: 5
    expiries: string[],  // e.g. ['2026-04-01', '2026-04-02']
    optionPrefix = 'SPXW'
  ): string[] {
    const center = Math.round(centerPrice / interval) * interval;
    const symbols: string[] = [];
    for (const expiry of expiries) {
      const expiryCode = expiry.replace(/-/g, '').slice(2); // '2026-04-01' → '260401'
      for (let strike = center - band; strike <= center + band; strike += interval) {
        const strikeCode = String(strike * 1000).padStart(8, '0');
        symbols.push(`${optionPrefix}${expiryCode}C${strikeCode}`); // call
        symbols.push(`${optionPrefix}${expiryCode}P${strikeCode}`); // put
      }
    }
    return symbols;
  }

  async start(symbols: string[]): Promise<void> {
    this.symbols = symbols;
    this.running = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /** Update subscription without full reconnect (WebSocket advantage) */
  updateSymbols(symbols: string[]): void {
    this.symbols = symbols;
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      this.ws.send(JSON.stringify({
        symbols: this.symbols,
        sessionid: this.sessionId,
        filter: ['trade', 'quote'],
        linebreak: true,
        validOnly: true,
      }));
      console.log(`[option-stream] Updated subscription: ${symbols.length} symbols`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log('[option-stream] Stopped');
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get symbolCount(): number { return this.symbols.length; }
  get lastActivity(): number { return this.lastMessageTs; }

  private async connect(): Promise<void> {
    if (!this.running || this.symbols.length === 0) return;

    try {
      // Step 1: Create streaming session
      this.sessionId = await this.createSession();
      if (!this.sessionId) {
        this.scheduleReconnect();
        return;
      }

      // Step 2: Open WebSocket
      this.ws = new WebSocket('wss://ws.tradier.com/v1/markets/events');

      this.ws.on('open', () => {
        console.log(`[option-stream] Connected — subscribing to ${this.symbols.length} symbols`);
        this.ws!.send(JSON.stringify({
          symbols: this.symbols,
          sessionid: this.sessionId,
          filter: ['trade', 'quote'],
          linebreak: true,
          validOnly: true,
        }));
        this.reconnectAttempts = 0;
        this.startHeartbeatMonitor();
      });

      this.ws.on('message', (data: Buffer) => {
        this.lastMessageTs = Date.now();
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleMessage(trimmed);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[option-stream] Disconnected: ${code} ${reason}`);
        if (this.running) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[option-stream] Error: ${err.message}`);
      });

    } catch (e: any) {
      console.error(`[option-stream] Connect failed: ${e.message}`);
      this.scheduleReconnect();
    }
  }

  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (!this.callback) return;

      if (msg.type === 'trade' || msg.type === 'timesale') {
        this.callback({
          type: 'trade',
          symbol: msg.symbol,
          price: parseFloat(msg.price || msg.last) || 0,
          size: parseInt(msg.size) || 0,
          ts: parseInt(msg.date) || Date.now(),
        });
      } else if (msg.type === 'quote') {
        this.callback({
          type: 'quote',
          symbol: msg.symbol,
          bid: parseFloat(msg.bid) || 0,
          ask: parseFloat(msg.ask) || 0,
          ts: parseInt(msg.biddate || msg.askdate) || Date.now(),
        });
      }
    } catch { /* malformed JSON — skip */ }
  }

  private async createSession(): Promise<string | null> {
    try {
      const resp = await fetch(`${TRADIER_BASE}/markets/events/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.tradierToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const data = await resp.json() as any;
      const sid = data?.stream?.sessionid;
      if (sid) console.log(`[option-stream] Session: ${sid.slice(0, 12)}...`);
      return sid ?? null;
    } catch (e: any) {
      console.error(`[option-stream] Session creation failed: ${e.message}`);
      return null;
    }
  }

  /** Detect stale stream — if no messages for 60s during RTH, reconnect */
  private startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const staleMs = Date.now() - this.lastMessageTs;
      if (staleMs > 60_000) {
        console.warn(`[option-stream] No data for ${(staleMs / 1000).toFixed(0)}s — reconnecting`);
        this.ws?.close();
      }
    }, 15_000);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[option-stream] Max reconnects (${this.maxReconnectAttempts}) — falling back to polling`);
      this.running = false;
      return; // caller should detect this and activate pollOptions() fallback
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    console.log(`[option-stream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }
}
```

### Option Candle Builder

Same pattern as the SPX candle builder already in `src/index.ts`, but generalized for multi-symbol:

```typescript
interface FormingCandle {
  minuteTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ticks: number;
}

export class OptionCandleBuilder {
  private candles = new Map<string, FormingCandle>();
  private onClose: (symbol: string, candle: FormingCandle) => void;

  constructor(onClose: (symbol: string, candle: FormingCandle) => void) {
    this.onClose = onClose;
  }

  /** Process a trade tick into the forming candle */
  processTick(symbol: string, price: number, volume: number, tsMs: number): void {
    if (price <= 0) return;
    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);

    let candle = this.candles.get(symbol);
    if (!candle || candle.minuteTs !== minuteTs) {
      // New minute — close previous candle if it exists
      if (candle && candle.ticks > 0) {
        this.onClose(symbol, candle);
      }
      candle = { minuteTs, open: price, high: price, low: price, close: price, volume: 0, ticks: 0 };
      this.candles.set(symbol, candle);
    }

    if (price > candle.high) candle.high = price;
    if (price < candle.low) candle.low = price;
    candle.close = price;
    candle.volume += volume;
    candle.ticks++;
  }

  /** Process a quote tick — update close/high/low from mid price */
  processQuote(symbol: string, bid: number, ask: number, tsMs: number): void {
    if (bid <= 0 || ask <= 0) return;
    const mid = (bid + ask) / 2;
    // Only update an existing candle — don't open a new one from just a quote
    const candle = this.candles.get(symbol);
    if (!candle) return;
    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);
    if (candle.minuteTs !== minuteTs) return; // stale quote for previous minute
    if (mid > candle.high) candle.high = mid;
    if (mid < candle.low) candle.low = mid;
    candle.close = mid;
  }

  /** Close all forming candles — call on minute boundary timer */
  flushAll(): void {
    for (const [symbol, candle] of this.candles) {
      if (candle.ticks > 0) {
        this.onClose(symbol, candle);
      }
    }
    this.candles.clear();
  }

  /** Get stats */
  get activeSymbols(): number { return this.candles.size; }
}
```

### Data Quality: Before and After

| Aspect | Before (REST polling) | After (WebSocket streaming) |
|--------|----------------------|----------------------------|
| Source | `fetchBatchQuotes()` every 30s | Tradier WebSocket push — every trade and quote |
| Samples per 1m candle | 1-2 snapshots | Tens to hundreds of ticks (for liquid strikes) |
| Open price | First poll in the minute (random offset) | Actual first trade of the minute |
| High/Low | Max/min of 1-2 polls (misses intra-minute swings) | True intra-minute high/low from every tick |
| Volume | Session volume delta estimation | Actual trade-by-trade volume |
| Gaps | 2-60 min gaps common (illiquid options don't move between polls) | Only truly illiquid contracts gap — any trade is captured |
| Synthetic bars | Frequent — linear interpolation fills gaps | Rare — only for genuinely untouched contracts |
| HMA reliability | Poor — computed on 2-sample candles + synthetic fills | Good — computed on real OHLCV from tick data |
| Latency | 30s poll cycle = 15s average lag | Sub-second — price arrives as it happens |

**This closes the biggest gap in the data quality divergence table.** SPX underlying was already clean (Tradier timesales stream). Now options data will be comparable quality. The remaining divergence is Polygon (replay) vs Tradier (live) exchange feeds — different sources, but both are real tick-level data aggregated into 1m candles.

### Graceful Degradation

The stream is the primary data path, but polling remains as fallback:

```
if (optionStream.isConnected()) {
  // Stream is live — candle builder receives ticks directly
  // pollOptions() is dormant (interval cleared or no-op)
} else {
  // Stream disconnected — fall back to REST polling
  // Re-enable pollOptions() at 30s interval
  // Log warning: '[data] Option stream down — degraded to REST polling'
}
```

This means:
- Normal operation: WebSocket stream → tick-level candles → exchange-quality bars
- Stream down: REST polling → 30s candles → current (degraded) quality
- Stream recovery: reconnect → resume tick-level candles

No data loss on transition — the candle builder just gets fewer ticks during polling mode.

### Tradier Constraints

- **One session at a time** — Tradier docs: "It is not permitted to open more than one session at a time." The SPX `PriceStream` (HTTP streaming) uses a separate session. Need to verify if WebSocket and HTTP streaming sessions are independent or share the limit.
  - **If shared**: Migrate SPX to the same WebSocket connection. Add 'SPX' to the options symbol list. One stream for everything.
  - **If independent**: Keep SPX on HTTP streaming (working well), options on WebSocket.
- **Session TTL**: 5 minutes from creation to first connection. Connect promptly after `createSession()`.
- **No published symbol limit**: "Ask for what you need, don't abuse it." ~160 symbols is modest — well within reasonable use.
- **Message volume**: 160 options contracts × ~5-50 ticks/min each = ~800-8000 messages/min at peak. Node.js handles this trivially.

## Edge Cases: Order Execution

### Entry Fills

| Scenario | Impact | Handling |
|----------|--------|----------|
| **Filled at expected price** | None — matches replay | Record fill price, apply to state |
| **Filled at different price** | SL/TP thresholds shift | Recompute SL/TP from actual fill price. If fill is >10% worse than expected, log a warning. |
| **Rejected: insufficient BP** | No position entered | Don't add to state. Log rejection with reason. Don't set lastEntryTs (allow retry). |
| **Rejected: invalid symbol** | No position entered | Same as above. May indicate expired contract slipped through — log the symbol for investigation. |
| **Timeout: order still pending** | Position might exist | Add to state as `pendingFill`. Next cycle: check order status. If filled → update price. If rejected → remove from state. If still pending → wait. After 3 cycles pending → cancel order, remove from state. |
| **Network error: order not submitted** | No position entered | Don't add to state. Retry next cycle if signal still valid. |
| **Partial fill** | Position exists at smaller qty | Tradier reports avg_fill_price. Accept partial qty. Adjust sizing in state. Rare for options. |

### Exit Fills

| Scenario | Impact | Handling |
|----------|--------|----------|
| **Filled at expected price** | None | Record P&L, remove from state |
| **Filled at different price** | P&L differs from tick()'s estimate | Use broker's fill price for actual P&L. Audit log records both decision price and fill price. |
| **Rejected: bracket legs active** | Can't exit | Cancel bracket legs first, retry sell next cycle. Position stays in state. tick() will try to exit again. |
| **Rejected: position not found** | Position already gone | Broker already closed it (OTOCO hit). Reconcile will catch this. Check recent order history for fill price to record P&L. |
| **Timeout: sell order pending** | Position in limbo | Mark as `pendingExit`. Next cycle: check order status. Don't enter new position while exit is pending. |
| **OTOCO TP hit while agent processing** | P&L determined by OTOCO fill | Reconcile detects phantom → fetch OTOCO fill price from Tradier → record actual P&L → remove from state. |
| **OTOCO SL hit while agent processing** | Same as above | Same handling. |
| **Price gapped through SL** | OTOCO stop may not fill at SL price | OTOCO fills at market after stop triggers. Actual loss may exceed SL. Agent's checkExit() catches this via tick() before OTOCO if polling is fast enough. |

### Flip-on-Reversal

The flip is: exit current position → immediately enter opposite side. In replay this is atomic (same tick). In live there's a real time gap.

| Phase | Replay | Live |
|-------|--------|------|
| Exit | Instant at bar close | 1-5s for sell fill |
| Gap | None | Market moves during fill |  
| Entry | Instant at same bar close | 1-5s for buy fill at new price |
| Total latency | 0 | 2-10 seconds |

**Rules for live flip execution:**
1. Exit MUST be confirmed (filled) before submitting entry
2. If exit fails → skip entry entirely (don't hold two positions)
3. If exit succeeds but entry is rejected → we're flat, which is safe. Cooldown prevents immediate retry. Next HMA cross will re-enter.
4. Entry price will differ from exit price — this is real execution cost, not a bug
5. During the gap, SPX may move enough to change which strike is at the config's `targetOtmDistance` → fresh `selectStrike()` call uses updated candidates with live tick prices

## Position Reconciliation

Reconciliation syncs `state.positions` with the broker's actual positions. It runs:
- **On every agent startup** (before first tick)
- **Every N cycles during RTH** (e.g., every 10 cycles = ~5 minutes)
- **Always BEFORE calling tick()** — decisions must be based on accurate state

### Reconciliation algorithm

```
1. Fetch broker positions: GET /accounts/{id}/positions
2. Fetch recent orders: GET /accounts/{id}/orders (last 24h)
3. For each broker position NOT in state.positions:
   → ORPHAN: broker has it, we don't
   → Adopt: add to state with broker's cost_basis as entryPrice
   → Submit protective SL order (if not already covered by existing bracket)
   → Log: "Adopted orphan {symbol} x{qty} @ ${cost_basis}"
   
4. For each state position NOT at broker:
   → PHANTOM: we think we have it, broker doesn't
   → Check recent orders for this symbol — find the fill that closed it
   → If found: record P&L from actual fill price, remove from state
   → If not found: assume closed at last known price, remove from state
   → Log: "Removed phantom {symbol} — closed by {reason}"
   
5. For each state position that IS at broker but with different cost_basis:
   → Price mismatch (our entryPrice != broker's cost_basis)
   → Update state.entryPrice to broker's cost_basis
   → Recompute SL/TP from broker's cost_basis
   → Log: "Price correction {symbol}: ${old} → ${new}"
```

### Crash recovery via reconciliation

On restart after crash:
1. Load session file → get last known `StrategyState`
2. If session file date != today → fresh state (new trading day)
3. If session file date == today → resume:
   a. Restore state from session file
   b. Run reconciliation (step above) — this catches any fills that happened while down
   c. Check recent Tradier orders since `lastDirectionBarTs` for fills we missed
   d. Resume tick() loop with corrected state

The session file is the source of truth for `directionCross`, `exitCross`, `prevDirectionHmaFast/Slow`, `prevExitHmaFast/Slow`, `dailyPnl`, `tradesCompleted`. Reconciliation corrects only the positions.

## TP/SL Enforcement — Two Layers

### Layer 1: Server-side OTOCO bracket (crash-safe)
- Submitted after entry fill confirmation
- Tradier enforces TP (limit sell) and SL (stop sell) independently
- Survives agent crash, network outage, PM2 restart
- On early exit (scannerReverse): cancel OCO legs first, then sell

### Layer 2: Agent-side checkExit() in tick() (faster, more conditions)
- Runs every cycle (5-30s) against live quotes
- Checks TP, SL, trailing stop, signal reversal, time-based exit, EOD cutoff
- Catches conditions OTOCO doesn't handle: signal reversal, time exit, trailing stop
- May trigger exit before OTOCO (if quote price hits SL but OTOCO hasn't triggered yet due to market mechanics)

### Conflict resolution

| Situation | What happens | Resolution |
|-----------|-------------|------------|
| Agent exits (scannerReverse) while OTOCO is active | Agent cancels OCO, then sells | Clean — one exit |
| OTOCO TP fills while agent is deciding | Agent's tick() returns exit, but position is gone | Next reconcile: phantom removal, record OTOCO fill P&L |
| OTOCO SL fills while agent is deciding | Same as above | Same — phantom removal |
| Agent and OTOCO try to exit simultaneously | One succeeds, other is rejected (no position) | Agent catches rejection, reconcile confirms position gone |
| Agent crashes while holding position | OTOCO remains active at broker | Broker enforces TP/SL. On restart, reconcile adopts or confirms exit. |

## Market Hours Enforcement

tick() does NOT enforce market hours. The caller is responsible.

**Live agent + data service:**
```
─── Data Service (src/index.ts) ───
~9:15 ET — Option stream lifecycle:
  esPrice = fetchESPrice()           // ES=F from Yahoo/data service
  pool = buildContractPool(esPrice)  // ±100 pts × $5 × C+P × 2 expiries ≈ 160 symbols
  optionStream.start(pool)           // WebSocket connect, stream is live
  // Pre-market CBOE GTH quotes start flowing in

─── Trading Agent (agent.ts) ───
while (true) {
  sleepUntilMarketOpen();            // blocks until 9:30 ET
  state = loadOrCreateSession();     // fresh or resume
  reconcile(state);                  // sync with broker
  
  while (isMarketOpen()) {           // exits at 16:00 ET
    runCycle();                       // calls tick() inside — stream-quality bars available
    sleep(pollInterval);
  }
  
  closeRemainingPositions();         // force-exit anything still open
  clearSession();                    // fresh tomorrow
}

─── Data Service (src/index.ts) ───
4:15 ET — optionStream.stop()        // close WebSocket, expire 0DTE contracts
```

**Replay:**
- Timestamps in the bar cache are already within RTH (9:30-16:00 ET)
- No overnight bars, no pre-market, no forming candles
- Time window gating inside tick() further narrows to activeStart/activeEnd

## Cooldown Semantics

The config field `judges.escalationCooldownSec` is used as the entry cooldown. This is a historical naming artifact — the field was originally for judge escalation throttling. The autoresearch found 180s optimal. **TODO: rename to `entryCooldownSec` in Config type to match its actual purpose.**

tick() enforces: `input.ts - state.lastEntryTs >= config.judges.escalationCooldownSec`

`state.lastEntryTs` is set by the caller after a CONFIRMED fill (not after tick() returns the decision). This means:
- Replay: set immediately (instant fills)
- Live: set after broker confirms fill. If fill takes 3s, cooldown starts 3s later.

**Edge case:** If entry is rejected, `lastEntryTs` is NOT updated — the cooldown doesn't apply to failed attempts. This allows the agent to retry on the next signal.

## What Changes

### New File
- `src/core/strategy-engine.ts` — `tick()` function, `StrategyState`, `TickInput`, `TickResult`, `CorePosition` types
- `tests/core/strategy-engine.test.ts` — unit tests for tick() decision logic

### Modified Files

**`src/replay/machine.ts`**
- Replace: inline HMA cross detection, escalation pipeline (`shouldEscalate`, `judgeAction`, auto-buy), inline position monitoring, inline flip logic
- With: `tick()` call + replay-specific state application (instant fills)
- Keep: bar cache loading, timestamp iteration, scanner/judge pipeline (for non-deterministic mode)
- The scanner/judge pipeline remains for configs that use `scanners.enabled: true` — tick() is the fast path for deterministic configs only

**`agent.ts`**
- Replace: `runCoreSignalDetection()`, inline entry logic in `runCycle()`, `PositionManager.updateHmaCross()`, `PositionManager.monitor()` exit logic, hardcoded `AGENT_CONFIG` import
- With: config loaded from DB by ID (`store.getConfig(configId)`), timeframe resolution from config, `tick()` call + live execution wrapper (order submission, fill confirmation, reconciliation)
- Add: fetch bars at config's direction/exit/signal timeframes from DB (already stored by `aggregateAndStore()`)
- Keep: market hours loop, session state persistence, broker reconciliation, streaming connections

**`agent-xsp.ts`**
- Same structural changes as `agent.ts`
- Keep: XSP-specific symbol conversion, 1DTE expiry handling, dual-order pattern

**`src/agent/position-manager.ts`**
- Remove: `updateHmaCross()`, exit decision logic in `monitor()`
- Keep: Tradier API calls (cancelBracketLegs, cancelOpenSellOrders, submitStandaloneOco), reconcileFromBroker, price fetching
- This becomes a broker interaction layer, not a decision layer

**`src/agent/market-feed.ts`**
- Remove: `aggregate()` function (broken — copies 1m indicator values to higher TFs instead of recomputing)
- The agent no longer needs to aggregate bars itself — it fetches pre-aggregated bars at the config's timeframe from the data service DB

### Deleted/Deprecated
- `agent-config.ts` — replaced by config loaded from DB by ID
- `agent-xsp-config.ts` — same
- `runCoreSignalDetection()` in agent.ts
- `PositionManager.updateHmaCross()` 
- `PositionManager.monitor()` exit logic (replaced by tick() + live execution wrapper)
- `market-feed.ts aggregate()` — broken for MTF (copies 1m indicator values instead of recomputing). Replace with proper aggregation + `computeIndicators()`
- Escalation pipeline in machine.ts for deterministic mode (kept for scanner/judge mode)

### New Files (Streaming)
- `src/pipeline/option-stream.ts` — `OptionStream` class: WebSocket streaming client for options contracts
- `src/pipeline/option-candle-builder.ts` — `OptionCandleBuilder` class: tick-to-candle aggregator
- `tests/pipeline/option-stream.test.ts` — unit tests for pool building, message parsing
- `tests/pipeline/option-candle-builder.test.ts` — unit tests for candle building from ticks

### Modified Files (Streaming)

**`src/index.ts`**
- Add: `initOptionStream()` lifecycle — build pool at ~9:15, connect stream, wire to candle builder
- Modify: `pollOptions()` becomes fallback only (activated when stream is down)
- Add: minute-boundary timer to flush option candles (same pattern as SPX candle timer)
- Add: health tracking for option stream (`healthTracker.recordSuccess('option-stream')`)

**`src/pipeline/contract-tracker.ts`**
- Add: `buildPool(centerPrice, band, interval, expiries)` helper for pre-market pool construction
- Modify: `updateBand()` still works but initial set comes from pre-built pool instead of incremental chain discovery

**`src/config.ts`**
- Add: `OPTION_STREAM_WAKE_ET` = `'09:15'` — when to build pool and connect stream
- Add: `OPTION_STREAM_CLOSE_ET` = `'16:15'` — when to close stream

### NOT Changed
- `src/core/signal-detector.ts` — used as-is by tick()
- `src/core/position-manager.ts` (`checkExit()`) — used as-is by tick()
- `src/core/risk-guard.ts` — used as-is by tick()
- `src/core/strike-selector.ts` — used as-is by tick()
- `src/core/friction.ts` — used as-is by tick()
- `src/core/position-sizer.ts` — used as-is by tick()
- `src/agent/trade-executor.ts` — used as-is by live execution wrapper
- `src/providers/` — Tradier, Yahoo, TradingView providers untouched

## Validation Plan

### Step 1: Regression — replay produces same results
- Run replay for 2026-03-27 with `hma3x17-undhma-otm15-tp14x-sl70` config
- Must produce same 23 trades with same entry/exit times, prices, reasons
- Run full 30-day suite — composite score within 2% of previous

### Step 2: Paper mode — live agent produces comparable results  
- Run live agent in paper mode for one full trading day (using the SAME config ID as replay)
- Same evening: backfill that day's data via Polygon into `replay_bars`, replay with the same config
- Also compare: live-collected bars (from streaming, in `bars` table) vs Polygon bars (in `replay_bars`) — this validates the 1m candle quality directly
- Compare trade-by-trade: entry times within ±1 minute, exit reasons match, P&L within ±5%

### Step 3: Comparison tool
- `npx tsx scripts/compare-live-replay.ts 2026-04-02`
- Loads live audit log + replay results for same date/config
- Outputs side-by-side table:
```
Time     Replay              Live                Diff
09:47    CALL C6455 @$17.30  CALL C6455 @$17.45  +$0.15 (fill slippage)
10:11    exit reversal @13.83  exit reversal @13.90  +$0.07
10:11    PUT  P6400 @$14.50  PUT  P6400 @$14.60  +$0.10
...
         23 trades $19,451   22 trades $18,900    -$551 (2.8% drag)
```

Expected divergences (not bugs):
- Entry/exit prices differ by spread/slippage ($0.05-$0.30 per trade)
- Occasionally live misses a trade replay took (order rejected, quote stale)
- Occasionally live takes a different strike (live quote vs bar close differs)
- Total daily P&L within 5-10% of replay is acceptable

### Step 4: Go live
- Only after Step 2 comparison shows <10% P&L divergence
- Start with 1 contract for 3 days
- Compare each day's results via comparison tool
- Scale up when consistent

## Implementation Order

### Phase 1: Strategy Engine (tick() parity)
1. Write `src/core/strategy-engine.ts` with `tick()` + types (MTF-aware: `spxDirectionBars`, `spxExitBars`, split HMA state)
2. Write `tests/core/strategy-engine.test.ts` — test each step in isolation, including MTF (different direction/exit TFs)
3. Wire replay machine to use `tick()` for deterministic configs — run regression against existing results
4. Wire live agent to use `tick()`:
   - Load config from DB by ID (delete `agent-config.ts`)
   - Resolve direction/exit/signal timeframes from config
   - Fetch bars at config TFs from data service DB (already stored by `aggregateAndStore()`)
   - Remove broken `market-feed.ts aggregate()`
   - Paper mode first
5. Build `stripFormingCandle(bars, periodSec)` helper — works for any timeframe

### Phase 2: Options Streaming (data quality parity)
6. Test Tradier session limits — can HTTP stream (SPX) and WebSocket stream (options) coexist?
   - If not: migrate SPX to WebSocket too (add 'SPX' to options symbol list)
7. Write `src/pipeline/option-stream.ts` — `OptionStream` class with `buildContractPool()`, WebSocket connect, auto-reconnect
8. Write `src/pipeline/option-candle-builder.ts` — tick-to-candle aggregator
9. Write tests for both (`pool building`, `candle OHLCV from tick sequence`, `quote-only doesn't open candle`)
10. Wire into `src/index.ts`:
    - 9:15 ET: fetch ES price → `buildContractPool()` → `OptionStream.start()`
    - Stream `onTick` → `OptionCandleBuilder` → `upsertBars()` + indicator computation
    - Minute-boundary timer flushes candles
    - `pollOptions()` stays as fallback when stream is disconnected
    - 16:15 ET: `OptionStream.stop()`
11. Run one full day with streaming active, compare bar quality vs previous polling data
    - Metric: ticks-per-candle for ATM strikes (should be >>2)
    - Metric: synthetic bar percentage (should drop dramatically)

### Phase 3: Validation
12. Build comparison tool (`scripts/compare-live-replay.ts`)
13. Run one live paper day with streaming, backfill via Polygon, replay, compare
14. Fix divergences
15. Go live with 1 contract
16. Scale up

---

## Addendum: Execution Routing Separation (2026-04-02)

### Problem

The original plan said "config loaded from DB by ID" and "agent-config.ts is deleted." Both were implemented. But the plan left `Config.execution` (symbol, accountId, optionPrefix, strikeDivisor, strikeInterval) as part of the Config stored in the DB. This created a downstream problem:

Every time a new config was validated in replay and selected for live deployment, it required **cloning into "live variant" configs** — one per agent:

```
hma3x15-undhma-itm5-tp1375x-sl50-3m           ← replay config (no execution)
hma3x15-itm5-tp1375x-sl50-3m-spx-live         ← clone + SPX execution section
hma3x15-itm5-tp1375x-sl50-3m-xsp-live         ← clone + XSP execution section
```

This violates the core principle: **test in replay → deploy to live with confidence.** The cloning step is manual, error-prone, and creates config sprawl. Worse, it reintroduces the exact problem the parity plan was supposed to eliminate — config divergence between replay and live. If someone updates the base config and forgets to update the clones, the agents silently run stale parameters.

### Root Cause

`Config.execution` conflates two fundamentally different concerns:

1. **Trading strategy** — What signals to trade, how to size, when to exit, what strikes to target. This is what replay tests and what the Config should contain.

2. **Order routing** — Where to send orders: which Tradier account, which product symbol, which option prefix, what strike math to use. This is an identity property of the agent, not a parameter of the strategy.

The original plan focused on making tick() the shared decision function and loading configs from the DB. It succeeded at both. But it didn't question whether `Config.execution` belonged on the Config in the first place.

### The Fix

Execution routing is now hardcoded per agent. The Config defines the strategy. The agent defines where orders go.

**SPX Agent (`agent.ts`):**
```typescript
const CONFIG_ID = process.env.AGENT_CONFIG_ID || 'hma3x15-undhma-itm5-tp1375x-sl50-3m';
const config: Config = store.getConfig(CONFIG_ID) ?? DEFAULT_CONFIG;

// Execution target is a property of the AGENT, not the config.
const EXECUTION: Config['execution'] = {
  symbol: 'SPX',
  optionPrefix: 'SPXW',
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
};
```

**XSP Agent (`agent-xsp.ts`):**
```typescript
const CONFIG_ID = process.env.AGENT_CONFIG_ID || 'hma3x15-undhma-itm5-tp1375x-sl50-3m';
const config: Config = store.getConfig(CONFIG_ID) ?? DEFAULT_CONFIG;

// Execution target is a property of the AGENT, not the config.
const EXEC: NonNullable<Config['execution']> = {
  symbol: 'XSP',
  optionPrefix: 'XSP',
  strikeDivisor: 10,
  strikeInterval: 1,
  accountId: process.env.XSP_ACCOUNT_ID || '6YA58635',
};
```

**Both agents load the same config ID.** The config contains the trading strategy (HMA periods, SL/TP, exit strategy, timeframes, risk limits). The agent adds its own routing. No clones, no variants, no translation step.

**Deployment workflow (before):**
```
1. Test config in replay
2. Clone config with -spx-live suffix, add SPX execution section
3. Clone config with -xsp-live suffix, add XSP execution section
4. Update ecosystem.config.js to point at the -spx-live and -xsp-live IDs
5. Restart agents
```

**Deployment workflow (after):**
```
1. Test config in replay
2. Update AGENT_CONFIG_ID (in ecosystem.config.js or env)
3. Restart agents
```

### What Moved Where

| Field | Before (on Config) | After | Rationale |
|-------|-------------------|-------|-----------|
| `execution.symbol` | Config | Agent constant | SPX agent always trades SPX. XSP agent always trades XSP. Doesn't change with strategy. |
| `execution.optionPrefix` | Config | Agent constant | Derived from symbol — SPXW for SPX, XSP for XSP. |
| `execution.strikeDivisor` | Config | Agent constant | Product math — SPX=1, XSP=10. Inherent to the product, not the strategy. |
| `execution.strikeInterval` | Config | Agent constant | Product math — SPX=$5, XSP=$1. Inherent to the product. |
| `execution.accountId` | Config | Agent constant / env var | Which brokerage account. Agent identity, not strategy. |
| `execution.use1dte` | Config | Removed | Not currently used. If re-enabled, would be an agent-level choice (XSP-specific). |
| `execution.halfSpread` | Config (unused) | Stays on Config | Friction model parameter — affects P&L in both replay and live. Strategy parameter. |
| `execution.disableBracketOrders` | Config | Stays on Config | Execution behavior that could be tested in replay (paper mode simulation). |
| `exit.strategy` | Config | Config (unchanged) | Core strategy behavior — scannerReverse vs takeProfit. tick() uses this. |
| `position.stopLossPercent` | Config | Config (unchanged) | Core strategy behavior — tick() computes SL from this. |
| `position.takeProfitMultiplier` | Config | Config (unchanged) | Core strategy behavior — tick() computes TP from this. |

### Config.execution Type — Retained but Optional

The `execution` section remains on the `Config` type as `execution?: { ... }`. It is:
- **Ignored by replay** — replay doesn't place orders
- **Ignored by tick()** — tick() makes decisions, doesn't route orders
- **Ignored by the live agents** — agents use their own hardcoded constants
- **Retained for backward compatibility** — existing configs in the DB may have it; doesn't break anything

Future cleanup: `execution` could be removed from the `Config` type entirely and the agent constants could use a standalone `ExecutionTarget` interface. This is a low-priority refactor since the current approach works and the type is already optional.

### Files Changed

| File | Change |
|------|--------|
| `agent.ts` | CONFIG_ID points at base config. EXECUTION constant defined. All `config.execution` references replaced with `EXECUTION`. |
| `agent-xsp.ts` | CONFIG_ID points at base config. EXEC constant defined (was `CFG.execution!`). `use1dte` removed. |
| `ecosystem.config.js` | AGENT_CONFIG_ID env var updated to base config ID (same for both agents). |
| `CLAUDE.md` | Design decisions updated to document execution-routing-is-agent-owned principle. |

### Invariants

1. **One config, two agents.** Both agents load the same config by ID. Different execution targets are agent-level constants.
2. **No "live variant" configs.** The `-spx-live` / `-xsp-live` config pattern is deprecated. Existing clones in the DB are harmless but should not be created for new configs.
3. **Config changes are tested in replay first.** The agent loads whatever CONFIG_ID points at. Replay validated the strategy; the agent executes it.
4. **tick() never sees execution routing.** It takes strategy parameters from Config and market data from TickInput. It returns decisions. The agent translates decisions into broker orders using its own routing.

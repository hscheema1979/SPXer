# Complete System Audit: Signal-to-Order Flow

## Objective
Map EVERY component involved in the signal-to-order flow to identify ALL gaps, bugs, and inconsistencies before making any fixes.

---

## Phase 0: Data Collection

### Providers (fetch raw market data)

**File**: `src/providers/tradier.ts`
- **Function**: `fetchTimesales()` - fetches SPX timesales
- **Output**: Array of price points
- **Timeframe**: 8:00 AM ET - RTH only
- **Usage**: SPX underlying bars for indicator computation

**File**: `src/providers/yahoo.ts`
- **Status**: DISABLED (no overnight ES data collection)
- **Note**: Removed from pipeline

**File**: `src/providers/tv-screener.ts`
- **Function**: `fetchMarketContext()` - fetches ES, NQ, VIX, sectors
- **Output**: Market context object
- **Usage**: Contextual information only

---

## Phase 1: Bar Building

**File**: `src/pipeline/bar-builder.ts`
- **Input**: Raw price points from providers
- **Function**: `buildBars()`
- **Output**: 1m OHLCV bars with incremental indicators
- **Indicators Computed**: HMA 5/19/25, EMA 9/21, RSI 14, Bollinger, ATR 14, VWAP

**File**: `src/pipeline/indicator-engine.ts`
- **Function**: Re-export of `src/core/indicator-engine.ts`
- **Computation**: Incremental (state-based), not from scratch

**File**: `src/pipeline/spx/contract-tracker.ts`
- **Function**: Tracks options contracts in sticky band model
- **Lifecycle**: UNSEEN → ACTIVE → STICKY → EXPIRED
- **Band**: ±$100 strikes around SPX
- **Key Function**: `getActiveExpirations()` - returns 0-2 DTE (Tue), 0-3 DTE (Fri)

**Critical**: Contract tracker tracks multi-day expirations for continuity, but we only trade 0DTE.

---

## Phase 2: Signal Detection

**File**: `src/index.ts` function `detectContractSignals()` (lines 586-665)

**Flow**:
```typescript
1. Parse symbol → {strike, expiry, isCall}
2. ✅ FIXED: Validate expiry === todayET() (line 600-603)
3. Filter by strike distance (SIGNAL_STRIKE_BAND = ±$100)
4. For each HMA pair (3×12, 5×19, etc.):
   - Get HMA fast/slow from bar indicators
   - Check for cross on THIS bar
   - If bullish cross → emit signal
   - If bearish cross → emit signal
5. Broadcast WebSocket event
```

**Signal Structure**:
```typescript
{
  type: 'contract_signal',
  channel: 'hma_3_12',
  data: {
    symbol: 'SPXW260422C07100000',
    strike: 7100,           // ⚠️ WHERE cross happened
    expiry: '2026-04-22',   // ✅ NOW validated to be today
    side: 'call',
    direction: 'bullish',
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    price: 13.50,
    timestamp: 1713813600000
  }
}
```

**Critical Insight**: The signal includes `strike` which is WHERE the HMA cross occurred. This can be ANYWHERE in the ±$100 band.

---

## Phase 3: WebSocket Transmission

**File**: `src/index.ts` function `broadcast()`
- **Function**: Sends signal to all WebSocket clients
- **Channel**: `contract_signal:hma_{fast}_{slow}`

**File**: `src/server/ws.ts`
- **Function**: WebSocket server
- **Port**: 3600
- **Path**: `/ws`

---

## Phase 4: Event Handler - Signal Reception

**File**: `event_handler_mvp.ts`

### 4.1 WebSocket Connection
```typescript
function connectWebSocket()
├─ ws.on('message')
└─ handleWebSocketMessage()
   └─ if type === 'contract_signal'
      └─ handleContractSignal(signal)
```

### 4.2 Signal Processing
```typescript
async function handleContractSignal(signal: any)
├─ For each config:
│  ├─ Check HMA periods match (signalMatchesConfig)
│  ├─ Check direction matches (call/bullish, put/bearish)
│  ├─ Check risk gates (isRiskBlocked)
│  ├─ Check health gates (HealthGate)
│  ├─ Check time window (activeStart-activeEnd)
│  └─ Check max positions
│
├─ Fetch active contracts from data service
│  └─ GET /contracts/active
│
├─ Filter candidates:
│  ├─ expiryMatch: c.symbol.includes(signal.expiry)
│  ├─ sideMatch: C/P flag
│  └─ price > 0
│
├─ Call selectStrike(candidates, signal.direction, spxPrice, config)
│  └─ Returns: {candidate, reason}
│
├─ ⚠️ BUG #2: Validate strikeResult.candidate.strike === signal.strike
│  └─ If mismatch → REJECT TRADE
│
└─ If match → execute entry
```

---

## Phase 5: Strike Selection

**File**: `src/core/strike-selector.ts`

**Function**: `selectStrike(candidates, direction, spxPrice, config)`

**Algorithm**:
```typescript
1. Filter by strikeSearchRange (default ±$100 from SPX)
2. Filter by contractPriceMin/Max (default $0.20-$15.00)
3. Apply targetOtmDistance filter:
   - Narrow to strikes within ±$5 of target
   - targetOtmDistance = -5 → $5 ITM
   - targetOtmDistance = +5 → $5 OTM
4. Apply targetContractPrice preference (if set)
5. Score remaining candidates:
   - Price proximity to midpoint ($0.20-$15.00)
   - Strike proximity to target
6. Return highest score
```

**Critical**: `selectStrike()` returns the BEST strike per config, completely independent of where the HMA cross occurred.

---

## Phase 6: Order Execution

**File**: `event_handler_mvp.ts` (lines 423-490)

**Flow**:
```typescript
1. Build pendingKey: `${configId}:${signal.symbol}`
2. Add to pendingEntries set
3. Compute position size: computeQty(signal.price, config, null)
4. Build agentSignal object:
   ├─ symbol: signal.symbol ⚠️ FROM SIGNAL
   ├─ strike: signal.strike ⚠️ FROM SIGNAL
   ├─ currentPrice: signal.price
   └─ ...
5. Build decision object:
   ├─ stopLoss: signal.price * (1 - stopLoss%)
   └─ takeProfit: signal.price * takeProfitMultiplier
6. Call openPosition(agentSignal, decision, paper, EXECUTION, 0, configId)
```

**File**: `src/agent/trade-executor.ts` function `openPosition()`

**Flow**:
```typescript
1. Check bracket order disabled
2. Build Tradier order:
   ├─ symbol: agentSignal.symbol ⚠️ FROM SIGNAL
   ├─ qty: decision.positionSize
   └─ ...
3. Submit to Tradier API
4. If success:
   ├─ Create bracket OCO (TP + SL legs)
   └─ Return position object
5. If failure: return error
```

**File**: `src/agent/trade-executor.ts` function `submitBracketOrder()`

**Flow**:
```typescript
1. Build entry order (market or limit)
2. Build TP leg (limit order)
3. Build SL leg (stop order)
4. Submit OTOCO (one-triggers-other-cancel-all)
5. Return all order IDs
```

---

## Phase 7: Position Management

**File**: `event_handler_mvp.ts`

**Entry Success** (lines 474-488):
```typescript
if (result.position.quantity > 0) {
  const posId = result.position.id;
  state.positions.set(posId, result.position);
  const basketMemberId = getBasketMemberId(signal, state);
  state.basketMembers.set(posId, basketMemberId);
  state.lastEntryTs = now;
  console.log(`✅ ENTERED ${result.position.symbol} x${result.position.quantity}`);
}
```

**Exit Polling** (every 10s):
```typescript
async function checkExits()
├─ For each position:
│  ├─ Fetch current price
│  ├─ Call evaluateExit(position, latestBar, config)
│  └─ If exit triggered → closePosition()
```

---

## Comparison: Polling Agent vs Event Handler

### Polling Agent (`spx_agent.ts`)

**Signal Detection**:
```typescript
// Line 1100-1140
const detected = detectSignals(contractBars, config);
// Returns: { symbol, directionState, hmaCrossFast, hmaCrossSlow, ... }
```

**Entry Decision**:
```typescript
// Line 1203
const { entry, skipReason } = evaluateEntry(signal, exits, ..., config, {
  candidates,  // ALL active contracts
  spxPrice,
  ...
});
```

**Inside evaluateEntry()** (`src/core/trade-manager.ts:266`):
```typescript
// Line 266
const strikeResult = selectStrike(context.candidates, entryDirection, context.spxPrice, config);
// Uses strikeResult.candidate.strike DIRECTLY
// NO validation against any signal strike
```

**Order Execution**:
```typescript
// Line 718-768
await executeEntry(entry, snap);
// Calls openPosition(entry.symbol, entry.strike, ...)
```

### Event Handler (`event_handler_mvp.ts`)

**Signal Reception**:
```typescript
// Receives WebSocket event with specific symbol/strike/expiry
handleContractSignal(signal)
```

**Entry Decision**:
```typescript
// Line 407
const strikeResult = selectStrike(candidates, signal.direction, spxPrice, cfg);
```

**⚠️ THE BUG** (lines 413-417):
```typescript
if (strikeResult.candidate.strike !== signal.strike) {
  // REJECT TRADE
  continue;
}
```

**Order Execution**:
```typescript
// Line 431-452: Uses signal.symbol, signal.strike, signal.price
const agentSignal = {
  symbol: signal.symbol,  // ⚠️ FROM SIGNAL
  strike: signal.strike,  // ⚠️ FROM SIGNAL
  ...
};
```

---

## Critical Gaps Identified

### Gap #1: Signal Strike vs Selected Strike ⚠️ BUG

**Polling Agent**:
- Detects THAT a cross happened
- Calls `selectStrike()` to pick best strike
- Uses selected strike for order

**Event Handler**:
- Receives signal with WHERE cross happened
- Calls `selectStrike()` to pick best strike
- ❌ Validates selected === signal strike
- ❌ Uses signal fields for order (not selected fields)

**Impact**: Trades rejected or wrong strikes used

### Gap #2: Candidate Filtering by Signal Expiry ⚠️ BUG

**Event Handler** (line 388):
```typescript
const expiryMatch = c.symbol.includes(signal.expiry);
```

**Problem**:
- If signal has wrong expiry (Bug #1 - now FIXED), candidates are filtered to wrong expiry
- `selectStrike()` picks from wrong chain
- May pick wrong strike that happens to match signal strike
- Validation passes → wrong order

**Impact**: Wrong expiry orders (like the 4/23 order on 4/22)

### Gap #3: Order Fields from Signal, Not Selection ⚠️ BUG

**Event Handler** (lines 431-452):
```typescript
const agentSignal = {
  symbol: signal.symbol,    // ⚠️ Should be selected.symbol
  strike: signal.strike,    // ⚠️ Should be selected.strike
  currentPrice: signal.price,  // ⚠️ Should be selected.price
  ...
};
```

**Impact**: Even if strike validation passes, order uses wrong contract

### Gap #4: No Expiry Validation in Handler ⚠️ BUG

**Data Service** (line 600-603):
```typescript
✅ FIXED: Validates expiry === today
```

**Event Handler**:
```typescript
❌ No double-check that expiry is today
```

**Impact**: If data service validation is removed/bypassed, handler still accepts wrong expiry

### Gap #5: Signal Contains Strike Information ⚠️ DESIGN ISSUE

**Signal Structure**:
```typescript
{
  symbol: 'SPXW260422C07100000',  // Includes strike
  strike: 7100,                    // Explicit strike
  ...
}
```

**Problem**: Signal encodes WHERE cross happened, but handler doesn't need this information

**Polling Agent Approach**:
- Signal: "HMA cross detected on calls"
- Handler: "Which call should I buy?" → selectStrike() → "Buy this one"

**Event Handler Approach**:
- Signal: "HMA cross on strike 7100"
- Handler: "Should I buy 7100?" → selectStrike() → "I recommend 7095" → "❌ Mismatch"

---

## What Happened on 4/22: Step-by-Step

**19:10:40 ET**:

1. **Data Service**:
   - Tracking April 22 AND April 23 contracts (0-2 DTE)
   - HMA cross detected on `SPXW260423C07105000` (April 23, strike 7105)
   - ❌ No expiry validation (Bug #1 - not yet fixed)
   - Emitted signal with `expiry: '2026-04-23'`, `strike: 7105`

2. **WebSocket**:
   - Transmitted signal to event handler

3. **Event Handler**:
   - Received signal for April 23 expiry
   - Filtered candidates to those containing '260423' (April 23)
   - Candidate pool = April 23 chain (WRONG)
   - Called `selectStrike()` on April 23 candidates
   - SPX at ~7085, targetOtmDistance = -5 ($5 ITM)
   - Best strike = 7090 or 7095 from April 23 chain
   - But signal strike was 7105 ($20 ITM)
   - ⚠️ Validation: 7090/7095 !== 7105 → Should reject
   - ❌ But maybe candidates included 7105?
   - If 7105 was in April 23 chain and selected → validation passes
   - ❌ Uses signal.symbol for order (April 23 contract)
   - Order placed: `SPXW260423C07105000` (WRONG expiry, WRONG strike)

**Actual Order**:
- Symbol: `SPXW260423C07105000`
- Strike: 7105 ($20 ITM when SPX=7085)
- Expiry: April 23, 2026 (1DTE, should be 0DTE)

---

## All Bugs Summary

| # | Bug | Location | Status | Impact |
|---|-----|----------|--------|--------|
| 1 | Wrong expiry signals | `src/index.ts:595-599` | ✅ FIXED | 1DTE orders |
| 2 | Strike validation rejects trades | `event_handler_mvp.ts:413-417` | ⚠️ ACTIVE | Valid trades rejected |
| 3 | Order uses signal fields instead of selected | `event_handler_mvp.ts:431-452` | ⚠️ ACTIVE | Wrong contract ordered |
| 4 | No expiry double-check in handler | `event_handler_mvp.ts:388` | ⚠️ ACTIVE | No defense-in-depth |
| 5 | Signal design mismatch | N/A | ⚠️ DESIGN | Architectural issue |

---

## Next Steps: Design Review

Before fixing, we need to decide:

1. **Keep signal with strike information?**
   - Pro: Diagnostic info, debugging
   - Con: Handler might misuse it

2. **Trust selectStrike() completely?**
   - Polling agent: Yes
   - Event handler: No (validates against signal)

3. **Double-check expiry in handler?**
   - Pro: Defense-in-depth
   - Con: Redundant if data service validates

4. **Remove strike validation?**
   - Would fix Bug #2
   - But doesn't fix Bug #3 (order fields)

---

## Files Requiring Changes

If we proceed with fixes:

1. ✅ `src/index.ts` - Already fixed (Bug #1)
2. ❌ `event_handler_mvp.ts` - Needs fixes for Bugs #2, #3, #4
3. ❌ Maybe signal structure redesign (Bug #5)


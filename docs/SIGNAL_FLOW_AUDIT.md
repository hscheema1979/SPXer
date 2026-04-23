# Signal Flow Audit: Data Pipeline → Order Execution

**Date:** 2026-04-23
**Purpose:** Trace complete flow from WebSocket ticks to order placement
**Status:** Complete audit with bug fixes

---

## 1. Data Pipeline (WebSocket → Bars → Indicators → Signals)

### 1.1 Option Stream Initialization
**File:** `src/index.ts`, function `initOptionStream()` (line 195)

**Trigger:** Daily at `OPTION_STREAM_WAKE_ET` (09:22 ET)

**Steps:**
1. Get SPX price to center contract pool
2. Build contract pool: ±`STRIKE_BAND` (default ±$100) × $5 interval × calls+puts × active expirations
3. Create `PriceLine` instance (minimal price tracker per minute)
4. Start ThetaData WS (primary) + Tradier WS (fallback)
5. Start minute-boundary timer for REST validation

**Active Expirations** (`src/pipeline/spx/scheduler.ts`):
- Tuesday: 0-2 DTE
- Friday: 0-3 DTE
- **Purpose:** Data continuity for bar building
- **Critical:** NOT filtered to today — the pool includes tomorrow's contracts

### 1.2 Tick Processing (Real-Time)
**File:** `src/index.ts`, lines 251-255

```typescript
if (tick.type === 'trade' && tick.price && tick.price > 0) {
  priceLine.processTick(tick.symbol, tick.price, tick.ts, tick.size ?? 0);
} else if (tick.type === 'quote' && tick.bid && tick.ask) {
  priceLine.processQuote(tick.symbol, tick.bid, tick.ask, tick.ts);
}
```

**Flow:**
- ThetaData WS (primary) or Tradier WS (fallback) emits ticks
- Ticks feed `PriceLine.processTick()` or `PriceLine.processQuote()`
- PriceLine tracks last price per symbol per minute (no OHLC, just close)

### 1.3 Minute Boundary: REST Validation + Bar Building
**File:** `src/index.ts`, lines 283-327

**Trigger:** Every 5 seconds via `setInterval`

**Steps:**
1. Get active contracts from `ContractTracker` (line 290)
2. Sort by ATM proximity (line 295-299) — **nearest strikes first for minimal lag**
3. Fetch REST quote mids from Tradier batch endpoint (line 301)
4. Call `priceLine.snapshotAndFlush(restMids, 5)` (line 308)
   - Returns forming price points from past minutes
   - Validates stream closes against REST mids
   - Overrides if `|streamClose - restMid| / streamClose > 5%`
5. Convert to bars via `rawToBar()` (line 310-317)
6. **Add indicators via `computeIndicators()`** (line 318)
7. Store in DB (line 319)
8. Broadcast `contract_bar` WebSocket event (line 323)
9. **Detect signals via `detectContractSignals()`** (line 326)

### 1.4 Signal Detection
**File:** `src/index.ts`, function `detectContractSignals()` (line 586-665)

**Input:** Enriched bar with indicators

**Steps:**
1. Check if HMA signal enabled (line 587)
2. Get last 2 bars for cross detection (line 591-593)
3. Parse symbol to extract `{strike, expiry, isCall}` (line 596)
4. **✅ NEW: Validate expiry is TODAY** (line 599-602)
   ```typescript
   // CRITICAL: Only emit signals for TODAY's contracts (0DTE)
   // The data service tracks 0-2 DTE for continuity, but we only trade 0DTE
   const today = todayET();
   if (expiry !== today) {
     return;  // Skip contracts for future expirations (1DTE, 2DTE, etc.)
   }
   ```
5. Filter by strike distance: `|strike - lastSpxPrice| ≤ SIGNAL_STRIKE_BAND` (±$25) (line 602-603)
6. Detect HMA crosses for all configured pairs (line 606):
   - `[3, 12]`, `[3, 19]`, `[5, 19]`
7. For each cross, emit `contract_signal` WebSocket event (line 641, 662):
   ```json
   {
     "type": "contract_signal",
     "channel": "hma_3_12",
     "data": {
       "symbol": "SPXW260423C07100000",
       "strike": 7100,
       "expiry": "2026-04-23",
       "side": "call",
       "direction": "bullish",
       "hmaFastPeriod": 3,
       "hmaSlowPeriod": 12,
       "price": 13.50,
       "timestamp": 1713813600000
     }
   }
   ```

**✅ BUG FIX #1:** Wrong expiry (1DTE instead of 0DTE)
- **Problem:** `getActiveExpirations()` tracks 0-2 DTE for data continuity
- **Bug:** Signal detector emitted signals for ALL tracked contracts, including tomorrow's
- **Fix:** Added `if (expiry !== today) return;` after parsing symbol
- **Impact:** Event handler now only receives signals for today's contracts

---

## 2. Event Handler (WebSocket Signals → Order Execution)

### 2.1 WebSocket Connection
**File:** `event_handler_mvp.ts`, function `connectWebSocket()` (line 722)

**Steps:**
1. Connect to `ws://localhost:3600/ws`
2. Subscribe to HMA channels: `contract_signal:hma_3_12`, `contract_signal:hma_5_19`, etc.
3. Listen for `message` events → `handleWebSocketMessage()` (line 735)

### 2.2 Signal Routing
**File:** `event_handler_mvp.ts`, function `handleContractSignal()` (line 310)

**Input:** `contract_signal` from data service

**Per-Config Filtering Loop** (line 314-375):
1. **Config enabled check** (line 321-324)
2. **HMA pair match** via `signalMatchesConfig()` (line 326-329)
3. **Risk gates** via `isRiskBlocked()` (line 341-346)
   - Max positions
   - Daily loss limit
   - Cooldown
   - Trade frequency
4. **Health gate** via `healthGate.check()` (line 348-353)
   - Data freshness (SPX bars < 30s old)
5. **Time window** (line 355-366)
   - `activeStart` - `activeEnd`
6. **Max positions** (line 368-375)
   - `open + pending < maxPositionsOpen`

### 2.3 Strike Selection
**File:** `event_handler_mvp.ts`, lines 377-421

**Steps:**
1. Fetch active contracts from data service REST API (line 378-384)
2. **Filter candidates by expiry and side** (line 386-400):
   ```typescript
   const candidates = activeContracts
     .filter((c: any) => {
       const expiryMatch = c.symbol.includes(signal.expiry);
       const sideMatch = signal.side === 'call'
         ? c.symbol.includes('C')
         : c.symbol.includes('P');
       return expiryMatch && sideMatch && c.last > 0;
     })
   ```
3. Call `selectStrike(candidates, signal.direction, spxPrice, cfg)` (line 407)
   - Uses `config.strikeSelector.strikeMode` (`'itm'` | `'otm'` | `'atm'`)
   - Uses `config.signals.targetOtmDistance` (negative = ITM, positive = OTM)
4. **⚠️ VALIDATION CHECK** (line 413-417):
   ```typescript
   if (strikeResult.candidate.strike !== signal.strike) {
     console.log(`[handler] Strike mismatch: signal=${signal.strike} vs selected=${strikeResult.candidate.strike}`);
     console.log(`[handler] Reason: ${strikeResult.reason}`);
     continue;  // SKIP THIS TRADE
   }
   ```

**⚠️ GAP IDENTIFIED:** Strike validation mismatch

The data service emits a signal with `strike: 7105` (where HMA crossed), but `selectStrike()` returns `strike: 7100` (best ITM5 per config). The validation check REJECTS the trade.

**Question:** Should the handler:
- A) Trust the signal's strike and execute on that contract?
- B) Trust `selectStrike()` and ignore the signal's strike?
- C) Remove the validation check entirely?

**Current behavior:** Option A — signal's strike is authoritative

### 2.4 Order Execution
**File:** `event_handler_mvp.ts`, lines 423-459

**Steps:**
1. Add to `pendingEntries` to prevent duplicate entries (line 425-427)
2. Compute position size via `computeQty(signal.price, cfg, null)` (line 430)
3. Build signal object (line 432-453)
4. Execute via `openPosition()` (line 455-469)
5. Track position per config (line 471-476)

---

## 3. Gaps and Issues

### Gap #1: Expiry Validation ✅ FIXED
- **Location:** `src/index.ts`, `detectContractSignals()` line 595
- **Issue:** Signals emitted for 1DTE contracts
- **Fix:** Added `if (expiry !== today) return;`
- **Status:** Fixed in code, needs deployment

### Gap #2: Strike Selection vs Signal Strike ⚠️ DESIGN DECISION NEEDED
- **Location:** `event_handler_mvp.ts`, line 413
- **Issue:** Signal strike (where HMA crossed) ≠ selected strike (best per config)
- **Example:**
  - Signal: HMA crossed on 7105 (ITM20 if SPX=7085)
  - Config: `targetOtmDistance: -5` (ITM5)
  - `selectStrike()` returns: 7090 (ITM5)
  - Validation: `7105 !== 7090` → SKIP
- **Question:** Who is authoritative?
  - **Signal's strike** = where the HMA cross actually happened
  - **Selected strike** = where config says we should trade
- **Options:**
  1. **Remove validation** — Trust `selectStrike()` always
  2. **Trust signal strike** — Execute on the contract that had the HMA cross
  3. **Hybrid** — Only validate if strike mode is `'any'`

### Gap #3: Candidate Filtering by Expiry
- **Location:** `event_handler_mvp.ts`, line 388
- **Issue:** Filters by `c.symbol.includes(signal.expiry)`
- **Problem:** After fix #1, `signal.expiry` is always today, so this is redundant
- **Optimization:** Remove expiry filter since data service already validates

### Gap #4: No Strike Distance Filter in Handler
- **Location:** `event_handler_mvp.ts`, `handleContractSignal()`
- **Issue:** Data service filters to ±$25, but handler doesn't re-validate
- **Risk:** If signal band changes, handler might trade far-OTM contracts
- **Mitigation:** Add handler-side strike distance check

---

## 4. Testing Checklist

### ✅ Data Pipeline
- [x] Only emits signals for today's contracts
- [x] Only emits signals for strikes within ±$25 of SPX
- [x] Includes all configured HMA pairs (3×12, 3×19, 5×19)

### ⚠️ Event Handler
- [ ] Clarify strike selection authority (signal vs `selectStrike()`)
- [ ] Add handler-side strike distance validation
- [ ] Test with ITM5, ATM, OTM5 configs
- [ ] Verify no 1DTE orders are placed

### ⚠️ Order Execution
- [ ] Verify OTOCO bracket orders are submitted correctly
- [ ] Verify TP/SL levels match config percentages
- [ ] Verify position sizing uses 15% of buying power

---

## 5. Deployment Plan

### Phase 1: Deploy Bug Fix #1
**File:** `src/index.ts`
**Change:** Added expiry validation in `detectContractSignals()`
**Command:** `pm2 restart spxer`
**Verification:** Monitor logs for "CRITICAL: Only emit signals for TODAY's contracts"

### Phase 2: Resolve Strike Validation Gap
**File:** `event_handler_mvp.ts`
**Decision needed:** See Gap #2 above
**Options:**
1. Remove validation (trust `selectStrike()`)
2. Trust signal strike (current behavior)
3. Hybrid approach

### Phase 3: Add Defense-in-Depth
**File:** `event_handler_mvp.ts`
**Changes:**
- Add handler-side strike distance check
- Add handler-side expiry validation (defense-in-depth)
- Remove redundant candidate expiry filter (after fix #1)

---

## 6. Open Questions

1. **Strike authority:** Signal strike vs `selectStrike()` result?
2. **Why $20 ITM on 4/22:** Was the signal wrong, or did `selectStrike()` fail?
3. **Candidate pool:** Should handler fetch ALL active contracts or filter by strike band?
4. **Validation philosophy:** Trust data service completely, or add handler-side checks?

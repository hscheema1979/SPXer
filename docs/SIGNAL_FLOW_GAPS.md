# Signal-to-Order Flow: Critical Gaps Analysis

## Executive Summary

The event handler has **THREE critical bugs** causing wrong orders:

1. ✅ **FIXED**: Wrong expiry signals (1DTE instead of 0DTE)
2. ⚠️ **BUG**: Strike validation rejects valid trades
3. ⚠️ **BUG**: No strike validation on signal source

---

## Complete Signal Flow

### Phase 1: Data Pipeline (`src/index.ts`)

```
detectContractSignals(bar: Bar)
├─ Parse symbol → strike, expiry, isCall
├─ ✅ NEW: Validate expiry === todayET() (FIXED)
├─ Detect HMA cross on contract bar
└─ Emit WebSocket event:
   {
     type: 'contract_signal',
     channel: 'hma_3_12',
     data: {
       symbol: 'SPXW260422C07100000',
       strike: 7100,
       expiry: '2026-04-22',
       side: 'call',
       direction: 'bullish',
       hmaFastPeriod: 3,
       hmaSlowPeriod: 12,
       price: 13.50,
       timestamp: 1713813600000
     }
   }
```

**CRITICAL**: The signal includes:
- `strike`: The strike where HMA cross happened
- `symbol`: Full contract symbol with embedded strike
- `expiry`: Contract expiration date

This strike can be ANYWHERE in the band - it's just where the cross occurred.

---

### Phase 2: Event Handler (`event_handler_mvp.ts`)

```
handleContractSignal(signal)
├─ Check signal matches config (HMA periods, direction)
├─ Check risk gates
├─ Check health gates
├─ Check time window
├─ Check max positions
├─ Fetch active contracts from data service
├─ Filter candidates:
│  ├─ expiryMatch: c.symbol.includes(signal.expiry)
│  ├─ sideMatch: C/P flag
│  └─ price > 0
├─ Call selectStrike(candidates, direction, spxPrice, config)
│  └─ Returns BEST strike per config (e.g., ITM5)
├─ ⚠️ BUG: Validate strikeResult.candidate.strike === signal.strike
│  └─ If mismatch → REJECT TRADE
└─ If match → execute order
```

**THE PROBLEM**: The signal strike is where the HMA cross happened. The selected strike is what the config wants. These can be different!

---

### Phase 3: Order Execution (`src/agent/trade-executor.ts`)

```
openPosition(...)
├─ Build Tradier order
├─ Submit to broker
└─ Return execution result
```

---

## The Three Bugs

### Bug #1: Wrong Expiry Signals ✅ FIXED

**Location**: `src/index.ts:586-665` `detectContractSignals()`

**What happened**:
- Data service tracks 0-2 DTE contracts for continuity
- HMA cross detected on April 23 contract (1DTE)
- Signal emitted at 19:10 ET on 4/22 for `SPXW260423C07105000`
- Event handler received signal and placed order

**Root cause**:
```typescript
// BEFORE (line 595-599):
const { strike, expiry, isCall } = parsed;
const side = isCall ? 'call' : 'put';

// No validation that expiry is today!
```

**Fix applied**:
```typescript
// AFTER (line 595-604):
const { strike, expiry, isCall } = parsed;
const side = isCall ? 'call' : 'put';

// CRITICAL: Only emit signals for TODAY's contracts (0DTE)
const today = todayET();
if (expiry !== today) {
  return;  // Skip contracts for future expirations (1DTE, 2DTE, etc.)
}
```

**Status**: ✅ FIXED

---

### Bug #2: Strike Validation Rejects Valid Trades ⚠️ BUG

**Location**: `event_handler_mvp.ts:413-416`

**What happened**:
- Config says `strikeMode: 'itm', targetOtmDistance: -5` (ITM5)
- HMA cross detected on 7120 strike ($20 ITM when SPX=7100)
- Signal: `{ strike: 7120, ... }`
- `selectStrike()` correctly returns 7095 strike ($5 ITM per config)
- Validation: `7120 !== 7095` → **REJECT TRADE**

But wait - on 4/22, a trade WAS placed. Let me investigate...

**Actually, there are TWO scenarios**:

#### Scenario A: Signal from correct expiry, wrong strike
- Signal from April 22 contract (0DTE) ✅
- HMA cross at 7120 strike
- `selectStrike()` returns 7095
- Validation rejects → NO TRADE

#### Scenario B: Signal from wrong expiry (Bug #1), wrong strike
- Signal from April 23 contract (1DTE) ❌
- HMA cross at 7120 strike
- Event handler filters candidates by `signal.expiry` (2026-04-23)
- Candidate pool is from April 23 chain, NOT April 22
- `selectStrike()` picks best from April 23 chain
- If that happens to be 7120 → VALIDATION PASSES → WRONG TRADE!

**Root cause**:
The event handler has contradictory logic:
1. It uses `selectStrike()` to pick the best strike per config
2. Then validates that the selected strike matches the signal strike
3. But these are computed differently!

**The polling agent did it right**:
```typescript
// spx_agent.ts → evaluateEntry() → src/core/trade-manager.ts:266
const strikeResult = selectStrike(context.candidates, entryDirection, context.spxPrice, config);
// Uses strikeResult.candidate.strike directly for order
// NO validation against any signal strike!
```

**Fix needed**:
Remove the strike validation. Trust `selectStrike()` to return the correct strike per config.

```typescript
// REMOVE THIS (lines 413-417):
if (strikeResult.candidate.strike !== signal.strike) {
  console.log(`[handler] [${configId}] Strike mismatch: signal=${signal.strike} (${signal.strike - spxPrice > 0 ? '+' : ''}${signal.strike - spxPrice}) vs selected=${strikeResult.candidate.strike} (${strikeResult.candidate.strike - spxPrice > 0 ? '+' : ''}${strikeResult.candidate.strike - spxPrice})`);
  console.log(`[handler] [${configId}] Reason: ${strikeResult.reason}`);
  continue;
}
```

**Status**: ⚠️ BUG ACTIVE

---

### Bug #3: No Strike Validation on Signal Source ⚠️ BUG

**Location**: `src/index.ts:601-603` `detectContractSignals()`

**What happens**:
- Data service emits signals for ALL contracts in the ±$100 band
- This includes strikes $10, $15, $20, $30 ITM/OTM
- Event handler receives these signals
- Event handler calls `selectStrike()` which re-selects the strike

**Why this is a problem**:
1. Signal from $20 ITM strike received
2. Bug #1 filter passes (if expiry is today)
3. Bug #2 validation may pass (if selected strike happens to match)
4. Order placed for $20 ITM instead of configured $5 ITM

**The polling agent did it differently**:
```typescript
// spx_agent.ts:1100-1140
const detected = detectSignals(contractBars, config);
// Returns: { symbol, directionState, hmaCrossFast, hmaCrossSlow, ... }
// Does NOT include which specific contract had the cross!

// Then at spx_agent.ts:1177-1195:
// Builds candidates from ALL active contracts
// Calls selectStrike() to pick the best one per config
```

**The key difference**:
- Polling agent: Detects THAT a cross happened → selects best strike
- Event handler: Detects WHERE cross happened → validates against that strike

**Fix options**:

Option A: Make signal strike-agnostic (like polling agent)
```typescript
// Don't include specific strike in signal
{
  type: 'contract_signal',
  channel: 'hma_3_12',
  data: {
    expiry: '2026-04-22',
    side: 'call',
    direction: 'bullish',
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    price: 13.50,
    // NO specific strike - just that a cross happened
  }
}
```

Option B: Keep signal with strike, remove validation in handler
```typescript
// Signal includes strike (where cross happened)
// Event handler ignores signal.strike, uses selectStrike() result
```

**Status**: ⚠️ BUG ACTIVE

---

## Impact Analysis

### What happened on 4/22:

19:10:40 ET: System opened SPXW260423C07105000
- Strike: 7105
- Expiry: April 23, 2026 (WRONG - should be April 22)
- SPX price at time: ~7085
- Strike was $20 ITM instead of configured $5 ITM

**Sequence of bugs**:
1. Data service tracked April 23 contract (0-2 DTE)
2. HMA cross detected on April 23 contract at 7105 strike
3. Signal emitted for April 23 expiry ❌ (Bug #1)
4. Event handler filtered candidates by April 23 expiry ❌ (Bug #3)
5. Event handler picked 7105 strike from April 23 chain
6. Validation passed (selected === signal) ❌ (Bug #2)
7. Order placed for wrong expiry, wrong strike ❌

---

## Remove & Replace Plan

### Remove:
1. ✅ `src/index.ts`: Add expiry validation in `detectContractSignals()` — DONE
2. ❌ `event_handler_mvp.ts:413-417`: Remove strike validation
3. ❌ `src/index.ts`: Remove specific strike from signal (make it strike-agnostic)

### Replace:
1. Event handler should trust `selectStrike()` completely
2. Signal should indicate "a cross happened on this expiry+side", not "this specific strike"
3. Candidate filtering should use today's expiry from config, not signal

---

## Testing Checklist

After fixes:
- [ ] Run replay on 4/22 data — verify no 4/23 orders
- [ ] Run replay on multiple days — verify 0DTE only
- [ ] Run replay with ITM5 config — verify $5 ITM strikes
- [ ] Run replay with OTM5 config — verify $5 OTM strikes
- [ ] Test paper mode on live market — verify orders match config

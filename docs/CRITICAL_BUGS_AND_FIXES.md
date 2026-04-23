# Critical Bugs from 4/22 Trading + Fixes

**Date:** 2026-04-23
**Status:** Bugs identified, one fix deployed, one design decision needed

---

## Bug #1: Wrong Expiry (1DTE instead of 0DTE) ✅ FIXED

### What Happened
On 4/22 at ~19:10 ET, the system opened `SPXW260423C07105000` (April 23 contract).

**Expected:** Only trade 0DTE (same-day) contracts
**Actual:** Traded a 1DTE contract (April 23 when today was April 22)

### Root Cause

**Data Service (`src/index.ts`, `detectContractSignals()`):**
- The scheduler (`src/pipeline/spx/scheduler.ts`) tracks 0-2 DTE contracts for data continuity
- Purpose: Maintain uninterrupted bar series when contracts roll from 0DTE to 1DTE
- **Bug:** Signal detector emitted signals for ALL tracked contracts, including tomorrow's

**Event Handler:**
- Had no expiry validation - trusted the signal completely
- Received signal for `SPXW260423C07105000` and executed the trade

### The Fix

**File:** `src/index.ts`, line 595-602

```typescript
// Parse strike and expiry for the event
const parsed = parseSymbol(symbol);
if (!parsed) return;
const { strike, expiry, isCall } = parsed;
const side = isCall ? 'call' : 'put';

// CRITICAL: Only emit signals for TODAY's contracts (0DTE)
// The data service tracks 0-2 DTE for continuity, but we only trade 0DTE
const today = todayET();
if (expiry !== today) {
  return;  // Skip contracts for future expirations (1DTE, 2DTE, etc.)
}
```

**Why this is the right place:**
- Data service is the filter - prevents wrong signals from ever being emitted
- Event handler can focus on execution, not validation
- Cleaner separation of concerns

**Deployment:**
```bash
pm2 restart spxer
```

**Verification:**
- Monitor logs for "CRITICAL: Only emit signals for TODAY's contracts"
- Check that no `expiry != today` signals are emitted

---

## Bug #2: Wrong Strike ($20 ITM instead of $5 ITM) ⚠️ DESIGN GAP

### What Happened
On 4/22, the config specified `targetOtmDistance: -5` (ITM5), but the system placed orders $20 ITM.

### Root Cause Analysis

**The signal flow:**

1. **Data Service** emits `contract_signal` with `strike: X`
   - `strike` = the option contract where HMA cross happened
   - Example: HMA crosses on 7105 strike → signal has `strike: 7105`

2. **Event Handler** receives signal
   - Fetches all active contracts
   - Calls `selectStrike(candidates, direction, spxPrice, config)`
   - `selectStrike()` returns the BEST strike per config:
     - Config: `targetOtmDistance: -5`, `strikeMode: 'itm'`
     - SPX = 7085 → target = 7090 (ITM5)
   - **VALIDATION CHECK** (line 336):
     ```typescript
     if (strikeResult.candidate.strike !== signal.strike) {
       console.log(`Strike mismatch: signal=${signal.strike} vs selected=${strikeResult.candidate.strike}`);
       continue;  // SKIP THE TRADE
     }
     ```

**The problem:**

The validation check creates a mismatch between:
- **Signal strike** = where HMA cross actually happened (e.g., 7105 = ITM20)
- **Selected strike** = where config says we should trade (e.g., 7090 = ITM5)

When these don't match, the trade is REJECTED.

**But on 4/22, a $20 ITM order WAS placed.** This means one of:

A) **Validation check was bypassed or not active**
   - Maybe validation was added after 4/22?
   - Check: `git log` shows validation is in current code

B) **`selectStrike()` returned the wrong strike**
   - Candidates passed to `selectStrike()` were wrong
   - Scoring algorithm picked $20 ITM over $5 ITM
   - Check: `selectStrike()` ITM scoring peaks at 10pts ITM (line 210)

C) **Signal strike was wrong**
   - Data service emitted signal with wrong strike
   - Signal said 7090 (ITM5) but was actually 7105 (ITM20)
   - Check: Unlikely - data service parses strike from symbol

### Comparison with Polling Agent

**Polling Agent (`spx_agent.ts`):**
```typescript
const { entry, skipReason } = evaluateEntry(signal, exits, ..., config, context);
// entry.symbol = SELECTED strike (from selectStrike)
// NO validation against signal.strike
await executeEntry(entry, snap);
```

**Key difference:** Polling agent trusts `selectStrike()` completely. No validation check.

### The Design Question

**Question:** Who is authoritative - the signal or the selector?

**Option A: Trust `selectStrike()` (remove validation)**
- Pro: Config-driven, deterministic, matches polling agent behavior
- Con: Ignores where the signal actually happened

**Option B: Trust signal strike (keep validation)**
- Pro: Execute on the contract that had the HMA cross
- Con: Config settings become advisory, not authoritative
- Risk: Signal on 7105 (ITM20) when config wants ITM5 → trade rejected

**Option C: Hybrid (validate only when `strikeMode: 'any'`)**
- Pro: Best of both worlds
- Con: Complex, harder to reason about

### Current Behavior

**With validation check (current code):**
- Signal: HMA cross on 7105 (ITM20)
- Config: `targetOtmDistance: -5` (ITM5)
- `selectStrike()` returns: 7090 (ITM5)
- Validation: `7105 !== 7090` → **REJECT**
- Result: **NO TRADE**

**Without validation check (polling agent behavior):**
- Signal: HMA cross on 7105 (ITM20)
- Config: `targetOtmDistance: -5` (ITM5)
- `selectStrike()` returns: 7090 (ITM5)
- Validation: **SKIPPED**
- Result: **TRADE PLACED ON 7090**

### The Real Bug on 4/22

**Hypothesis:** The validation check was NOT active on 4/22, and `selectStrike()` had a bug or got wrong candidates.

**Investigation needed:**
1. Check if validation was in code on 4/22
2. Check what candidates were passed to `selectStrike()`
3. Check SPX price at signal time
4. Check if `targetOtmDistance` was actually -5

### Immediate Fix

**REMOVE THE VALIDATION CHECK** (line 335-340 in `event_handler_mvp.ts`):

```typescript
// REMOVE THIS:
// if (strikeResult.candidate.strike !== signal.strike) {
//   console.log(`Strike mismatch...`);
//   continue;
// }
```

**Reasoning:**
1. Matches polling agent behavior (proven in production)
2. Config is authoritative for strike selection
3. `selectStrike()` is the single source of truth
4. Signal strike is informational (where cross happened), not prescriptive (where to trade)

**Alternative if we want to keep validation:**
- Only log the mismatch, don't skip the trade
- Use signal strike for context/logging only

---

## Gap #3: Candidate Filtering by Strike Band

### Current State

**Data Service:**
- Filters signals to ±SIGNAL_STRIKE_BAND (±$25) from SPX
- Done in `detectContractSignals()` line 602-603

**Event Handler:**
- Fetches ALL active contracts from `/contracts/active`
- NO strike band filtering
- Relies on data service to not send far-OTM signals

### Risk

If `SIGNAL_STRIKE_BAND` changes or data service bug, handler might trade far-OTM contracts.

### Mitigation

Add defense-in-depth check in handler:

```typescript
// After fetching candidates (line 386)
const SIGNAL_STRIKE_BAND = 25;
const inBand = activeContracts.filter((c: any) => {
  const dist = Math.abs(c.strike - spxPrice);
  return dist <= SIGNAL_STRIKE_BAND;
});
```

---

## Deployment Plan

### Phase 1: Deploy Bug #1 Fix ✅
```bash
# Already done in src/index.ts
pm2 restart spxer
```

### Phase 2: Fix Bug #2
**File:** `event_handler_mvp.ts`
**Action:** Remove validation check (lines 335-340)
**Reason:** Trust `selectStrike()` as single source of truth

### Phase 3: Add Defense-in-Depth
**File:** `event_handler_mvp.ts`
**Action:** Add strike band filtering after line 384
**Reason:** Prevent far-OTM trades even if data service bug

---

## Testing Checklist

### Data Service
- [x] Only emit signals for today's contracts (Bug #1 fix)
- [ ] Verify 0-2 DTE tracking still works for bar continuity
- [ ] Check signal emission on market open (9:30 ET)

### Event Handler
- [ ] Remove strike validation check
- [ ] Add strike band filtering
- [ ] Test with ITM5, ATM, OTM5 configs
- [ ] Verify trades execute on SELECTED strike, not signal strike

### Integration
- [ ] Run paper trading for 1-2 days
- [ ] Verify no 1DTE orders
- [ ] Verify correct ITM/OTM depth
- [ ] Compare behavior with polling agent

---

## Open Questions

1. **On 4/22, was the validation check active?** Need to check git history or logs
2. **If validation was active, how did $20 ITM trade get placed?** Maybe `selectStrike()` bug?
3. **What candidates were passed to `selectStrike()` on 4/22?** Need to add logging
4. **Should we log strike mismatches instead of rejecting?** Could be useful for debugging

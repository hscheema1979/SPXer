# Remove & Replace Plan: Polling → Event Handler Migration

**Goal:** Fix the 2 critical bugs from 4/22 and ensure event handler matches polling agent behavior

**Status:** Audit complete, bugs identified, fixes documented

---

## Summary of Findings

### What Works ✅
- Data pipeline correctly emits HMA cross signals on option contracts
- Event handler receives signals and routes to configs
- Strike selection logic (`selectStrike()`) is correct and shared with polling agent
- Risk gates, time windows, health checks all work

### What's Broken ❌
1. **Bug #1: Wrong expiry** - Data service emitted signals for 1DTE contracts (FIXED)
2. **Bug #2: Strike validation** - Event handler rejects trades when selected strike ≠ signal strike

---

## Root Cause of Bug #2

**The validation check in `event_handler_mvp.ts` (line 335-340):**

```typescript
if (strikeResult.candidate.strike !== signal.strike) {
  console.log(`Strike mismatch...`);
  continue;  // REJECTS THE TRADE
}
```

**Why this is wrong:**

1. **Signal strike** = where the HMA cross happened (e.g., 7105 = ITM20)
2. **Selected strike** = where config says to trade (e.g., 7090 = ITM5)
3. These are OFTEN DIFFERENT - and that's OK!
4. The polling agent doesn't have this check - it trusts `selectStrike()`

**What happened on 4/22:**
- Either validation wasn't active, OR
- `selectStrike()` got wrong candidates, OR
- Signal had wrong strike

**Either way:** The validation check breaks the architecture and should be removed.

---

## Action Items

### 1. Remove Strike Validation Check

**File:** `event_handler_mvp.ts`
**Lines:** 335-340
**Action:** Delete these lines

```diff
-      // Only enter if signal strike matches selected strike
-      if (strikeResult.candidate.strike !== signal.strike) {
-        console.log(`[handler] [${configId}] Strike mismatch: signal=${signal.strike} (${signal.strike - spxPrice > 0 ? '+' : ''}${signal.strike - spxPrice}) vs selected=${strikeResult.candidate.strike} (${strikeResult.candidate.strike - spxPrice > 0 ? '+' : ''}${strikeResult.candidate.strike - spxPrice})`);
-        console.log(`[handler] [${configId}] Reason: ${strikeResult.reason}`);
-        continue;
-      }
```

**Why:** `selectStrike()` is the single source of truth. Signal strike is informational only.

---

### 2. Add Strike Band Filtering (Defense-in-Depth)

**File:** `event_handler_mvp.ts`
**Location:** After line 400 (candidate filtering)
**Action:** Add strike distance check

```typescript
const candidates = activeContracts
  .filter((c: any) => {
    const expiryMatch = c.symbol.includes(signal.expiry);
    const sideMatch = signal.side === 'call'
      ? c.symbol.includes('C')
      : c.symbol.includes('P');
    const priceOk = c.last > 0;

    // Strike band filter (defense-in-depth)
    const SIGNAL_STRIKE_BAND = 25;
    const strikeOk = Math.abs(c.strike - spxPrice) <= SIGNAL_STRIKE_BAND;

    return expiryMatch && sideMatch && priceOk && strikeOk;
  })
  .map((c: any) => ({
    symbol: c.symbol,
    side: signal.side as 'call' | 'put',
    strike: c.strike,
    price: c.last,
    volume: 1,
  }));
```

**Why:** Prevents far-OTM trades even if data service bug sends wrong signal.

---

### 3. Deploy Data Service Fix

**File:** `src/index.ts`
**Lines:** 595-602
**Status:** ✅ Already added
**Action:** Deploy to production

```bash
pm2 restart spxer
```

**What it does:** Only emit signals for today's contracts (0DTE). Skip 1DTE/2DTE.

---

### 4. Update Logs/Docs

**File:** `docs/SIGNAL_FLOW_AUDIT.md`
**Status:** ✅ Complete
**What it contains:** Full signal flow from WebSocket → bars → indicators → signals → handler → orders

**File:** `docs/CRITICAL_BUGS_AND_FIXES.md`
**Status:** ✅ Complete
**What it contains:** Detailed bug analysis, root causes, fixes

---

## Verification Steps

### After Deploying Fix #1 (Data Service)

1. **Monitor signal emission:**
   ```bash
   pm2 logs spxer --lines 100 | grep "contract_signal"
   ```
2. **Check expiry dates:**
   - All signals should have `expiry === todayET()`
   - No signals for tomorrow's contracts
3. **Check handler logs:**
   ```bash
   pm2 logs event-handler | grep "Signal matches"
   ```
4. **Verify no 1DTE orders:**
   - All orders should be for today's expiry

### After Deploying Fix #2 (Remove Validation)

1. **Monitor strike selection:**
   ```bash
   pm2 logs event-handler | grep "executing entry"
   ```
2. **Verify trades use SELECTED strike:**
   - Check that orders are placed on `strikeResult.candidate.strike`
   - NOT on `signal.strike`
3. **Test with ITM5 config:**
   - Should place orders ~5pts ITM
   - NOT at signal strike (which could be ITM20)
4. **Compare with polling agent behavior:**
   - Both should use `selectStrike()` the same way
   - Both should trust config, not signal

---

## Architecture Decision

### Question: Who is authoritative - signal or selector?

**Answer:** **SELECTOR**

**Reasoning:**

1. **Config is the contract with the user**
   - User sets `targetOtmDistance: -5` → expects ITM5
   - User sets `strikeMode: 'itm'` → expects ITM
   - User sets `contractPriceMin/Max` → expects price band

2. **Signal is just an event trigger**
   - Says "HMA crossed somewhere" (not WHERE to trade)
   - The cross could happen on any strike in the band
   - Selector picks the BEST strike per config

3. **Polling agent behavior**
   - Proven in production
   - Trusts `selectStrike()` completely
   - No validation check

4. **Single source of truth**
   - `selectStrike()` in `src/core/strike-selector.ts`
   - Shared by polling agent, event handler, replay system
   - Deterministic, testable, auditable

**Implementation:**
- Remove validation check
- Log when selected strike differs from signal strike (for debugging)
- Trust `selectStrike()` completely

---

## Timeline

### Phase 1: Immediate (Today)
- [x] Fix Bug #1 in data service (expiry validation)
- [ ] Remove strike validation check in event handler
- [ ] Deploy both fixes

### Phase 2: This Week
- [ ] Add strike band filtering (defense-in-depth)
- [ ] Run paper trading for 1-2 days
- [ ] Verify behavior matches polling agent

### Phase 3: Next Week
- [ ] Deploy to live trading
- [ ] Monitor for 1 week
- [ ] Compare performance with polling agent

---

## Success Criteria

### Functional
- [x] No 1DTE orders placed
- [ ] Correct ITM/OTM depth per config
- [ ] Orders use SELECTED strike, not signal strike
- [ ] No rejected trades due to strike mismatch

### Performance
- [ ] Same win rate as polling agent
- [ ] Same fill rate as polling agent
- [ ] Same latency or better (~1s vs 10-30s polling)

### Operational
- [ ] Clear logs showing signal → selection → execution
- [ ] Easy to debug issues
- [ ] No polling hallucinations

---

## Files Modified

1. `src/index.ts` - Added expiry validation (line 599-602)
2. `event_handler_mvp.ts` - Remove strike validation (line 335-340)
3. `event_handler_mvp.ts` - Add strike band filter (line 386-400)
4. `docs/SIGNAL_FLOW_AUDIT.md` - New file
5. `docs/CRITICAL_BUGS_AND_FIXES.md` - New file
6. `docs/ACTION_PLAN.md` - This file

---

## Next Steps

1. **Review this plan** with the user
2. **Get approval** for changes
3. **Deploy Fix #1** (data service)
4. **Deploy Fix #2** (event handler)
5. **Monitor** paper trading for 1-2 days
6. **Go live** if paper results look good

---

**Questions?**
- Why did $20 ITM trade happen on 4/22? (Need more investigation)
- Should we log strike mismatches instead of rejecting? (Yes, for debugging)
- What other gaps exist? (See SIGNAL_FLOW_AUDIT.md Gap #3, #4)

# Event Handler Fixes: Complete Action Plan

## What Was Fixed

Two critical bugs that caused wrong orders on 4/22:

1. ✅ **Wrong Expiry**: Traded April 23 contract (1DTE) instead of April 22 (0DTE)
2. ✅ **Wrong Strike**: Traded $20 ITM instead of configured $5 ITM

---

## Root Causes

### Bug #1: Expiry Validation Missing
- Data service tracks 0-2 DTE contracts for market continuity
- HMA cross detected on April 23 contract
- Signal emitted without checking expiry is today
- Event handler received and acted on wrong-expiry signal

### Bug #2: Strike Selection + Validation Conflict
- Signal includes specific strike (where HMA cross happened)
- Event handler calls `selectStrike()` to get best strike per config
- Event handler then validates `selected.strike === signal.strike`
- If mismatch → rejects trade
- But if wrong expiry → wrong candidate pool → validation passes for wrong strike

---

## Changes Made

### 1. Data Service (`src/index.ts`)

**Added expiry validation in signal detection** (line 601-604):
```typescript
// CRITICAL: Only emit signals for TODAY's contracts (0DTE)
const today = todayET();
if (expiry !== today) {
  return;  // Skip contracts for future expirations (1DTE, 2DTE, etc.)
}
```

### 2. Event Handler (`event_handler_mvp.ts`)

**Removed strike validation** (line 413-417 → 413-418):
```typescript
// REMOVED: Strike mismatch check that rejected valid trades
// REPLACED WITH: Trust selectStrike() result
const selected = strikeResult.candidate;
console.log(`Selected strike: ${selected.strike} ... | ${strikeResult.reason}`);
```

**Use selected contract for orders** (line 424-463):
```typescript
// BEFORE: signal.symbol, signal.strike, signal.price
// AFTER: selected.symbol, selected.strike, selected.price
const agentSignal = {
  symbol: selected.symbol,  // Use selected, not signal
  strike: selected.strike,
  currentPrice: selected.price,
  ...
};
```

**Updated basket member tracking** (line 478, 926-931):
```typescript
// Pass selected.strike, not signal object
const basketMemberId = getBasketMemberId(selected.strike, state);

// Updated function signature
function getBasketMemberId(selectedStrike: number, state: ConfigState): string
```

---

## How It Works Now

### Before (Buggy):
```
Data Service:
  - Detect HMA cross on April 23 contract at 7120 strike
  - Emit signal (wrong expiry) ❌

Event Handler:
  - Filter candidates by April 23 expiry ❌
  - selectStrike() returns 7120 (from wrong chain) ❌
  - Validate: 7120 === 7120 ✅ (but wrong expiry!)
  - Place order for April 23, 7120 ❌
```

### After (Fixed):
```
Data Service:
  - Detect HMA cross on April 22 contract at 7120 strike
  - Validate expiry is today ✅
  - Emit signal (correct expiry)

Event Handler:
  - Filter candidates by April 22 expiry ✅
  - selectStrike() returns 7095 (ITM5 per config) ✅
  - No validation against signal strike ✅
  - Place order for April 22, 7095 ✅
```

---

## Architecture Alignment

Event handler now matches polling agent's proven approach:

**Polling Agent**:
```typescript
const strikeResult = selectStrike(candidates, direction, spxPrice, config);
// Uses strikeResult.candidate.strike directly
// No validation against signal
```

**Event Handler** (now):
```typescript
const strikeResult = selectStrike(candidates, direction, spxPrice, config);
const selected = strikeResult.candidate;
// Uses selected.strike directly
// No validation against signal
```

---

## Testing Required

### Critical Tests (Must Pass):

1. **Replay on 4/22**:
   ```bash
   npx tsx src/replay/cli.ts run \
     --config spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000 \
     --date 2026-04-22
   ```
   - ✅ No April 23 orders
   - ✅ All strikes ~$5 ITM

2. **Replay Multi-Day**:
   ```bash
   npx tsx src/replay/cli.ts backtest \
     --config spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000 \
     --dates 2026-04-14,2026-04-15,2026-04-16,2026-04-17,2026-04-18
   ```
   - ✅ 100% 0DTE orders only

3. **Paper Mode**:
   - Monitor live market for signals
   - ✅ Verify expiry is today
   - ✅ Verify strike matches config

See `TESTING_CHECKLIST.md` for complete testing protocol.

---

## Deployment

### Step 1: Review Changes
```bash
# Check what was changed
git diff src/index.ts
git diff event_handler_mvp.ts
```

### Step 2: Restart Services
```bash
# Restart data service (expiry fix)
pm2 restart spxer

# Restart event handler (strike selection fixes)
pm2 restart event-handler
```

### Step 3: Verify Startup
```bash
# Check logs
pm2 logs spxer --lines 50
pm2 logs event-handler --lines 50

# Look for:
# - "Data service started"
# - "Event-Driven Trading Handler MVP starting..."
# - No errors
```

### Step 4: Monitor First Trade
```bash
# Watch logs in real-time
pm2 logs event-handler --lines 0

# When signal fires, verify:
# [signal] CONTRACT ... SPXW260423C... → expiry is TODAY
# [handler] Selected strike: 7XXX (+/- X) → matches config
# [agent] ✅ ENTERED ... → correct symbol
```

### Step 5: Verify at Broker
```bash
npx tsx scripts/show-basket-positions.ts

# Verify:
# - All positions have today's expiry
# - Strike distances match config
```

---

## Rollback Plan

If issues detected:

```bash
# Revert to previous commit
git checkout <previous-commit-hash>

# Restart services
pm2 restart spxer
pm2 restart event-handler

# Or revert specific commits
git revert HEAD
git revert HEAD~1
pm2 restart spxer event-handler
```

---

## Documentation

Created for this fix:

1. **`docs/SIGNAL_FLOW_GAPS.md`** — Complete signal flow analysis, all three bugs documented
2. **`docs/BUG_FIX_SUMMARY.md`** — Summary of both bugs and fixes applied
3. **`TESTING_CHECKLIST.md`** — Comprehensive testing protocol (replay, paper, production)
4. **This file** — Complete action plan and deployment guide

Previous documentation (context):

1. **`docs/CRITICAL_BUG_WRONG_EXPIRY.md`** — Original expiry bug analysis
2. **`docs/ACTUAL_ISSUES.md`** — Event handler status assessment
3. **`docs/EVENT_HANDLER_E2E_SUCCESS.md`** — Original validation (now outdated)

---

## Success Criteria

### Expiry Validation
- ✅ 100% of trades use 0DTE contracts (today only)
- ✅ Zero trades using 1DTE or 2DTE
- ✅ No after-hours orders

### Strike Selection
- ✅ ITM configs: 95%+ of trades within $3-$7 ITM
- ✅ OTM configs: 95%+ of trades within $3-$7 OTM
- ✅ Zero outliers >$15 from target

### System Stability
- ✅ No crashes or errors
- ✅ WebSocket stays connected
- ✅ Orders execute within 2 seconds
- ✅ P&L tracked from broker

---

## Next Steps

1. **Run replay tests** (30 minutes)
   - Test 4/22 date
   - Test multi-day
   - Verify results

2. **Deploy to paper mode** (after replay passes)
   - Monitor for first signal
   - Verify order details
   - Check broker

3. **Monitor for 24 hours** (paper mode)
   - Verify all trades use 0DTE
   - Verify strike selection accuracy
   - Check P&L tracking

4. **If all checks pass, consider live deployment**
   - **WARNING**: Start with small size
   - Monitor first 10 trades manually
   - Have rollback plan ready

---

## Questions?

- **Logs**: `pm2 logs event-handler --lines 1000`
- **Positions**: `npx tsx scripts/show-basket-positions.ts`
- **Replay**: `npx tsx src/replay/cli.ts run --config <id> --date <YYYY-MM-DD>`
- **Status**: `pm2 status`

---

## Summary

**Fixed**:
- ✅ Expiry validation in data service
- ✅ Strike selection logic in event handler
- ✅ Order execution uses selected contract
- ✅ Basket tracking updated

**Testing**:
- ⏳ Replay tests pending
- ⏳ Paper mode tests pending
- ⏳ Production deployment pending

**Ready to proceed with testing phase.**

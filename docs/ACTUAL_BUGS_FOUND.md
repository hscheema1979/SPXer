# ACTUAL Bugs Found (Not Theoretical)

**Date**: 2026-04-23
**Status**: PRODUCTION ISSUES IDENTIFIED

---

## 🔴 BUG #1: Reconciliation Doesn't Sync State (CRITICAL)

**Location**: `event_handler_mvp.ts:220-265` (reconcileStartup)

**Problem**:
```typescript
// Line 247: Position added to memory
state.positions.set(adopted.id, adopted);

// Line 249: OCO submitted
await submitOcoProtection(adopted, TRADIER_ACCOUNT_ID);

// Line 264: Reconcile complete logged
// BUT: syncConfigPositions() NEVER CALLED!
```

**Impact**:
- Position exists in handler's `state.positions` Map
- BUT `handler-state.json` is NEVER updated
- Admin panel shows 0 positions (reads from JSON file)
- State file shows `positions: []` even though handler tracks position

**Evidence**:
```
$ cat logs/handler-state.json | jq '.configs[].positions'
[]  // Empty!

$ grep "Adopted orphaned" logs/event-handler-*.log
[handler] Adopted orphaned position: SPXW260423C07105000 x1 @ $31.90

$ pm2 logs event-handler | grep "Periodic reconcile"
[handler] Periodic reconcile found 1 unexpected adopted positions — investigate
```

**Root Cause**:
`reconcileStartup()` never calls `syncConfigPositions(configId, state)` after adding adopted positions.

**Fix**:
```typescript
// After line 261, add:
syncConfigPositions(configId, state);  // ← MISSING
```

---

## 🔴 BUG #2: Wrong Position Opened (USER REPORTED)

**User Report**: "Position open for the wrong day and completely wrong strike"

**Actual Position at Broker**:
- Symbol: `SPXW260423C07105000`
- Type: CALL
- Strike: 7105
- Expiry: April 23, 2026 (TODAY)
- Entry: $31.90

**Signals Being Emitted**:
```json
{
  "symbol": "SPXW260422P07135000",  // ← PUT, expiry 260422 (yesterday)
  "strike": 7135,
  "side": "put",
  "direction": "bearish"
}
```

**The Mismatch**:
- Signal: PUT, expiry 260422 (April 22)
- Position: CALL, expiry 260423 (April 23)

**Possible Causes**:
1. **Old polling agent opened this position** before event handler took over
2. **Manual trade** placed via Tradier web interface
3. **Config reload** happened mid-signal, causing wrong contract selection
4. **Signal detection bug** - emitting wrong expiry/strike in data service

**Investigation Needed**:
```bash
# Check when position was opened
curl -H "Authorization: Bearer $TRADIER_TOKEN" \
  "https://api.tradier.com/v1/accounts/6YA51425/orders" \
  | jq '.orders.order[] | select(.option_symbol == "SPXW260423C07105000") | {time: .create_time, symbol: .option_symbol}'

# Check if old agent was running
pm2 logs spxer --lines 100 | grep -E "spx_agent|LIVE BUY"

# Check signal emission for wrong expiry
grep "SPXW260422" logs/handler-routing.jsonl | head -5
```

---

## 🟡 BUG #3: Config Reload Loses Positions (MEDIUM)

**Location**: `event_handler_mvp.ts:898-920` (reloadConfig)

**Problem**:
```typescript
// Line 908: When reloading config
configs.set(configId, {
  ...
  positions: configs.get(configId)?.positions || new Map(),  // ← CAN LOSE POSITIONS
  ...
});
```

**Scenario**:
1. Handler starts, adopts orphan position
2. Config reload triggered (via command)
3. `configs.get(configId)` returns undefined during reload
4. Creates NEW empty Map
5. Position lost from memory

**Evidence from logs**:
```
00:52:36: Config spx-hma3x12-itm5-tp125x-sl20... adopted position
00:52:50: Config spx-hma3x12-itm5-tp30x-sl20... adopted position
         ^^^ Config ID changed! Reload happened!
```

**Fix**:
```typescript
// Preserve positions across reload
const existing = configs.get(configId);
configs.set(configId, {
  config: cfg,
  positions: existing?.positions || new Map(),
  // ... preserve other state too
});
```

---

## 🔴 BUG #4: Periodic Reconcile Spams Logs (ANNOYANCE)

**Location**: `event_handler_mvp.ts:682-706`

**Problem**:
- Runs every 60 seconds
- Finds "unexpected adopted positions"
- But these are ALREADY tracked in `state.positions`
- Why does `reconcileWithBroker()` return them as adopted?

**Hypothesis**:
The position IS in `state.positions` Map, but `reconcileWithBroker()` logic isn't finding it.

**Looking at reconciliation.ts:92-97**:
```typescript
for (const pos of agentPositions) {
  if (brokerSymbols.has(pos.symbol)) {
    result.matched.push(pos.symbol);
  }
}
```

This checks if `pos.symbol` exists at broker. But it's comparing the WRONG position reference!

**Need to verify**:
- Is `state.positions` actually holding the position?
- Or is it being dropped between reconciles?

---

## IMMEDIATE ACTIONS

### 1. Fix State Sync (Critical)
```typescript
// In event_handler_mvp.ts:reconcileStartup(), add after line 261:
syncConfigPositions(configId, state);
```

### 2. Investigate Wrong Position
```bash
# Query Tradier for order history
curl -H "Authorization: Bearer $TRADIER_TOKEN" \
  "https://api.tradier.com/v1/accounts/6YA51425/orders" \
  | jq '.orders.order[] | select(.option_symbol | contains("260423")) | {time: .create_time, symbol: .option_symbol, status: .status}'
```

### 3. Fix Config Reload (Medium Priority)
```typescript
// In event_handler_mvp.ts:reloadConfig(), preserve positions:
const existingState = configs.get(configId);
configs.set(configId, {
  config: cfg,
  positions: existingState?.positions || new Map(),
  lastEntryTs: existingState?.lastEntryTs || 0,
  dailyPnl: existingState?.dailyPnl || 0,
  tradesCompleted: existingState?.tradesCompleted || 0,
  sessionSignalCount: existingState?.sessionSignalCount || 0,
  basketMembers: existingState?.basketMembers || new Map(),
});
```

---

## Questions for User

1. **Who opened SPXW260423C07105000?**
   - Old polling agent?
   - Manual trade?
   - Event handler (but which config)?

2. **Was the wrong strike intentional?**
   - Or did signal detection emit the wrong contract?

3. **What should the correct position be?**
   - PUT or CALL?
   - Which expiry?
   - Which strike?

4. **Should we close the wrong position manually?**
   - Or let it ride?

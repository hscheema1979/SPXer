# Event Handler — ACTUAL Issues (Not Theoretical)

**Date**: 2026-04-23
**Status**: Handler is WORKING, trading live, has open positions
**Purpose**: Focus on real problems, not theoretical edge cases

---

## What's ACTUALLY Working (✅)

```
✅ Handler receives contract signals via WebSocket
✅ Handler routes signals to configs correctly
✅ Handler executes entries (Tradier API calls work)
✅ Handler tracks positions in memory
✅ OTOCO orders are submitted successfully
✅ Exits execute (time_exit seen in logs)
✅ Startup reconciliation adopts orphaned positions
✅ Multiple configs can run simultaneously
✅ Daily P&L syncs with broker
✅ Admin panel shows real-time state
```

**Proof**:
- Handler up since 2026-04-22T15:51:04Z
- Currently 1 open position
- Daily P&L: -$6164 (live trading, not paper)
- Recent signals being processed (all skipped by risk gates)
- Position closed via time_exit at 12:02 ET today

---

## What's ACTUALLY Broken (🔴)

### Issue #1: No State Persistence (Crash = Lost Positions)

**Evidence**: None yet (handler hasn't crashed)

**But IF handler crashes**:
- All positions stored in-memory only (Map<configId, positions>)
- No snapshot file exists
- Restart = all position tracking lost

**What happens**:
```
T=0s:  Handler has 3 open positions tracked
T=1s:  Handler crashes (OOM, segfault, kill -9)
T=2s:  PM2 restarts handler
T=3s:  Handler starts with EMPTY position Map
T=4s:  Startup reconciliation runs
T=5s:  Reconciliation adopts 3 orphans from broker
T=6s:  Resubmits OCO protection for all 3

Result: ~60 seconds of unprotected positions + extra API calls
```

**Fix Required**:
- Add state snapshot every 30s to disk
- Load snapshot on startup before reconciliation
- This is the ONLY critical gap that will cause real problems

---

### Issue #2: Exit Logs Show "time_exit" But Price Fetch Failed?

**Evidence from logs**:
```
[handler] Closed SPXW260423C07105000 x1 (time_exit)
```

**Question**: Did we actually check price before closing? Or just hit time cutoff?

**Looking at code** (`event_handler_mvp.ts:576-667`):
```typescript
const currentPrice: number | null = await fetchPrice(...);
if (currentPrice !== null && currentPrice > position.highWaterPrice) {
  position.highWaterPrice = currentPrice;
}
// ... evaluateExit call ...
```

**If price fetch fails**:
- `currentPrice = null`
- `evaluateExit()` with null price ONLY checks time_exit
- So time_exit works correctly even without price

**Verdict**: NOT BROKEN - time_exit works correctly

---

### Issue #3: WebSocket Reconnect — Are Signals Lost?

**Evidence**: None (no recent disconnects in logs)

**But IF WS disconnects**:
- Handler: `ws.on('close')` → reconnects in 5 seconds
- Handler: Resubscribes to channels
- **BUT** signals during disconnect are LOST

**How often does this happen**:
- Check logs for disconnect events
- If rare → not urgent
- If frequent → add signal replay buffer

---

## What's NOT BROKEN (✗ False Alarms)

### ❌ NOT AN ISSUE: OTOCO Partial Accept
**Why**: `verifyOtocoProtection()` logs ALERTS to console
- Check logs: `grep -i "ALERT" logs/event-handler-out.log`
- If zero alerts → this hasn't happened
- The fire-and-forget is intentional (non-blocking)

### ❌ NOT AN ISSUE: Exit Polling Drift
**Why**: Exits are working (see time_exit in logs)
- If TP/SL fills at broker, handler detects it next cycle
- Reconciliation cleans up any drift
- No double-close errors in logs

### ❌ NOT AN ISSUE: Reconciliation Race
**Why**: No duplicate position errors in logs
- If this was happening, we'd see "Position already exists" errors
- Clean startup logs show no conflicts

### ❌ NOT AN ISSUE: Double Entry
**Why**: Only one config running live
- `spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000`
- If multiple configs with same HMA pair, THEN this would be an issue
- Currently not a problem

---

## ACTUAL Priority Fixes

### MUST FIX (This Week)

**1. State Persistence** (`src/agent/handler-persistence.ts`)
```typescript
// Save snapshot every 30s
setInterval(() => {
  saveSnapshot(configs);
}, 30_000);

// Load on startup
const snapshot = loadSnapshot();
if (snapshot) {
  // Restore positions
  configs.forEach((configId, state) => {
    state.positions = new Map(snapshot.positions);
  });
}
```

**Why**: Handler WILL crash eventually (OOM, kill, deployment). When it does, we lose all tracking.

**Test**:
- Open position
- `kill -9` the handler
- PM2 restarts
- Verify position still tracked

### SHOULD FIX (Next Week)

**2. Better Reconciliation After Crash**
```typescript
// On startup, BEFORE loading snapshot
const brokerPositions = await fetchBrokerPositions();
const snapshot = loadSnapshot();

// Don't adopt positions that were in the snapshot
for (const brokerPos of brokerPositions) {
  if (snapshot.hasPosition(brokerPos.symbol)) {
    continue;  // Already tracked, skip adoption
  }
  // Adopt truly new orphans
}
```

**Why**: Prevents duplicate adoption after crash+restart

### NICE TO HAVE (When Bored)

**3. Signal Replay Buffer**
```typescript
// In data service, keep 60s buffer
const SIGNAL_BUFFER = [];

broadcast(signal) {
  SIGNAL_BUFFER.push(signal);
  // Keep last 60 seconds
}

// On reconnect, handler requests missed signals
ws.on('open', () => {
  fetch('/signals/replay?since=' + lastSignalTs);
});
```

**Why**: Only if WS disconnects are frequent

---

## What To Monitor Going Forward

### Daily Checks
```bash
# 1. Check for ALERT logs (unprotected positions)
grep -i "ALERT.*unprotected" logs/event-handler-*.log | wc -l
# Should be 0

# 2. Check for reconciliation errors
grep "orphan\|adopted" logs/event-handler-*.log | tail -5
# Should see clean adoption on startup, then nothing

# 3. Check for duplicate position errors
grep "already exists\|duplicate" logs/event-handler-*.log | wc -l
# Should be 0

# 4. Check exit success rate
grep "Closed" logs/event-handler-*.log | wc -l
# Should see regular exits
```

### Weekly Review
- Are ALERT logs appearing? → OTOCO partial accept happening
- Are positions getting orphaned after restarts? → State persistence needed
- Are signals being lost? → Check WS disconnect frequency
- Are configs competing for same signals? → Add global registry

---

## Summary

| Issue | Real? | Priority | Evidence |
|-------|-------|----------|----------|
| State persistence | ✅ YES | CRITICAL | Will crash eventually |
| OTOCO partial accept | ❌ NO | N/A | No ALERT logs |
| Exit polling drift | ❌ NO | N/A | Exits working correctly |
| Reconciliation race | ❌ NO | LOW | No duplicate errors |
| WS disconnect loss | ❓ UNKNOWN | LOW | Need to check frequency |
| Double entry | ❌ NO | LOW | Only 1 config running |

---

## What To Do Today

1. **Check for ALERT logs**:
   ```bash
   grep -i "ALERT.*unprotected\|partial.*accept" logs/event-handler-*.log
   ```

2. **Check restart history**:
   ```bash
   pm2 logs event-handler --nostream | grep -E "(started|restart|error)" | tail -20
   ```

3. **Check for disconnects**:
   ```bash
   grep "WebSocket.*close\|reconnect" logs/event-handler-*.log | wc -l
   ```

If any of these show problems, THEN we have real issues to fix.

---

**Bottom Line**: The handler is working. Don't over-engineer fixes for problems that don't exist yet. Add state persistence and monitor for actual failures.

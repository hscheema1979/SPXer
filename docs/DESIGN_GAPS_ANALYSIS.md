# SPXer Design Gaps — Service Execution Analysis

**Date**: 2026-04-23
**Purpose**: Identify gaps, race conditions, and failure modes across services

---

## Service Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ DATA SERVICE (src/index.ts)                                        │
│  • Polls Tradier/Yahoo for SPX & options                           │
│  • Builds 1m bars with indicators                                  │
│  • Detects HMA crosses on contract bars                           │
│  • Emits WebSocket events                                         │
└───────────────────┬─────────────────────────────────────────────────┘
                    │ WebSocket (ws://localhost:3600/ws)
                    │ broadcast({ type: 'contract_signal', ... })
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ EVENT HANDLER (event_handler_mvp.ts)                              │
│  • Subscribes to WS channels                                      │
│  • Routes signals to configs                                     │
│  • Calls openPosition() / closePosition()                         │
│  • Tracks state in-memory                                         │
└───────────────────┬─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ TRADE EXECUTOR (src/agent/trade-executor.ts)                      │
│  • HTTP calls to Tradier API                                      │
│  • Submits OTOCO bracket orders                                   │
│  • Cancels orders on exit                                         │
└───────────────────┬─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ TRADIER BROKER                                                     │
│  • Holds positions                                                 │
│  • Executes TP/SL via OCO legs                                   │
│  • Returns fills/rejections                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## CRITICAL GAP #1: Signal → Entry Race Condition

### Flow
```
1. Data Service: detectContractSignals() → broadcast(contract_signal)
2. WebSocket: broadcast() → sends to all subscribers
3. Event Handler: handleContractSignal() → processes signal
4. Event Handler: openPosition() → calls Tradier API
5. Trade Executor: waitForFill() → polls for 5 seconds
6. Event Handler: adds position to Map (AFTER fill)
```

### The Gap

**Problem**: Between step 1 and step 6, there's a **6-10 second window** where:
- The position exists at Tradier (filled)
- The position does NOT exist in the handler's Map
- If handler crashes during this window → position is orphaned

**Scenario**:
```
T=0s:  Signal emitted
T=1s:  Handler receives signal
T=2s:  Handler calls openPosition()
T=3s:  Tradier receives order
T=5s:  Tradier fills order
T=6s:  waitForFill() confirms fill
T=7s:  Handler adds to Map  ← CRASH HERE
T=8s:  Handler dies

Result: Position open at broker, but handler never tracked it
```

**Impact**:
- Next reconcile cycle (60s later) will adopt it
- But for 60 seconds, position is **unprotected** (no OCO verification)
- If reversal signal comes in, handler won't close it (doesn't know it exists)

**Missing Code**:
```typescript
// In event_handler_mvp.ts, openPosition() should add to Map IMMEDIATELY
// not after fill confirmation:

// CURRENT (broken):
const result = await openPosition(...);
if (result.position.quantity > 0) {
  state.positions.set(posId, result.position); // Too late!
}

// SHOULD BE:
state.positions.set(posId, { ...result.position, status: 'pending' });
const result = await openPosition(...);
if (result.position.quantity > 0) {
  state.positions.set(posId, { ...result.position, status: 'open' });
} else {
  state.positions.delete(posId); // Entry failed
}
```

---

## CRITICAL GAP #2: OTOCO Partial Accept → Silent Failure

### Flow
```
1. Trade Executor: submitOtocoOrder()
   → Sends OTOCO with 3 legs: entry, TP, SL

2. Tradier: Returns { order: { id: 12345, leg: [...] }}

3. Trade Executor: verifyOtocoProtection() [FIRES AND FORGETS]
   → Polls for leg status
   → If TP/SL rejected: logs ALERT
   → But handler doesn't wait for this!

4. Event Handler: Assumes position is protected
   → Returns from openPosition()
   → Never checks if verifyOtocoProtection() found issues
```

### The Gap

**Problem**: `verifyOtocoProtection()` is **fire-and-forget** - it runs in background but the handler doesn't check the result.

**Scenario**:
```
T=0s:  submitOtocoOrder() → Tradier
T=1s:  Tradier: "Entry filled, TP rejected, SL rejected"
T=2s:  verifyOtocoProtection() starts polling
T=3s:  Handler returns from openPosition() ← ASSUMES PROTECTED
T=5s:  verifyOtocoProtection() logs ALERT
T=6s:  But handler already moved on — position UNPROTECTED

Result: Position open, no TP/SL at broker, handler thinks it's protected
```

**Missing Code**:
```typescript
// In trade-executor.ts, verifyOtocoProtection() should return Promise:

// CURRENT (broken):
export function verifyOtocoProtection(...): void {
  (async () => {
    const legs = await waitForOtocoLegs(...);
    if (tpMissing || slMissing) {
      console.error('ALERT');  // Logs but nobody checks
    }
  })();
  // Returns immediately!
}

// SHOULD BE:
export async function verifyOtocoProtection(...): Promise<{ verified: boolean; legs?: any }> {
  const legs = await waitForOtocoLegs(...);
  const tpMissing = legs.tp === 'rejected' || legs.tp === 'canceled';
  const slMissing = legs.sl === 'rejected' || legs.sl === 'canceled';

  if (legs.entry === 'filled' && (tpMissing || slMissing)) {
    console.error('ALERT: Partial OTOCO accept');
    return { verified: false, legs };
  }

  return { verified: true, legs };
}

// In event_handler_mvp.ts:
const ocoResult = await submitOcoProtectionWithRetry(...);
const verifyResult = await verifyOtocoProtection(result.position, TRADIER_ACCOUNT_ID);

if (!verifyResult.verified) {
  // Position unprotected — close it or submit standalone OCO
  console.error('Closing unprotected position');
  await closePosition(...);
}
```

---

## CRITICAL GAP #3: Exit Polling → State Drift

### Flow
```
1. Event Handler: checkExits() runs every 10s
   → Fetches current price from data service
   → Calls evaluateExit() → checks TP/SL hit
   → If exit: calls closePosition()

2. Trade Executor: closePosition()
   → Pre-flight: checks if position exists at broker
   → Cancels OCO legs
   → Submits market sell
   → waitForFill() for 5 seconds

3. Event Handler: Deletes from Map
   → But what if Tradier already closed it (TP/SL fill)?
```

### The Gap

**Problem**: Handler checks exits based on local price, but Tradier might have already closed the position.

**Scenario**:
```
T=0s:  TP hit at Tradier (OCO leg fills)
T=1s:  Position closed at broker
T=5s:  Handler: checkExits() → fetches price $17.50
T=6s:  Handler: "TP not hit locally" (wrong price source?)
T=7s:  Handler: tries to closePosition()
T=8s:  Trade Executor: "Position not found at broker"
T=9s:  Handler: Confused, deletes from Map anyway

Result: Double-close attempt, confusing logs, state drift
```

**Missing Code**:
```typescript
// In event_handler_mvp.ts, checkExits() should:

// 1. Check broker state FIRST (before checking TP/SL locally)
const brokerPositions = await fetchBrokerPositions(TRADIER_ACCOUNT_ID);
const stillOpen = brokerPositions.some(p => p.symbol === position.symbol);

if (!stillOpen) {
  // Already closed at broker (TP/SL filled)
  state.positions.delete(posId);
  state.tradesCompleted++;
  console.log(`Position ${position.symbol} closed at broker (TP/SL fill)`);
  continue;  // Skip local TP/SL check
}

// 2. Only check local exits if still open at broker
const exitDecision = evaluateExit(...);
```

**Current Code Issue**:
- `checkExits()` doesn't check broker state before checking TP/SL
- It assumes local Map = broker state
- But they can drift apart (especially with OTOCO orders)

---

## CRITICAL GAP #4: Reconciliation → Race with Entry

### Flow
```
1. Event Handler: handleContractSignal() → enters position
2. Event Handler: reconcileWithBroker() runs every 60s
   → Fetches broker positions
   → Compares with local Map
```

### The Gap

**Problem**: Reconciliation can run **while entry is in progress**, causing it to "adopt" a position that's being tracked.

**Scenario**:
```
T=0s:  handleContractSignal() → calls openPosition()
T=1s:  Position added to pendingEntries (not in Map yet)
T=2s:  reconcileWithBroker() runs
T=3s:  Broker has position, handler Map doesn't
T=4s:  Reconciliation: "Orphan found! Adopting..."
T=5s:  Reconciliation adds to Map
T=6s:  openPosition() completes
T=7s:  openPosition() tries to add to Map → DUPLICATE!

Result: Same position tracked twice, or second add silently fails
```

**Missing Code**:
```typescript
// In event_handler_mvp.ts:

// Add a global entry lock for entire handler:
const entryInProgress = new Set<string>();  // symbol → timestamp

async function handleContractSignal(signal) {
  // Check if entry already in progress for this symbol
  if (entryInProgress.has(signal.symbol)) {
    console.log(`Entry already in progress for ${signal.symbol}, skipping`);
    return;
  }

  entryInProgress.add(signal.symbol);

  try {
    // ... existing entry logic ...
  } finally {
    // Remove from in-progress set AFTER completion
    setTimeout(() => entryInProgress.delete(signal.symbol), 5000);
  }
}

// In reconcileWithBroker():
// Skip positions that are in entryInProgress:
for (const orphan of adopted) {
  if (entryInProgress.has(orphan.symbol)) {
    console.log(`Skipping adoption of ${orphan.symbol} (entry in progress)`);
    continue;
  }
  // ... adopt ...
}
```

---

## CRITICAL GAP #5: WebSocket Disconnect → Signal Loss

### Flow
```
1. Data Service: Detects signal → broadcast()
2. WebSocket: ws.send() to all clients
3. Event Handler: ws.on('message') → handleContractSignal()
```

### The Gap

**Problem**: If WebSocket disconnects, signals are **lost forever**. There's no replay mechanism.

**Scenario**:
```
T=0s:  Data Service: HMA cross detected
T=1s:  WebSocket: broadcast() → tries to send
T=2s:  WebSocket: Connection lost (ws.readyState !== OPEN)
T=3s:  Signal dropped, never reaches handler
T=4s:  WebSocket reconnects
T=5s:  Handler resubscribes
T=6s:  But the T=0s signal is GONE

Result: Missed entry, no recovery possible
```

**Missing Design**:
```typescript
// Option 1: Signal buffer at data service
// In src/index.ts:

const SIGNAL_BUFFER: any[] = [];
const SIGNAL_BUFFER_MAX_MS = 60_000;  // Keep 60s of signals

function broadcast(message: object): void {
  // Buffer contract signals
  if (message.type === 'contract_signal') {
    SIGNAL_BUFFER.push(message);
    // Clean old signals
    const now = Date.now();
    while (SIGNAL_BUFFER.length > 0 && now - SIGNAL_BUFFER[0].ts > SIGNAL_BUFFER_MAX_MS) {
      SIGNAL_BUFFER.shift();
    }
  }

  // ... existing broadcast logic ...
}

// Add REST endpoint to replay signals
app.get('/signals/replay', (req, res) => {
  const since = parseInt(req.query.since || '0');
  const signals = SIGNAL_BUFFER.filter(s => s.ts > since);
  res.json(signals);
});

// Option 2: Handler requests missed signals on reconnect
// In event_handler_mvp.ts:

ws.on('open', () => {
  // Request signals since last seen
  const lastSeenTs = getLastSignalTimestamp();  // Persisted to disk
  fetch(`http://localhost:3600/signals/replay?since=${lastSeenTs}`)
    .then(r => r.json())
    .then(signals => {
      console.log(`Replaying ${signals.length} missed signals`);
      for (const sig of signals) {
        handleContractSignal(sig);
      }
    });
});
```

---

## CRITICAL GAP #6: Exit → Price Fetch Failure

### Flow
```
1. Event Handler: checkExits() → needs current price
2. Event Handler: fetch(/contracts/{symbol}/latest)
3. Data Service: Returns latest bar
4. Event Handler: evaluateExit(currentPrice, ...)
```

### The Gap

**Problem**: If price fetch fails, exit is **skipped entirely** - even for time-based exits.

**Scenario**:
```
T=0s:  checkExits() runs
T=1s:  Fetch price for SPXW123...
T=2s:  Network error / timeout / 500 error
T=3s:  currentPrice = null
T=4s:  evaluateExit() returns null (no exit)
T=5s:  But time_exit should have triggered!

Result: Position stays open past time cutoff
```

**Missing Code**:
```typescript
// In event_handler_mvp.ts, checkExits():

const currentPrice: number | null = await fetchPrice(position.symbol);
const closeCutoffTs = computeCloseCutoff(state.config);

// NEW: Check time-based exits even if price unavailable
const now = Date.now();
if (now >= closeCutoffTs) {
  // Time cutoff reached — exit even without price
  positionsToClose.push({
    posId,
    position,
    reason: 'time_exit',
    closePrice: position.entryPrice  // Use entry price as fallback
  });
  continue;
}

// Only check TP/SL if we have a price
if (currentPrice !== null) {
  const exitDecision = evaluateExit(..., currentPrice, ...);
  if (exitDecision) {
    positionsToClose.push(...);
  }
}
```

**Current Code Issue**:
- `evaluateExit()` with `currentPrice=null` only checks time_exit
- But if fetch fails completely (exception), we skip the entire position
- Need to separate: fetch failure vs no data available

---

## CRITICAL GAP #7: Multiple Configs → Same Signal → Double Entry

### Flow
```
1. Data Service: Emits contract_signal
2. Event Handler: Routes to ALL matching configs
3. Config A: "Enter!" → opens position
4. Config B: "Enter!" → opens SAME position
```

### The Gap

**Problem**: Two configs with same HMA pair will both see the same signal and enter the same position.

**Scenario**:
```
Config A: spx-hma3x12-itm5-tp30x...
Config B: spx-hma3x12-atm-tp30x...

Signal: HMA(3)×HMA(12) cross on SPXW260423C07100000

T=0s:  Signal emitted
T=1s:  Config A: "Matches! Enter!"
T=2s:  Config B: "Matches! Enter!"
T=3s:  Config A opens 7x SPXW...
T=4s:  Config B opens 7x SPXW...

Result: 14 contracts total, double exposure
```

**Missing Design**:
```typescript
// Option 1: Global position registry
// In event_handler_mvp.ts:

const globalPositions = new Map<string, Set<string>>();  // symbol → configIds

async function handleContractSignal(signal) {
  // Check if ANY config already has this position
  const existingConfigs = globalPositions.get(signal.symbol) || new Set();

  for (const [configId, state] of configStatesArray) {
    // Skip if another config already owns this position
    if (existingConfigs.size > 0 && !existingConfigs.has(configId)) {
      console.log(`[${configId}] Skipping ${signal.symbol} — owned by ${Array.from(existingConfigs).join(', ')}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'position_owned_by_other_config' });
      continue;
    }

    // ... existing entry logic ...

    if (result.position.quantity > 0) {
      // Register ownership
      if (!globalPositions.has(signal.symbol)) {
        globalPositions.set(signal.symbol, new Set());
      }
      globalPositions.get(signal.symbol)!.add(configId);
    }
  }
}

// Option 2: First-come-first-served locking
// (Use entryInProgress Set from Gap #4)
```

---

## Summary of Critical Gaps

| Gap | Severity | Impact | Fix Complexity |
|-----|----------|--------|----------------|
| #1 Signal→Entry race | HIGH | Orphan positions, unprotected | Medium (add pending state) |
| #2 OTOCO partial accept | CRITICAL | Position unprotected, no TP/SL | High (change API contract) |
| #3 Exit polling drift | HIGH | Double-close, state confusion | Medium (check broker first) |
| #4 Reconciliation race | MEDIUM | Duplicate tracking | Low (add entry lock) |
| #5 WS disconnect loss | MEDIUM | Missed entries | High (signal buffer) |
| #6 Price fetch failure | MEDIUM | Missed time exits | Low (add fallback) |
| #7 Double entry | MEDIUM | Double exposure | Medium (global registry) |

---

## Recommended Fix Priority

### Phase 1 (Immediate - CRITICAL)
1. **Gap #2**: Fix OTOCO partial accept detection
2. **Gap #3**: Fix exit polling to check broker state first

### Phase 2 (This Week - HIGH)
3. **Gap #1**: Add pending position state
4. **Gap #4**: Add entry lock for reconciliation

### Phase 3 (Next Week - MEDIUM)
5. **Gap #6**: Add fallback for price fetch failure
6. **Gap #7**: Add global position registry
7. **Gap #5**: Add signal replay buffer

---

## Open Questions for Architecture Review

1. **Should we use a distributed lock?**
   - Current: In-memory Map (single process)
   - Gap #4 assumes single handler process
   - What if we run 2 handlers for redundancy?

2. **Should signals be idempotent?**
   - Add `signalId` to each signal
   - Track processed signals
   - Prevent double-processing

3. **Should we use a message queue?**
   - Replace WebSocket with Redis/RabbitMQ
   - Durable delivery, replay built-in
   - But adds complexity + new dependency

4. **Should state be in a database?**
   - Replace in-memory Map with SQLite
   - Survives crashes
   - But adds latency (DB queries on every signal)

5. **How to handle partial fills?**
   - OTOCO: entry fills for 5/7 contracts
   - TP/SL calculated on full 7 contracts
   - Need to adjust TP/SL for actual fill qty

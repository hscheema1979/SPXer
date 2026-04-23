# Event-Driven Handler Architecture — Reference Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Data Service                             │
│                         (src/index.ts)                          │
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ ThetaData WS │───▶│ PriceLine    │───▶│ detectSignals│      │
│  │ (primary)    │    │ (validation) │    │              │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                     │             │
│                                                     ▼             │
│                                          ┌──────────────────┐    │
│                                          │ broadcast()       │    │
│                                          │ { type:          │    │
│                                          │   'contract_     │    │
│                                          │   signal',       │    │
│                                          │   channel:       │    │
│                                          │   'hma_3_12' }   │    │
│                                          └────────┬─────────┘    │
└───────────────────────────────────────────────────┼────────────────┘
                                                    │
                                                    │ WebSocket (ws://localhost:3600/ws)
                                                    │
┌───────────────────────────────────────────────────┼────────────────┐
│                                                   ▼                 │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │           Event Handler (event_handler_mvp.ts)            │    │
│  │                                                             │    │
│  │  ┌─────────────┐    ┌─────────────┐    ┌──────────────┐  │    │
│  │  │ WS          │───▶│ Handle      │───▶│ Route to     │  │    │
│  │  │ Subscribe   │    │ Contract    │    │ Configs      │  │    │
│  │  │ (hma_3_12)  │    │ Signal      │    │ (N configs)  │  │    │
│  │  └─────────────┘    └──────┬──────┘    └──────┬───────┘  │    │
│  │                            │                   │            │    │
│  │                            ▼                   ▼            │    │
│  │                     ┌─────────────┐    ┌──────────────┐  │    │
│  │                     │ Signal      │    │ Config       │  │    │
│  │                     │ Deduplication│   │ Filtering    │  │    │
│  │                     │ (hash check)│   │ (HMA pair,   │  │    │
│  │                     └──────┬──────┘    │  direction,  │  │    │
│  │                            │           │  risk gates) │  │    │
│  │                            ▼           └──────┬───────┘  │    │
│  │                     ┌─────────────┐            │            │    │
│  │                     │ Entry Lock  │            │            │    │
│  │                     │ (per config)│            │            │    │
│  │                     └──────┬──────┘            │            │    │
│  │                            │                   │            │    │
│  │                            ▼                   ▼            │    │
│  │                     ┌─────────────────────────────┐       │    │
│  │                     │ openPosition()              │       │    │
│  │                     │ (Tradier API)               │       │    │
│  │                     └──────────────┬──────────────┘       │    │
│  │                                    │                     │    │
│  │                                    ▼                     │    │
│  │                     ┌─────────────────────────────┐       │    │
│  │                     │ submitOcoProtection()       │       │    │
│  │                     │ (TP + SL bracket order)     │       │    │
│  │                     └──────────────┬──────────────┘       │    │
│  │                                    │                     │    │
│  │                                    ▼                     │    │
│  │                     ┌─────────────────────────────┐       │    │
│  │                     │ Track Position              │       │    │
│  │                     │ (Map<configId, Position>)    │       │    │
│  │                     └──────────────┬──────────────┘       │    │
│  │                                    │                     │    │
│  │                                    ▼                     │    │
│  │                     ┌─────────────────────────────┐       │    │
│  │                     │ Save Snapshot               │       │    │
│  │                     │ (every 30s)                 │       │    │
│  │                     └─────────────────────────────┘       │    │
│  │                                                            │    │
│  │  ─────────────────────────────────────────────────────────  │    │
│  │  BACKGROUND LOOPS (run every 10-60s)                       │    │
│  │  ─────────────────────────────────────────────────────────  │    │
│  │                                                            │    │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐│    │
│  │  │ Check Exits  │───▶│ Sync Broker   │───▶│ Retry DLQ    ││    │
│  │  │ (TP/SL/      │    │ P&L          │    │ (failed      ││    │
│  │  │  reversal)   │    │ (every 60s)  │    │  signals)    ││    │
│  │  └──────────────┘    └──────────────┘    └──────────────┘│    │
│  │                                                            │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

                              │
                              │ Trade Execution
                              ▼

┌─────────────────────────────────────────────────────────────────┐
│                         Tradier Broker                           │
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Account     │───▶│ Orders      │───▶│ Positions    │      │
│  │ 6YA51425    │    │ (entry/OCO) │    │ (open/closed)│      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Edge Case Locations

### 🔴 Critical (Fix Immediately)

1. **Exit Polling (checkExits loop)**
   - Location: Handler → Check Exits
   - Problem: Price fetch fails → position drift
   - Fix: Add `safeClosePosition()` with broker state check

2. **OCO Protection (after openPosition)**
   - Location: Handler → Submit OCO
   - Problem: Tradier API fails → position unprotected
   - Fix: Add retry with escalation + critical alerts

3. **State Persistence (handler crash)**
   - Location: Handler → Track Position
   - Problem: Crash → lost positions
   - Fix: Add snapshot every 30s + load on startup

### 🟡 High Priority (Fix This Week)

4. **Signal Deduplication (handleContractSignal)**
   - Location: Handler → Handle Contract Signal
   - Problem: Same signal processed twice → double entry
   - Fix: Add hash-based dedup (5-second window)

5. **Entry Lock (per config)**
   - Location: Handler → Route to Configs
   - Problem: Multiple signals arrive → over-entry
   - Fix: Add entry lock per config

### 🟢 Medium Priority (Fix Next Sprint)

6. **Strike Selection (handleContractSignal)**
   - Location: Handler → Config Filtering → Strike Selection
   - Problem: Signal strike not in active contracts
   - Fix: Add validation + fallback

7. **Dead Letter Queue (failed entries)**
   - Location: Handler → openPosition()
   - Problem: Transient errors → lost signals
   - Fix: Add DLQ with retry

---

## Data Flow Diagram

### Happy Path (Signal → Position)

```
1. Data Service detects HMA cross on option bar
   ├─ SPXW260423P07090000 @ $13.50
   ├─ HMA(3) crosses HMA(12) upward
   └─ Emits: { type: 'contract_signal', channel: 'hma_3_12', data: {...} }

2. Event Handler receives via WebSocket
   ├─ Parse signal
   ├─ Compute hash: "SPXW260423P07090000:3x12:bullish:1713813600"
   ├─ Check seenSignals → not seen, proceed
   └─ Route to all configs

3. Config "spx-hma3x12" evaluates
   ├─ HMA pair matches (3×12)
   ├─ Direction matches (bullish → call)
   ├─ Risk gates pass (max positions: 0/1)
   ├─ Time window OK (10:15 AM ET)
   └─ Entry lock not held → proceed

4. Strike Selection
   ├─ Fetch active contracts from data service
   ├─ Filter by expiry (2026-04-23) and side (call)
   ├─ Select strike closest to $15 OTM target
   └─ Result: SPXW260423C07100000 @ $14.00

5. Entry Execution
   ├─ Compute qty: 7 contracts (from $10K buying power)
   ├─ Call openPosition() → Tradier API
   ├─ Tradier fills @ $14.00
   └─ Position opened: { id: "abc-123", symbol: "...", quantity: 7, ... }

6. OCO Protection
   ├─ Call submitOcoProtection()
   ├─ TP: $14.00 × 1.25 = $17.50
   ├─ SL: $14.00 × 0.80 = $11.20
   ├─ Tradier creates OCO order #98765
   └─ Position now protected at broker

7. State Tracking
   ├─ Add to Map<configId, positions>
   ├─ Save snapshot to disk
   └─ Record routing decision to log

8. Background Monitoring
   ├─ Every 10s: Check exits (TP/SL hit? Reversal?)
   ├─ Every 60s: Sync broker P&L
   └─ Every 30s: Save snapshot
```

### Edge Case: Signal Deduplication

```
1. First signal arrives
   ├─ Hash: "SPXW260423P07090000:3x12:bullish:1713813600"
   ├─ seenSignals.set(hash, timestamp)
   └─ Process normally → position opened

2. Duplicate signal arrives 2 seconds later
   ├─ Same hash (same 5-second time bucket)
   ├─ seenSignals.has(hash) → true
   ├─ timestamp diff: 2s < 5s window
   └─ Skip: "Duplicate signal, skipping"

3. Same signal arrives 6 seconds later
   ├─ Same hash but different time bucket
   ├─ seenSignals.has(hash) → false (or old timestamp)
   ├─ Process as new signal
   └─ But: entry lock held → "Entry already in progress, skipping"
```

### Edge Case: Exit with Broker State Check

```
1. Exit check runs (every 10s)
   ├─ Fetch position price: $11.00
   ├─ Check SL: $11.00 < $11.20 → SL hit
   └─ Call safeClosePosition()

2. safeClosePosition() executes
   ├─ Call closePosition() → Tradier API
   ├─ Tradier returns error: "Position not found"
   ├─ Catch block: check broker state
   ├─ Call fetchBrokerPositions()
   ├─ Broker returns: [] (empty)
   └─ Return: { success: true, reason: 'closed_at_broker_tpsl' }

3. Handler updates local state
   ├─ Delete position from Map
   ├─ Increment tradesCompleted
   └─ Log: "Closed SPXW... (closed_at_broker_tpsl, confirmed at broker)"
```

### Edge Case: OCO Failure with Critical Alert

```
1. Position opened
   ├─ Call submitOcoProtectionWithRetry()
   ├─ Attempt 1 (0ms): Tradier error "500 Internal Server Error"
   ├─ Wait 500ms
   ├─ Attempt 2: Tradier error "503 Service Unavailable"
   ├─ Wait 2000ms
   ├─ Attempt 3: Tradier error "timeout"
   ├─ Wait 5000ms
   ├─ Attempt 4: Tradier error "rate limit exceeded"
   └─ All 4 attempts failed

2. Critical handling
   ├─ Log: "🚨 CRITICAL: Failed to submit OCO... Position is UNPROTECTED"
   ├─ Write to logs/critical-alerts.jsonl
   ├─ Return: { success: false, error: "..." }
   └─ Handler decides: close position for safety

3. Safety close
   ├─ Call closePosition() → market sell @ $14.00
   ├─ Position closed
   └─ Log: "Closed SPXW... (oco_failed)"

4. Monitoring
   ├─ Alerting system reads logs/critical-alerts.jsonl
   ├─ Sends page: "CRITICAL: OCO protection failed"
   └─ Ops investigates Tradier API status
```

---

## State Persistence Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Handler Lifecycle                           │
│                                                                   │
│  STARTUP                                                          │
│  ├─ Load configs from DB                                         │
│  ├─ Load snapshot from disk (if exists & <24h old)              │
│  │  ├─ Restore positions                                        │
│  │  ├─ Restore basket members                                   │
│  │  ├─ Restore P&L, trade counts, etc.                          │
│  │  └─ Merge with loaded configs                                │
│  ├─ Reconcile with broker (adopt orphans)                       │
│  └─ Start snapshot timer (30s interval)                          │
│                                                                   │
│  RUNTIME (every 30s)                                             │
│  ├─ Collect all config state                                    │
│  ├─ Serialize positions to JSON                                 │
│  ├─ Write to logs/handler-snapshot.json.tmp                      │
│  ├─ Atomic rename to logs/handler-snapshot.json                  │
│  └─ Continue normal operation                                   │
│                                                                   │
│  CRASH / SHUTDOWN                                                 │
│  ├─ Write final snapshot                                         │
│  ├─ Close WebSocket                                              │
│  ├─ Clear entry locks                                            │
│  └─ Exit                                                         │
│                                                                   │
│  RESTART (after crash)                                           │
│  ├─ Load configs from DB                                         │
│  ├─ Load snapshot → restore all state                           │
│  ├─ Positions restored, continue monitoring                     │
│  └─ Zero data loss (except pendingEntries)                       │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Monitoring & Observability

### Key Metrics to Track

1. **Signal Flow**
   - `filterStats.totalSignalsReceived` — Total contract signals seen
   - `filterStats.totalEntries` — Total entries executed
   - `filterStats.filterReasons` — Why signals were skipped

2. **Exit Health**
   - Exit success rate (successful / attempted)
   - Exit failures by reason (timeout, broker error, etc.)
   - Time to detect TP/SL fills

3. **OCO Health**
   - OCO submission success rate
   - OCO retry attempts distribution
   - Critical alerts count (should be 0)

4. **State Health**
   - Snapshot age (should be <60s)
   - Snapshot restore success rate
   - Position drift (local vs broker)

5. **Error Tracking**
   - DLQ size (failed signals awaiting retry)
   - Entry lock contention (skips due to lock)
   - WebSocket reconnect count

### Log Files to Monitor

```
logs/
├── handler-state.json          # Real-time state (for admin panel)
├── handler-routing.jsonl       # Signal routing decisions
├── handler-snapshot.json       # Latest state snapshot
├── critical-alerts.jsonl       # CRITICAL: Unprotected positions
├── handler-dlq.jsonl           # Dead letter queue
└── exit-failures.jsonl         # Exit failures (if added)
```

### Alerting Rules

```
CRITICAL (page immediately):
- logs/critical-alerts.jsonl has any entry
- DLQ size > 100 entries
- Exit failure rate > 5%

WARNING (email within 5 min):
- WebSocket disconnected > 30s
- Snapshot age > 5 minutes
- OCO submission fails 3+ times in a row

INFO (daily digest):
- Total signals received vs entries
- P&L by config
- Exit reasons breakdown
```

---

**END OF ARCHITECTURE REFERENCE**

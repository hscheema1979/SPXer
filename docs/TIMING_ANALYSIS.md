# Event Handler Timing Analysis — Race Conditions

**Visual representation of time windows where things can break**

---

## Gap #1: Signal → Entry Race Condition (6-10 second window)

```
Data Service          WebSocket            Event Handler         Trade Executor         Tradier
     │                    │                    │                      │                   │
     │ detectContract()    │                    │                      │                   │
     │────────────────────>│                    │                      │                   │
     │                    │ broadcast()         │                      │                   │
     │                    │───────────────────>│                      │                   │
     │                    │                    │ handleContractSignal()│                   │
     │                    │                    │──┐                   │                   │
     │                    │                    │  │ openPosition()    │                   │
     │                    │                    │  │───────────────────>│ submitOtocoOrder()│
     │                    │                    │  │                   │──┐                │
     │                    │                    │  │                   │  │ HTTP POST       │
     │                    │                    │  │                   │  │────────────────>│
     │                    │                    │  │                   │  │                 │ ✅ FILL (3s)
     │                    │                    │  │                   │  │<────────────────│
     │                    │                    │  │                   │<─┘                │
     │                    │                    │  │ waitForFill()      │                   │
     │                    │                    │  │──┐                │                   │
     │                    │                    │  │  │ Poll 1          │                   │
     │                    │                    │  │  │──────────────────>│ GET /orders/{id} │
     │                    │                    │  │  │                 │──┐                │
     │                    │                    │  │  │                 │  │ status=pending  │
     │                    │                    │  │  │                 │<─┘                │
     │                    │                    │  │<─┘                │                   │
     │                    │                    │  │                   │                   │
     │                    │                    │  │ Poll 2           │                   │
     │                    │                    │  │──┐                │                   │
     │                    │                    │  │  │──────────────────>│ GET /orders/{id} │
     │                    │                    │  │  │                 │──┐                │
     │                    │                    │  │  │                 │  │ status=filled   │
     │                    │                    │  │  │                 │<─┘                │
     │                    │                    │  │<─┘                │                   │
     │                    │                    │<─┘                   │                   │
     │                    │                    │                      │                   │
     │                    │                    │ state.positions.set()│                   │
     │                    │                    │◀──────────────────────────────────────────│
     │                    │                    │                      │                   │
     │                    │                    │      ▲               │                   │
     │                    │                    │      │  CRASH HERE    │                   │
     │                    │                    │      │               │                   │
     │                    │                    │   💥 Handler dies    │                   │

TIMELINE:
T=0s   Signal detected
T=1s   Handler receives
T=2s   Calls openPosition()
T=3s   Tradier fills order
T=6s   waitForFill() confirms
T=7s   Adds to Map  ← CRASH (position never tracked!)
```

**The Problem**: Position exists at broker from T=3s, but not in handler Map until T=7s. If handler crashes at T=6.5s, position is orphaned.

---

## Gap #2: OTOCO Partial Accept (Fire-and-Forget)

```
Trade Executor        Tradier              Handler
     │                   │                    │
     │ submitOtoco()     │                    │
     │──────────────────>│                    │
     │                   │──┐                 │
     │                   │  │ Process order   │
     │                   │  │                 │
     │                   │  ├─ Entry: FILLED  │
     │                   │  ├─ TP: REJECTED  │
     │                   │  └─ SL: REJECTED  │
     │                   │<─┘                 │
     │<──────────────────│                    │
     │ return { orderId } │                    │
     │──┐                │                    │
     │  │ verifyOtoco()  │                    │
     │  │ (FIRES & FORGETS)                │
     │  │──────────────>│                    │
     │  │               │──┐                 │
     │  │               │  │ Poll legs      │
     │  │               │  │                 │
     │  │               │  ├─ entry: filled  │
     │  │               │  ├─ tp: rejected   │
     │  │               │  └─ sl: rejected   │
     │  │               │<─┘                 │
     │  │<──────────────│                    │
     │  │ logs "ALERT"  │                    │
     │<─┘               │                    │
     │                   │                    │
     │ return to caller │                    │
     │───────────────────────────────────────>│
     │                   │                    │ Assumes protected!
     │                   │                    │ adds to Map
     │                   │                    │──────────────────>│
     │                   │                    │                   │
     │                   │                    │                   │ 5s later
     │                   │                    │                   │
     │                   │                    │ checkExits() runs
     │                   │                    │◀───────────────────────────────────
     │                   │                    │ "TP/SL in place"
     │                   │                    │                   │
     │                   │                    │                   │ 30 min later
     │                   │                    │                   │
     │                   │                    │                   │ Price moves
     │                   │                    │                   │ No TP to close!
     │                   │                    │                   │ Position loses $$
```

**The Problem**: `verifyOtocoProtection()` runs asynchronously but handler doesn't check the result. Handler assumes protection is in place.

---

## Gap #3: Exit Polling → State Drift

```
Handler (checkExits)     Data Service API         Tradier
     │                        │                       │
     │ Poll every 10s         │                       │
     │──┐                     │                       │
     │  │ GET /contracts/{symbol}/latest            │
     │  │─────────────────────>│                       │
     │  │                     │──┐                     │
     │  │                     │  │ Fetch from DB      │
     │  │                     │  │                     │
     │  │                     │  │ Latest bar: $17.00 │
     │  │                     │<─┘                     │
     │  │<─────────────────────│                       │
     │<─┘                     │                       │
     │ price = $17.00         │                       │
     │                       │                       │
     │ But at Tradier...      │                       │
     │                       │                       │ OCO TP filled!
     │                       │                       │ Position CLOSED
     │                       │                       │
     │ evaluateExit(price)   │                       │
     │ "TP not hit ($17.00 < $17.50)"               │
     │                       │                       │
     │ Try to close          │                       │
     │──┐                   │                       │
     │  │ closePosition()   │                       │
     │  │──────────────────────────────────────────>│
     │  │                  │──┐                     │
     │  │                  │  │ Check positions    │
     │  │                  │  │ "Not found!"       │
     │  │                  │<─┘                     │
     │  │<──────────────────────────────────────────│
     │<─┘                  │                       │
     │ "Position not at broker"                     │
     │ Delete from Map anyway                       │
     │                       │                       │
```

**The Problem**: Handler checks TP/SL based on local price data, but Tradier might have already closed the position. No synchronization.

---

## Gap #4: Reconciliation → Race with Entry

```
Handler (Main Loop)    Handler (Reconcile)    Tradier
     │                       │                    │
     │ handleContractSignal()│                    │
     │──┐                    │                    │
     │  │ openPosition()     │                    │
     │  │────────────────────────────────────────>│
     │  │                   │──┐                 │
     │  │                   │  │ Process order   │
     │  │                   │<─┘                 │
     │  │<────────────────────────────────────────│
     │  │ waitForFill()...   │                    │
     │  │                   │                    │
     │  │                   │ reconcile() runs   │
     │  │                   │──┐                 │
     │  │                   │  │ GET /positions  │
     │  │                   │  │─────────────────>│
     │  │                   │  │                 │──┐
     │  │                   │  │                 │  │ Returns SPXW...
     │  │                   │  │                 │<─┘
     │  │                   │<─┘                 │
     │  │                   │                    │
     │  │                   │ "Orphan found!"    │
     │  │                   │ Add to Map         │
     │  │                   │────────────────────>│
     │  │<──────────────────│                    │
     │  │                   │                    │
     │  │ waitForFill() completes               │
     │  │ Tries to add to Map                    │
     │  │ ✗ ALREADY EXISTS!                      │
     │<─┘                  │                    │
     │ Confusion          │                    │
```

**The Problem**: Reconciliation can adopt a position that's currently being entered, causing duplicate tracking.

---

## Gap #5: WebSocket Disconnect → Signal Loss

```
Data Service           WebSocket            Handler
     │                    │                    │
     │ detectSignal()     │                    │
     │──┐                 │                    │
     │  │ broadcast()      │                    │
     │  │─────────────────>│                    │
     │  │                 │──┐                 │
     │  │                 │  │ ws.send()       │
     │  │                 │  │                 │──┐
     │  │                 │  │                 │  │ Connection lost!
     │  │                 │  │                 │<─┘
     │  │                 │<─┘                 │
     │<─┘                 │                    │
     │                    │                    │
     │ 5s later           │                    │
     │ Another signal     │                    │
     │──┐                 │                    │
     │  │ broadcast()      │                    │
     │  │─────────────────>│                    │
     │  │                 │──┐                 │
     │  │                 │  │ ws.send()       │
     │  │                 │  │ ✗ CLOSED        │
     │  │                 │<─┘                 │
     │<─┘                 │                    │
     │                    │                    │
     │                    │ reconnects         │
     │                    │──┐                 │
     │                    │  │ ws.on('open')   │
     │                    │  │ resubscribe()    │
     │                    │<─┘                 │
     │                    │───────────────────>│
     │                    │                    │
     │                    │   ❌ LOST SIGNALS   │
     │                    │   No replay!       │
```

**The Problem**: No durable delivery. If WS disconnects, signals are lost forever.

---

## Gap #6: Exit → Price Fetch Failure

```
Handler (checkExits)     Data Service API
     │                        │
     │──┐                     │
     │  │ GET /contracts/{symbol}/latest
     │  │─────────────────────>│
     │  │                     │──┐
     │  │                     │  │ Query DB
     │  │                     │  │
     │  │                     │  │ Network error!
     │  │                     │<─┘
     │  │ 500 error           │
     │  │<─────────────────────│
     │<─┘                     │
     │ catch (e) { skip }      │
     │                        │
     │ Position never checked │
     │ for time_exit!         │
     │                        │
```

**The Problem**: If price fetch fails, entire position is skipped - even time-based exits.

---

## Gap #7: Multiple Configs → Double Entry

```
Data Service           WebSocket            Config A           Config B          Tradier
     │                    │                    │                   │                 │
     │ detectSignal()     │                    │                   │                 │
     │──┐                 │                    │                   │                 │
     │  │ broadcast()      │                    │                   │                 │
     │  │─────────────────>│                    │                   │                 │
     │  │                 │──┐                 │                   │                 │
     │  │                 │  │ Route to all subs│                   │                 │
     │  │                 │<─┘                 │                   │                 │
     │<─┘                 │                    │                   │                 │
     │                    │───────────────────>│                   │                 │
     │                    │───────────────────────────────────────>│                 │
     │                    │                    │                   │                 │
     │                    │                    │ "Matches! Enter!" │                 │
     │                    │                    │──┐                │                 │
     │                    │                    │  │ openPosition()│                 │
     │                    │                    │  │──────────────────────────────────>│
     │                    │                    │<─┘               │                 │
     │                    │                    │                   │                 │
     │                    │                    │                   │ "Matches! Enter!"│
     │                    │                   │                   │──┐              │
     │                    │                   │                   │  │ openPosition()│
     │                    │                   │                   │  │──────────────>│
     │                    │                   │                   │<─┘              │
     │                    │                   │                   │                 │
     │                    │                   │                   │    Result: 14x SPXW...
     │                    │                   │                   │    (double exposure!)
```

**The Problem**: No coordination between configs. Both enter the same position independently.

---

## Summary: Time Windows of Vulnerability

```
Signal → Entry:        ████████ 6-10 seconds (position open, not tracked)
OTOCO Verify:         ███████ forever (fire-and-forget, never checked)
Exit Polling:          ███████ 10 seconds (price data vs broker state)
Reconcile Race:        ███████ 60 seconds (can adopt during entry)
WS Disconnect:         ███████ indefinitely (signals lost)
Price Fetch Failure:   ███████ per poll (exit check skipped)
Double Entry:          ███████ instantly (no coordination)
```

---

## Recommended Architecture Changes

### 1. Three-Phase Entry (Gap #1)
```
Phase 1: Pre-register (add to Map with status='pending')
Phase 2: Execute (call Tradier)
Phase 3: Confirm (update status='open' or delete on failure)
```

### 2. Synchronous OTOCO Verify (Gap #2)
```
Don't return from openPosition() until verifyOtocoProtection() completes
Block for 3 seconds max (timeout → treat as failure)
```

### 3. Broker-First Exit Check (Gap #3)
```
Before checking TP/SL locally:
1. Fetch broker positions
2. If position missing → already closed (TP/SL fill)
3. Only check local exits if still open at broker
```

### 4. Entry Locking (Gap #4)
```
Global lock per symbol during entry:
- Set lock before calling Tradier
- Reconciliation skips locked symbols
- Release lock after 5 seconds
```

### 5. Signal Replay Buffer (Gap #5)
```
Data service keeps 60-second buffer of signals
On WS reconnect, handler requests missed signals
```

### 6. Fallback Exit Logic (Gap #6)
```
Check time_exit BEFORE fetching price
If time cutoff reached → exit regardless of price
```

### 7. Global Position Registry (Gap #7)
```
Track which config owns which position
First-come-first-served for same symbol
```

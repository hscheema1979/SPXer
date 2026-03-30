# Bracket Orders + Position Reconciliation Brief

**Date:** 2026-03-30
**Priority:** HIGH — live trading with no server-side safety net
**Status:** Not started

---

## Problem

Currently, TP/SL are enforced entirely in software — the agent polls prices each cycle and sells at market when thresholds are hit. If the agent crashes, restarts, or loses connectivity, open positions have **no stop loss and no take profit**. They sit unmanaged until manually closed.

This already happened today: the XSP agent was restarted, lost track of its open position, and the user had to manually close it.

---

## Solution: Two Changes

### 1. OTOCO Bracket Orders (server-side TP/SL)

Replace the current single `buy_to_open` market order with a Tradier OTOCO (One-Triggers-OCO) order:

- **Leg 0 (trigger):** `buy_to_open` market/limit — the entry
- **Leg 1 (TP):** `sell_to_close` limit at take-profit price — OCO with leg 2
- **Leg 2 (SL):** `sell_to_close` stop at stop-loss price — OCO with leg 1

When the entry fills, Tradier activates the OCO pair. When either the TP or SL fills, Tradier automatically cancels the other. This works even if the agent is completely offline.

**Tradier OTOCO format** (confirmed working):
```
class=otoco
duration=day
type[0]=market
option_symbol[0]=XSP260330C00636000
side[0]=buy_to_open
quantity[0]=1
type[1]=limit
option_symbol[1]=XSP260330C00636000
side[1]=sell_to_close
quantity[1]=1
price[1]=1.08          # TP price
type[2]=stop
option_symbol[2]=XSP260330C00636000
side[2]=sell_to_close
quantity[2]=1
stop[2]=0.23           # SL price
```

**IMPORTANT — scannerReverse interaction:** The current strategy exits via HMA reversal (signal_reversal), not TP/SL. When the agent detects a reversal and wants to flip:
1. Cancel the outstanding OCO legs (TP + SL) via Tradier API
2. Sell to close at market
3. Immediately open the opposite direction with a new OTOCO bracket

The bracket is a **safety net**, not the primary exit. The agent still monitors and can exit early (on reversal or any other reason). But if the agent dies, the bracket catches it.

### 2. Position Reconciliation on Startup

When the agent starts, before entering the trading loop:
1. Query `GET /v1/accounts/{accountId}/positions` for open positions
2. Query `GET /v1/accounts/{accountId}/orders` for pending orders (to find associated OCO legs)
3. For each open position found:
   - Reconstruct an `OpenPosition` object from Tradier data (symbol, quantity, cost_basis as entryPrice, date_acquired)
   - Compute TP/SL from the config (entryPrice × takeProfitMultiplier, entryPrice × (1 - stopLossPercent/100))
   - Check if OCO legs already exist (from a previous bracket). If not, submit new OCO legs.
   - Add to the PositionManager so monitoring resumes
4. Log what was reconciled so the user can see it

**Tradier positions response:**
```json
{
  "positions": {
    "position": {
      "cost_basis": 77.00,           // total cost = price × qty × 100
      "date_acquired": "2026-03-30T18:19:04.670Z",
      "id": 17647422,
      "quantity": 1.00000000,
      "symbol": "XSP260330C00636000"
    }
  }
}
```

Note: `cost_basis` is total (price × qty × 100), so `entryPrice = cost_basis / (quantity * 100)`.

---

## Where the Code Goes

### `src/agent/trade-executor.ts` — bracket order support

Modify `openPosition()`:
- Accept TP/SL prices (already in `AgentDecision`)
- When live (not paper), submit OTOCO instead of single order
- Return the bracket order ID (parent) + leg IDs so the position manager can cancel OCO legs on early exit
- Add `cancelOcoLegs(orderId)` function for when the agent exits early (scannerReverse, etc.)

Add new function:
```typescript
export async function cancelOcoLegs(
  bracketOrderId: number,
  execCfg?: Config['execution'],
): Promise<void>
```

### `src/agent/position-manager.ts` — reconciliation + OCO cancellation

Add method:
```typescript
async reconcileFromBroker(execCfg?: Config['execution']): Promise<number>
```
- Called once on startup, before the trading loop
- Returns count of reconciled positions
- Stores bracket/OCO order IDs on OpenPosition so they can be cancelled on early exit

Modify `monitor()`:
- When closing a position early (signal_reversal, etc.), call `cancelOcoLegs()` first to remove the server-side bracket before submitting the market sell

### `src/agent/types.ts` — extend OpenPosition

Add to `OpenPosition`:
```typescript
bracketOrderId?: number;    // OTOCO parent order ID
tpLegId?: number;           // TP limit leg order ID
slLegId?: number;           // SL stop leg order ID
```

### Config — no changes needed

TP/SL are already in `Config.position.takeProfitMultiplier` and `Config.position.stopLossPercent`. The bracket order just uses the same values that the software monitor already computes.

---

## Edge Cases

1. **Paper mode:** No bracket orders — keep current behavior (simulated fills). Reconciliation is a no-op in paper mode.
2. **OTOCO rejected:** Fall back to single market order + software-only monitoring. Log a warning.
3. **Partial fills:** OTOCO legs should use the same quantity as the filled entry. If entry partially fills, the OCO legs may need adjustment — but for 0DTE options this is rare.
4. **Agent exits early (scannerReverse):** Must cancel OCO legs before selling. If cancel fails, log error but still sell — worst case we get double-sold (Tradier will reject the second sell for insufficient position).
5. **Reconciliation finds position with no OCO:** Submit a new OCO pair (stop + limit) for the existing position as standalone orders.
6. **Multiple positions:** Handle as array — reconcile all, each with its own bracket.
7. **Position from different day:** 0DTE expires same day, so next-day reconciliation should find nothing. 1DTE (XSP) could carry overnight — reconciliation handles this naturally.

---

## Testing

1. **Unit test:** `openPosition()` builds correct OTOCO params
2. **Unit test:** `reconcileFromBroker()` correctly reconstructs OpenPosition from Tradier response
3. **Unit test:** `cancelOcoLegs()` calls correct Tradier endpoint
4. **Integration:** Paper mode still works identically (no bracket orders submitted)
5. **Manual:** Place a real OTOCO on XSP cash account, verify legs appear, cancel one leg and verify OCO behavior

---

## Estimated Effort

- trade-executor.ts OTOCO: ~1 hour
- position-manager.ts reconciliation + cancel: ~1 hour  
- types.ts + tests: ~30 min
- agent.ts + agent-xsp.ts startup integration: ~30 min
- Total: ~3 hours

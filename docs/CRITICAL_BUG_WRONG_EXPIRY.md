# CRITICAL BUG FOUND: Trading Wrong Expiry Date

**Issue**: On April 22, the system opened a position for April 23 contracts (1DTE, not 0DTE)

## Root Cause

### Data Service (src/pipeline/spx/scheduler.ts:35-44)
```typescript
export function getActiveExpirations(today: string, available: string[]): string[] {
  const todayDate = new Date(today);
  const dayOfWeek = todayDate.getDay(); // 5=Friday
  const maxDTE = dayOfWeek === 5 ? 3 : 2;

  return available.filter(exp => {
    const diff = (new Date(exp).getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= maxDTE;
  });
}
```

**On April 22 (Tuesday)**:
- Tracks expirations: April 22, 23, 24 (0-2 DTE)
- Detects HMA crosses on ALL these contracts
- Emits signals for ALL

### Event Handler (event_handler_mvp.ts:388)
```typescript
const expiryMatch = c.symbol.includes(signal.expiry);
```

**Just checks if the symbol contains the expiry** - doesn't validate if expiry is TODAY

### Result
```
April 22, 19:10:40 ET:
  Data service emits signal for SPXW260423C07105000 (April 23 contract)
  Handler receives signal
  Line 388: expiryMatch = "SPXW260423C07105000".includes("2026-04-23") = TRUE
  Handler OPENS POSITION for April 23 contract
  This is 1DTE, not 0DTE!
```

## Fix Required

### Option 1: Filter in Data Service (Preferable)
**Don't emit signals for non-today expiries**

```typescript
// In src/index.ts, detectContractSignals():

function detectContractSignals(bar: Bar): void {
  if (!activeHmaSignalEnabled) return;
  if (!lastSpxPrice) return;

  const symbol = bar.symbol;
  const prevBars = getBars(symbol, '1m', 2);
  if (prevBars.length < 2) return;

  // PARSE EXPIRY
  const parsed = parseSymbol(symbol);  // "2026-04-23"
  if (!parsed) return;
  const { strike, expiry, isCall } = parsed;

  // NEW: Only emit signals for TODAY's contracts (0DTE)
  const today = todayET();
  if (expiry !== today) {
    return;  // Skip contracts for future expiries
  }

  // ... rest of signal detection
}
```

### Option 2: Filter in Event Handler (Quick Fix)
**Reject signals for non-today expiries**

```typescript
// In event_handler_mvp.ts, handleContractSignal():

async function handleContractSignal(signal: any): Promise<void> {
  const now = Date.now() / 1000;

  // NEW: Validate expiry is TODAY
  const todayET = todayET();
  const todayDate = `20${signal.expiry.slice(2)}`;  // "2026-04-23"
  if (signal.expiry !== todayDate) {
    console.log(`[handler] Skipping signal for ${signal.symbol} - expiry ${signal.expiry} is not today (${todayDate})`);
    return;
  }

  // ... rest of signal handling
}
```

## Why This Happened

1. **Data service tracks multi-day contracts** for continuity
2. **Detects signals on ALL tracked contracts** (including future days)
3. **Event handler assumes all signals are valid for trading**
4. **No expiry date validation** anywhere in the flow

## Impact

- **WRONG EXPIRY**: Trading 1DTE instead of 0DTE
- **WRONG STRIKE**: If April 23 contracts have different strikes available, might pick wrong strike
- **WRONG RISK**: 1DTE options have different theta profiles than 0DTE
- **WRONG TP/SL**: Calculated based on wrong expiry risk profile

## Testing

After fix, verify:
```bash
# Today is April 23
# Data service should emit signals for SPXW260423* (today)
# Data service should NOT emit signals for SPXW260424* (tomorrow)

grep "contract_signal" logs/handler-routing.jsonl | jq -r '.signal.expiry' | sort -u
# Should only show today's date
```

## Files to Change

1. **src/index.ts** - `detectContractSignals()` - Add expiry check (PREFERRED)
2. **OR event_handler_mvp.ts** - `handleContractSignal()` - Add expiry check (QUICK FIX)

**Recommendation**: Fix in data service so event handler only receives valid 0DTE signals.

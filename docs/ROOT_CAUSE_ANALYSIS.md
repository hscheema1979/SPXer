# Root Cause Analysis: 4/22 Trading Errors

**Date:** 2026-04-23
**Issues:**
1. System placed orders for 4/23 contracts (1DTE instead of 0DTE)
2. System placed orders $20 ITM instead of $5 ITM

---

## Bug #1: Wrong Expiry (1DTE instead of 0DTE)

### What Happened
On 4/22, system opened position `SPXW260423C07105000`:
- Expiry: 2026-04-23 (Wednesday)
- Trade date: 2026-04-22 (Tuesday)
- This is a 1DTE contract, not 0DTE

### Root Cause
**File:** `src/index.ts`, function `detectContractSignals()` (line 586)

The data service tracks 0-2 DTE contracts for bar-building continuity (see `src/pipeline/spx/scheduler.ts`):
- Tuesday: tracks today + tomorrow (0-1 DTE)
- Friday: tracks today + tomorrow + day after (0-2 DTE)

When HMA crosses are detected on ANY tracked contract, the data service emits a `contract_signal` event. **There was no validation that the signal is for today's contract only.**

### Signal Flow
1. Data service streams all tracked contracts (0-2 DTE)
2. Builds bars for all tracked contracts
3. Detects HMA crosses on all tracked contracts
4. **BUG:** Emits signals for ALL tracked contracts, including 1DTE
5. Event handler receives 1DTE signal
6. Event handler doesn't validate expiry (assumes data service filtered)
7. Trade executes on 1DTE contract

### Fix Applied
**File:** `src/index.ts`, line 599

Added validation after parsing expiry:
```typescript
// CRITICAL: Only emit signals for TODAY's contracts (0DTE)
const today = todayET();
if (expiry !== today) {
  return;  // Skip contracts for future expirations
}
```

**Status:** ✅ Fixed in code, needs deployment

---

## Bug #2: Wrong Strike ($20 ITM instead of $5 ITM)

### What Happened
On 4/22, system opened a position with strike 7105 when SPX was ~7085:
- For a PUT: 7105 is $20 ITM (correct)
- Config specified: `targetOtmDistance: -5` (ITM5)
- Expected: strike ~7080 (5 ITM for a PUT)

### Root Cause
**File:** `src/core/strike-selector.ts`, line 64

The config had `targetOtmDistance: -5` but **NOT** `strikeSelector.strikeMode`.

```typescript
const strikeMode = config.strikeSelector.strikeMode ?? 'otm';
```

When `strikeMode` is null/undefined, it defaults to **'otm'** instead of 'itm'.

### What Went Wrong

#### Step 1: Wrong Mode
- Config intent: ITM5 (trade 5 points in-the-money)
- Config state: `targetOtmDistance: -5`, `strikeMode: null`
- Actual behavior: defaults to `'otm'` mode

#### Step 2: Wrong Filtering (OTM Mode Legacy ITM Support)
**File:** `src/core/strike-selector.ts`, line 117-128

OTM mode has "legacy ITM support" when `targetOtmDistance < 0`:
```typescript
case 'otm': {
  const allowItm = (targetOtmDistance ?? 0) < 0;
  if (allowItm) {
    const maxItmDepth = Math.abs(targetOtmDistance!) + 10;
    // For PUTs: allows strike >= spxPrice + maxItmDepth
  }
}
```

With `targetOtmDistance: -5`:
- `maxItmDepth = |-5| + 10 = 15`
- For PUTs with SPX=7085: allows `strike >= 7085 + 15 = 7100`
- **Result:** Allows all PUTs from 7100 to 7165 (searchRange limit)
- **Problem:** Allows 20 ITM (7105 PUT), doesn't target 5 ITM

#### Step 3: Target Narrowing Failed
**File:** `src/core/strike-selector.ts`, line 151-164

```typescript
const targetStrike = side === 'put'
  ? spxRounded - targetOtmDistance  // 7085 - (-5) = 7090
  : spxRounded + targetOtmDistance;

// Narrow to strikes within 5 of target
const narrowed = pool.filter(c => Math.abs(c.strike - targetStrike) <= interval);
```

Target strike: 7090
Tolerance: ±5 points
Desired range: [7085, 7090, 7095]

**If no contracts exist at these exact strikes**, the code falls through to the full filtered pool (line 163): all PUTs from 7100+.

#### Step 4: Wrong Scoring (OTM Mode)
**File:** `src/core/strike-selector.ts`, line 194-196

```typescript
case 'otm':
  moneynessScore = 1 - Math.min(1, otmDistance / 40);
```

For a 20 ITM PUT:
- `otmDistance = 20`
- `moneynessScore = 1 - 20/40 = 0.5`

For a 5 ITM PUT (if it existed):
- `otmDistance = 5`
- `moneynessScore = 1 - 5/40 = 0.875`

But 5 ITM PUT (7080) is OUTSIDE the filtered pool (filtered pool starts at 7100).

So the selector picked from the available pool (7100+) using OTM scoring, which:
- Penalizes ITM heavily
- Prefers OTM or near-ATM
- Still selected 20 ITM because it was the best of the bad options (price/volume factors)

### Database State Investigation

Querying the config on 4/22 would have shown:
```json
{
  "strikeSelector": {
    "strikeSearchRange": 80,
    "contractPriceMin": 0.2,
    "contractPriceMax": 99
    // ⚠️ MISSING: strikeMode field
  },
  "signals": {
    "targetOtmDistance": -5  // ITM5 intent
  }
}
```

**Problem:** The `strikeSelector` object never had a `strikeMode` field set.

### Why Validation Didn't Catch It
**File:** `event_handler_mvp.ts`, line 336

```typescript
if (strikeResult.candidate.strike !== signal.strike) {
  console.log(`Strike mismatch: signal=${signal.strike} vs selected=${strikeResult.candidate.strike}`);
  continue;  // SKIP trade
}
```

The validation EXISTS and should have skipped the trade if strikes didn't match.

**Possible scenarios:**
1. Signal came from 7105 strike (HMA cross happened there)
2. `selectStrike()` also returned 7105 (best of available pool)
3. Validation passed: 7105 === 7105
4. Trade executed

**The bug wasn't the validation** - the validation worked correctly.
**The bug was that `selectStrike()` returned the wrong strike** because it was running in OTM mode instead of ITM mode.

### Fix Required
**Database migration needed** to add `strikeMode` field to all configs:

```sql
-- For ITM configs (targetOtmDistance < 0)
UPDATE replay_configs
SET config_json = json_set(config_json, '$.strikeSelector.strikeMode', 'itm')
WHERE json_extract(config_json, '$.signals.targetOtmDistance') < 0;

-- For ATM configs (targetOtmDistance = 0)
UPDATE replay_configs
SET config_json = json_set(config_json, '$.strikeSelector.strikeMode', 'atm')
WHERE json_extract(config_json, '$.signals.targetOtmDistance') = 0;

-- For OTM configs (targetOtmDistance > 0)
UPDATE replay_configs
SET config_json = json_set(config_json, '$.strikeSelector.strikeMode', 'otm')
WHERE json_extract(config_json, '$.signals.targetOtmDistance') > 0;
```

**Status:** ⚠️ Migration script created but NOT yet run
**Impact:** 533 configs need `strikeMode` field added

---

## Summary

| Issue | Root Cause | Fix Status |
|-------|-----------|------------|
| Wrong expiry (1DTE) | Data service emits signals for 0-2 DTE, no today-only filter | ✅ Code fixed, needs deploy |
| Wrong strike ($20 ITM) | Config missing `strikeMode` field, defaults to 'otm' | ⚠️ Migration created, not executed |

**Both bugs stem from missing validation and configuration defaults.**

The data service assumed the event handler would filter expiries (it didn't).
The strike selector assumed configs would have explicit `strikeMode` (they didn't).

---

## Questions Remaining

1. **Why did configs not have `strikeMode` set?**
   - Was it never added to the config creation code?
   - Was it removed in a migration?
   - Check `src/config/defaults.ts` and config initialization code

2. **Did the validation actually work on 4/22?**
   - Check logs to see if "Strike mismatch" was logged
   - Verify the signal strike vs selected strike
   - Confirm the trade executed or was rejected

3. **Why did target narrowing fail?**
   - Were there really no contracts at 7085, 7090, 7095?
   - Or was the candidate pool empty?
   - Need to check active contracts on 4/22

4. **Was it actually 20 ITM or 20 OTM?**
   - User said "$20 ITM"
   - For a PUT at 7105 with SPX=7085: 20 ITM ✓
   - For a CALL at 7105 with SPX=7085: 20 OTM
   - Need to verify CALL vs PUT

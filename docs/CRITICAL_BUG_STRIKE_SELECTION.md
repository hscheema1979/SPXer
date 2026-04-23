# Critical Bug: Wrong Strike Selection ($20 ITM instead of $5 ITM)

**Date:** 2026-04-23
**Status:** Root cause identified
**Impact:** System placed orders $20 ITM instead of configured $5 ITM

---

## Problem Statement

On 2026-04-22, the system placed an order for `SPXW260423C07105000`:
- **Expiry:** 2026-04-23 (1DTE, should be 0DTE) ← Bug #1 (fixed)
- **Strike:** 7105
- **SPX price:** ~7085
- **Actual moneyness:** $20 ITM
- **Configured moneyness:** $5 ITM (`targetOtmDistance: -5`)

**Question:** Why did the system pick $20 ITM instead of $5 ITM?

---

## Root Cause Analysis

### Step 1: Config State

Querying the database for the ITM5 config:
```json
{
  "strikeSelector": {
    "strikeSearchRange": 80,
    "contractPriceMin": 0.2,
    "contractPriceMax": 99
    // ⚠️ MISSING: strikeMode field!
  },
  "signals": {
    "targetOtmDistance": -5  // ITM5
  }
}
```

**Problem:** `strikeSelector.strikeMode` is `undefined` in the database.

### Step 2: Strike Selector Default Behavior

**File:** `src/core/strike-selector.ts`, line 64
```typescript
const strikeMode = config.strikeSelector.strikeMode ?? 'otm';
```

When `strikeMode` is `undefined`, it defaults to **`'otm'`**.

**Problem:** An ITM5 config should have `strikeMode: 'itm'`, not default to `'otm'`.

### Step 3: OTM Mode Filtering + Scoring

#### Filtering (line 116-128)
```typescript
case 'otm': {
  // Legacy: allow ITM if targetOtmDistance < 0
  const allowItm = (targetOtmDistance ?? 0) < 0;
  if (allowItm) {
    const maxItmDepth = Math.abs(targetOtmDistance!) + 10;
    if (side === 'call' && c.strike < spxPrice - maxItmDepth) return false;
    if (side === 'put' && c.strike > spxPrice + maxItmDepth) return false;
  } else {
    if (side === 'call' && c.strike <= spxPrice) return false;
    if (side === 'put' && c.strike >= spxPrice) return false;
  }
  return true;
}
```

With `targetOtmDistance: -5`:
- `allowItm = true` (because -5 < 0)
- `maxItmDepth = |-5| + 10 = 15`
- **Allows up to 15 ITM** (for calls: `strike >= spxPrice - 15`)

#### Target Narrowing (line 151-164)
```typescript
const targetStrike = side === 'call'
  ? spxRounded + targetOtmDistance  // 7080 if SPX=7085
  : spxRounded - targetOtmDistance;

// Keep only strikes within one interval of the target
const narrowed = pool.filter(c => Math.abs(c.strike - targetStrike) <= interval);
if (narrowed.length > 0) {
  pool = narrowed;
}
// If nothing within tolerance, fall through to full pool
```

**Problem:** If no strike exists within 5 of the target (7080), it falls through to the full pool (all strikes up to 15 ITM).

#### Scoring (line 194-196)
```typescript
case 'otm':
  // Prefer moderate OTM (1 = ATM, decays over 40pts)
  moneynessScore = 1 - Math.min(1, otmDistance / 40);
```

**Problem:** In OTM mode, the scoring prefers OTM strikes!
- ATM (0 distance): score = 1.0
- 5 ITM: score = 0.875
- 10 ITM: score = 0.75
- 20 ITM: score = 0.5

So a 20 ITM strike gets a LOWER moneyness score than a 5 ITM strike, but the scoring also considers:
- **Price score (50% weight):** prefers contracts near midpoint of price band ($0.20 - $99)
- **Volume score (10% weight):** bonus for volume

If the 5 ITM strike has a very high price (e.g., $50) and the 20 ITM strike has a moderate price (e.g., $15), the price score can overcome the moneyness penalty.

### Step 4: Event Handler Validation

**File:** `event_handler_mvp.ts`, line 413
```typescript
if (strikeResult.candidate.strike !== signal.strike) {
  console.log(`[handler] Strike mismatch: signal=${signal.strike} vs selected=${strikeResult.candidate.strike}`);
  continue;  // SKIP
}
```

**Critical Question:** Did this validation exist on 4/22?

If it did, the trade should have been skipped (unless `signal.strike === 7105`).

If it didn't, the handler executed whatever `selectStrike()` returned.

---

## The Actual Bug

**Primary bug:** `strikeSelector.strikeMode` is missing from database configs.

**Secondary issue:** When `strikeMode` defaults to `'otm'`, the strike selector prefers OTM strikes, even if `targetOtmDistance: -5` (ITM5).

**Result:** System placed orders for strikes that don't match the config's intent (ITM5).

---

## Why the Validation Didn't Catch It

Scenario 1: **Validation existed, signal strike was wrong**
- Data service emitted signal for strike 7105 (where HMA crossed)
- Event handler called `selectStrike()` → returned 7100 (5 ITM)
- Validation check: `7100 !== 7105` → **Should have been skipped!**

But the order was placed, so either:
A) Validation didn't exist on 4/22 (code change?)
B) `selectStrike()` returned 7105 (both were wrong)
C) Signal strike was 7100, not 7105 (audit log error?)

Scenario 2: **Validation didn't exist**
- Old code path didn't validate strike match
- Executed whatever `selectStrike()` returned
- Result: $20 ITM order

---

## Fix Required

### Fix #1: Database Migration
**Add `strikeMode` field to all existing configs:**

```sql
-- For ITM5 configs
UPDATE replay_configs
SET config_json = json_set(
  config_json,
  '$.strikeSelector.strikeMode',
  'itm'
)
WHERE config_json LIKE '%itm5%';

-- For OTM5 configs
UPDATE replay_configs
SET config_json = json_set(
  config_json,
  '$.strikeSelector.strikeMode',
  'otm'
)
WHERE config_json LIKE '%otm5%';

-- For ATM configs
UPDATE replay_configs
SET config_json = json_set(
  config_json,
  '$.strikeSelector.strikeMode',
  'atm'
)
WHERE config_json LIKE '%atm%';
```

### Fix #2: Update Config Defaults
**File:** `src/config/defaults.ts`

Add `strikeMode: 'otm'` to `DEFAULT_STRIKE_SELECTOR`:
```typescript
export const DEFAULT_STRIKE_SELECTOR: StrikeSelector = {
  strikeMode: 'otm',  // ← Add this
  strikeSearchRange: 100,
  contractPriceMin: 0.2,
  contractPriceMax: 15.0,
  targetOtmDistance: null,
  targetContractPrice: null,
};
```

### Fix #3: ITM Mode Scoring Fix
**File:** `src/core/strike-selector.ts`, line 202-214

The ITM mode scoring prefers 10 ITM over 5 ITM:
```typescript
case 'itm': {
  // Prefer moderate ITM depth (sweet spot ~5-15pts ITM)
  const isItm = (side === 'call' && c.strike <= spxPrice) || (side === 'put' && c.strike >= spxPrice);
  if (!isItm) {
    moneynessScore = 0.2;
  } else {
    // Peak at 10pts ITM, decay from there
    const itmDepth = otmDistance;
    moneynessScore = itmDepth <= 10
      ? 0.5 + (itmDepth / 10) * 0.5   // ramp up to 1.0 at 10pts
      : 1 - Math.min(1, (itmDepth - 10) / 30);
  }
  break;
}
```

**Problem:** This prefers 10 ITM over 5 ITM (score: 0.75 vs 0.5).

**Should prefer:** Target distance (e.g., 5 ITM) over arbitrary 10 ITM.

---

## Verification Steps

1. **Check current configs:**
   ```bash
   sqlite3 data/spxer.db "SELECT id, json_extract(config_json, '$.strikeSelector.strikeMode') as mode FROM replay_configs;"
   ```

2. **Run migration:** (see Fix #1 above)

3. **Test strike selection:**
   - Create ITM5, OTM5, ATM configs
   - Call `selectStrike()` with same candidate pool
   - Verify each picks the expected strike

4. **Deploy fixes:**
   - Migration script
   - Config defaults
   - ITM mode scoring (optional)

---

## Related Bugs

- **Bug #1:** Wrong expiry (1DTE instead of 0DTE) — ✅ Fixed in `src/index.ts`
- **Bug #2:** Wrong strike ($20 ITM instead of $5 ITM) — ⚠️ This bug

Both bugs stem from **missing configuration validation** and **incorrect defaults**.

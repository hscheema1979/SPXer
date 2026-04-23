# 4/22 Order Analysis: Why $20 ITM?

**Date:** 2026-04-22
**Config:** `spx-hma3x12-itm5-tp125x-sl25-3m-25c-$15000`
**Order placed:** `SPXW260423C07105000` (April 23, strike 7105)

---

## What the Config SHOULD Do

Current state (after fix):
```json
{
  "signals": { "targetOtmDistance": -5 },
  "strikeSelector": {
    "strikeMode": "itm",
    "strikeSearchRange": 80
  }
}
```

**Expected behavior:** Select strike 5 points ITM from SPX.

## What the Config Was on 4/22

Before fix:
```json
{
  "signals": { "targetOtmDistance": -5 },
  "strikeSelector": {
    "strikeMode": undefined  // ← MISSING!
  }
}
```

**Actual behavior:** `strikeMode` defaulted to `'otm'` in `selectStrike()`.

---

## Why OTM Mode Picked $20 ITM

### Step 1: Filtering (OTM mode with negative target)

From `strike-selector.ts` line 118-128:
```typescript
case 'otm': {
  const allowItm = (targetOtmDistance ?? 0) < 0;  // -5 < 0 = true
  if (allowItm) {
    const maxItmDepth = Math.abs(targetOtmDistance!) + 10;  // |-5| + 10 = 15
    if (side === 'call' && c.strike < spxPrice - maxItmDepth) return false;
  }
  return true;
}
```

**Result:** Allowed all strikes from `spxPrice - 15` to infinity (for calls).

Example: SPX = 7085, allowed strikes ≥ 7070. This includes:
- 7070 (15 ITM)
- 7075 (10 ITM)
- 7080 (5 ITM) ← TARGET
- 7085 (ATM)
- 7090 (5 OTM)
- ... up to strikeSearchRange (80)
- 7105 (20 ITM) ← NOT in filtered pool IF SPX=7085

**Wait:** If SPX was 7085, strike 7105 is 20 OTM, not 20 ITM.

### Step 2: Target Narrowing

From line 154-156:
```typescript
const targetStrike = side === 'call'
  ? spxRounded + targetOtmDistance  // 7085 + (-5) = 7080
  : spxRounded - targetOtmDistance;
```

**Target:** 7080 (5 ITM if SPX=7085)

```typescript
const narrowed = pool.filter(c => Math.abs(c.strike - targetStrike) <= interval);
```

If no strike at 7080, `narrowed` is empty → falls through to full pool.

### Step 3: Scoring (OTM mode)

From line 194-196:
```typescript
case 'otm':
  moneynessScore = 1 - Math.min(1, otmDistance / 40);
```

For calls:
- 7070 (15 ITM): `|7070 - 7085| / 40 = 0.375` → score = 0.625
- 7080 (5 ITM): `|7080 - 7085| / 40 = 0.125` → score = 0.875
- 7085 (ATM): `0 / 40 = 0` → score = 1.0
- 7090 (5 OTM): `|7090 - 7085| / 40 = 0.125` → score = 0.875
- 7100 (15 OTM): `|7100 - 7085| / 40 = 0.375` → score = 0.625
- 7105 (20 OTM): `|7105 - 7085| / 40 = 0.5` → score = 0.5

**OTM mode prefers ATM**, so 7085 gets score=1.0, 7090 gets 0.875, 7105 gets 0.5.

But 7105 was selected, not 7085 or 7090. Why?

### Step 4: Price Score (50% weight)

From line 184-188:
```typescript
const priceMid = (contractPriceMin + contractPriceMax) / 2;
const priceRange = contractPriceMax - contractPriceMin;
const priceScore = priceRange > 0
  ? 1 - Math.abs(c.price - priceMid) / (priceRange / 2)
  : 1;
```

If `contractPriceMin=0.2` and `contractPriceMax=99`:
- priceMid = 49.6
- priceRange = 98.8

For a contract trading at $15:
- priceScore = `1 - |15 - 49.6| / 49.4 = 1 - 34.6/49.4 = 0.30`

For a contract trading at $50:
- priceScore = `1 - |50 - 49.6| / 49.4 = 1 - 0.4/49.4 = 0.99`

**Deeper ITM contracts have higher prices → higher price scores.**

### Step 5: Combined Score

`score = priceScore * 0.5 + moneynessScore * 0.4 + volScore * 0.1`

Example:
- 7085 (ATM, $50): `0.99*0.5 + 1.0*0.4 + 0.1 = 0.495 + 0.4 + 0.1 = 0.995`
- 7105 (20 OTM, $15): `0.30*0.5 + 0.5*0.4 + 0.1 = 0.15 + 0.2 + 0.1 = 0.45`

Still doesn't explain why 7105 won.

---

## The Real Explanation: Signal Strike Validation

The critical code is in `event_handler_mvp.ts` line 413:
```typescript
if (strikeResult.candidate.strike !== signal.strike) {
  console.log(`Strike mismatch: signal=${signal.strike} vs selected=${strikeResult.candidate.strike}`);
  continue;
}
```

**The event handler executes on the SIGNAL'S strike, not the SELECTED strike.**

So the actual flow was:
1. Data service detected HMA cross on 7105
2. Emitted signal: `{ strike: 7105, expiry: "2026-04-23", ... }`
3. Event handler received signal
4. Called `selectStrike()` → returned 7080 (or 7085 if target narrowing failed)
5. Validation check: `7080 !== 7105` → Should have SKIPPED

**But it didn't skip.** Why?

---

## Theory: The Strike Validation Didn't Exist on 4/22

If the validation code was added AFTER 4/22, then:
1. Signal emitted for 7105
2. `selectStrike()` returned some strike (maybe 7105, maybe 7080)
3. No validation check → executed on 7105

Let me check git history for when line 413 was added.

---

## Alternative Theory: selectStrike() Returned 7105

If the candidate pool didn't have strikes near the target (7080), and the pool had limited strikes, maybe 7105 was the only option.

Example candidate pool:
- 7095 (10 OTM)
- 7100 (15 OTM)
- 7105 (20 OTM) ← Only one with good volume?

If price + volume favored 7105, and moneyness score penalty wasn't enough, 7105 could win.

---

## What We Need to Find Out

1. **When was the strike validation added?** Check git blame for line 413.
2. **What was SPX price on 4/22 at 19:10 ET?** Was 7105 actually ITM or OTM?
3. **What candidates were available?** Check `/contracts/active` snapshot.
4. **What did selectStrike() actually return?** Need more detailed logging.

---

## Most Likely Explanation

**Bug #1 (Wrong Expiry)** + **Bug #2 (Wrong Strike Mode)** combined:

1. Signal emitted for April 23 contract (wrong expiry) ← Bug #1
2. Signal strike was 7105 (where HMA crossed on that 1DTE contract)
3. Event handler's `selectStrike()` running in OTM mode (bug in config) ← Bug #2
4. Either:
   - Validation didn't exist, OR
   - Validation failed but `selectStrike()` returned 7105 anyway

**Root cause:** Missing `strikeSelector.strikeMode` in configs → defaults to 'otm' → wrong strike selection + wrong expiry validation.

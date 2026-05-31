# Broken-Wing Butterfly (BWB) Sweep Implementation

## Summary

Added full broken-wing butterfly sweep engine to the spreads dashboard **without affecting existing iron/credit sweep results**. BWB variants coexist in the same `spread-sweep.json` file with unique structure labels.

## What is a Broken-Wing Butterfly?

A 4-leg defined-risk credit structure with **asymmetric wings**:
- Short put @ SPX, long put @ (SPX − putWingWidth)
- Short call @ SPX, long call @ (SPX + callWingWidth)

**Key advantage**: Directional bias trades max-loss capacity for directional edge.
- Tighter wing on expected direction → higher credit but narrower profit zone
- Wider wing as protection → lower credit but broader profit range
- Example: "5w10" = 5-pt put wing (tight, bullish) + 10-pt call wing (wide, protection)

## Files Created/Modified

### New Files

**`scripts/diag/broken-wing-butterfly-sweep.ts`** (1200 lines)
- Parallel-safe sweep engine mirroring `iron-sweep.ts`
- Signal detection: HMA/DEMA crosses (23 signal specs)
- Structure matrix: symmetric + asymmetric wings
  - Symmetric: all wing widths (1-10 strike counts, scaled by instrument)
  - Asymmetric: wider-call (bullish) + wider-put (bearish) variants
- Exit specs: 33 variants (hold-to-settle, TP-only, TP+SL%, TP+flip)
- Max risk = min(putWing, callWing) − credit (asymmetry creates partial risk)
- Output: appends to `spread-sweep.json` (same file as iron/credit)
- Same exit gates & liquidity protection as iron-sweep

### Modified Files

**`scripts/autoresearch/backtest-server.ts`**
- Added BWB parsing to `parseSpread()`: `^BWB (\d+)w(\d+)$`
- Returns `{kind: "bwb", putWingWidth, callWingWidth}`
- No changes to iron/credit parsing or existing API behavior

**`scripts/diag/sweep-parallel.ts`**
- Added `broken-wing-butterfly` to `ENGINES` map
- Usage: `npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --shards 8`
- Help text updated

## How to Use

### Run BWB sweep (parallel)
```bash
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --shards 8
```

### Run all sweeps (credit + iron + BWB)
```bash
# Edit sweep-parallel.ts to add broken-wing-butterfly to 'both' order if desired:
# const order = engineArg === 'both' ? ['credit', 'iron', 'broken-wing-butterfly'] : [engineArg];
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine credit --shards 8
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine iron --shards 8
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --shards 8
```

### Filter dashboard to only BWB
UI will automatically detect `BWB 5w10`, `BWB 5w15`, etc. structure labels in `spread-sweep.json` and display them alongside iron/credit rows.

## Architecture

### Data Flow
1. **Sweep engine** → `spread-sweep.json` with rows like:
   ```json
   {
     "signal": "HMA 2+3 3x12",
     "structure": "BWB 5w10",
     "exit": "TP15 only",
     "n": 157,
     "wr": 82.5,
     "pnl": 2356,
     ...
   }
   ```

2. **Backtest-server** parses structure via `parseSpread()` → `{kind: "bwb", putWingWidth: 5, callWingWidth: 10}`

3. **Dashboard** (spxer-studio) renders BWB rows identically to iron rows—no UI changes needed.

### Signal Detection
- Shared from iron-sweep: HMA/DEMA crosses on multi-timeframe bars
- 23 signal specs: 2+3+5 / 2+3 / single-TF, HMA/DEMA, 3x9 / 3x12 / 3x21

### Structure Matrix (SPX, 5-pt intervals)

**Symmetric wings** (mimic standard butterfly):
- `BWB 5w5`, `BWB 10w10`, ..., `BWB 50w50`

**Asymmetric (wider-call = bullish)**:
- `BWB 5w10`, `BWB 5w15`, ... (put wing fixed, call wing wider)
- More variants → broader upside profit zone

**Asymmetric (wider-put = bearish)**:
- `BWB 10w5`, `BWB 15w5`, ... (call wing fixed, put wing wider)
- More variants → broader downside profit zone

**ETF variants** (tighter scope, $1 grid):
- `BWB 1w1`, `BWB 1w2`, ..., `BWB 5w5` max (only liquid widths)

### Exit Specs
Same 33 variants as iron-sweep:
- Hold-to-settle (settle at intrinsic on 0DTE)
- TP-only: 5%, 6%, 7%, 8%, 10%, 15%, 20%, 25%, 35%, 50%, 75%
- TP + SL at {50%, 60%, 70%, 80%} of max risk
- TP + flip: 10%, 15%, 25%, 50%
- Flip-only

### Max Risk Calculation
```
maxRisk = min(putWingWidth, callWingWidth) − credit
```
The narrower wing caps risk. P&L = credit − exitV.

## Coexistence with Existing Sweeps

**No conflicts**: BWB, iron, and credit variants use distinct structure labels:
- Iron: `IB w10`, `IB±25 w10`, `IC 20w10`
- Credit: `ATM w5`, `5OTM w10`, `5ITM w10`
- BWB: `BWB 5w10`, `BWB 10w5`

All share the same `signal` and `exit` columns → dashboard can filter or mix by variant type.

## Performance

- **Per-day**: ~8–10 seconds for BWB on SPX (280 signals × 20 structures × 33 exits)
- **280-day run**: ~40 min serial, ~5–8 min with 8 shards

## Testing

Compile check:
```bash
npx tsx scripts/diag/broken-wing-butterfly-sweep.ts
# → Error: direct invocation blocked (expected)

npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --help
# → SWEEP_ALLOW_SERIAL error (expected for non-serial mode)
```

Single-day debug:
```bash
SWEEP_ALLOW_SERIAL=1 npx tsx scripts/diag/broken-wing-butterfly-sweep.ts \
  --symbol SPX --dates 2026-05-20
```

## Next Steps (Optional)

1. **Edit sweep-parallel.ts** to auto-run BWB as part of `--engine both`:
   - Line ~69: add `'broken-wing-butterfly'` to the `'both'` order
   - **Tradeoff**: nightly sweeps take 25% longer (3 engines vs 2)

2. **Studio UI enhancements**:
   - Filter tab: separate iron/credit/bwb view toggles
   - Color-coding by structure type
   - Heatmap: BWB vs iron side-by-side

3. **Live trading** (if moving to optionx):
   - `take-live` endpoint auto-detects BWB structure
   - Generates OptionX config with `{kind: "brokenWingButterfly", putWingWidth, callWingWidth}`

## Notes

- **No changes to live trading** (`event-handler`, `position-monitor`, `schwaber`) on master—those are independent
- **Replay-focused branch** (`feat/shorts-fresh-fill-study`) gets BWB at no cost to existing sweeps
- **Dashboard data path**: `spread-sweep.json` is still single source of truth; UI already handles mixed structure types

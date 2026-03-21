<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests/pipeline — Pipeline Layer Tests

## Purpose

Test the entire data processing pipeline: bar building, indicator computation, contract tracking, scheduling, and aggregation.

## Key Test Files

| File | Description |
|------|-------------|
| `bar-builder.test.ts` | Bar creation from raw OHLCV, gap interpolation (2min, 60min, 120min gaps) |
| `indicator-engine.test.ts` | Incremental indicator computation vs batch (correctness + performance) |
| `aggregator.test.ts` | Build 5m/15m/1h/1d bars from 1m bars, OHLC correctness, volume sum |
| `contract-tracker.test.ts` | State transitions (UNSEEN → ACTIVE → STICKY), sticky band model, band drift |
| `scheduler.test.ts` | Market mode detection (RTH vs overnight), data source switching |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `indicators/` | Indicator tests (Tier 1 and Tier 2) — see `indicators/AGENTS.md` |

## Bar Builder Tests

**Test cases**:
- Create bar from raw OHLCV (synthetic flag false, gapType null)
- Gap 2 min → create 1 synthetic bar (linear interpolation)
- Gap 60 min → create 59 synthetic bars (linear interpolation)
- Gap 120 min → create 119 synthetic bars (flat stale price)
- Verify synthetic bars have correct flags

## Indicator Engine Tests

**Test cases**:
- Incremental HMA computation matches batch computation on full window
- Incremental EMA matches batch (verify alpha formula correct)
- RSI computation via gains/losses method
- Bollinger Bands mean and std dev correct
- ATR calculation from true ranges
- VWAP cumulative calculation

**Approach**: Compute same indicator two ways:
1. Incremental (state-based, production code)
2. Batch (from scratch on full window, naive implementation)
3. Compare results for all bars (should match exactly)

## Aggregator Tests

**Test cases**:
- 10 × 1m bars (OHLCV varies) → 1 × 10m bar
- Verify OHLC (open of first bar, high of max, low of min, close of last)
- Volume summed correctly
- No bars lost in aggregation

## Contract Tracker Tests

**Test cases**:
- Contract enters UNSEEN at creation
- Bar enters ACTIVE when price enters ±$100 band around SPX
- Contract confirms STICKY after N bars in band
- Band drifts as SPX moves (±$100 window tracks)
- Contract never drops from STICKY until EXPIRED

## Scheduler Tests

**Test cases**:
- 6 PM ET → market mode = OVERNIGHT (use ES)
- 9:30 AM ET → market mode = RTH (use SPX)
- 3:15 PM ET → market mode = RTH (still trading)
- 4:15 PM ET → market mode = AFTER_HOURS
- Holiday dates correctly identified (return CLOSED)
- Early close days (e.g., day before Thanksgiving) end at 1 PM ET

## For AI Agents

### Working In This Directory

1. **Incremental = Batch** — Key invariant: incremental computation must match batch. Test this explicitly.
2. **State isolation** — Each test uses fresh IndicatorState; no pollution between tests.
3. **Realistic data** — Use actual market data (SPX bars from a known date), not synthetic random data.
4. **Edge cases** — Test boundaries: first bar, not enough bars for period, volume = 0.

## Testing Patterns

### Incremental vs Batch Pattern

```typescript
it('HMA computation matches batch', () => {
  const bars = [...10 bars of real market data];

  // Incremental (production code)
  let state = seedState();
  const results_incremental = bars.map((bar, i) => {
    state = computeIndicators(state, bar);
    return state.indicators.hma_3m;
  });

  // Batch (naive from scratch)
  const results_batch = bars.map((bar, i) => {
    const window = bars.slice(Math.max(0, i - 2), i + 1);
    return computeHMABatch(window);
  });

  // Both should match
  expect(results_incremental).toEqual(results_batch);
});
```

## Dependencies

### Internal
- All pipeline modules under `src/pipeline/`

### External
- `vitest` — Test framework

<!-- MANUAL: Add pipeline test-specific notes below -->

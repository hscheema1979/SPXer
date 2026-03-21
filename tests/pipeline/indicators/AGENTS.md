<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests/pipeline/indicators — Indicator Computation Tests

## Purpose

Verify technical indicator implementations compute correctly via incremental state-based updates.

**Key invariant**: Incremental computation (production code) must match batch computation (naive from scratch) on all bars.

## Test Files

| File | Description |
|------|-------------|
| `tier1.test.ts` | Tests for HMA, EMA, RSI, Bollinger Bands, ATR, VWAP |
| `tier2.test.ts` | Tests for EMA 50/200, SMA, Stochastic, CCI, Momentum, MACD, ADX |

## Tier 1 Tests

### HMA (Hull Moving Average)
- Incremental HMA 3m matches batch on 100-bar window
- Incremental HMA 5m, 10m, 20m all match
- First few bars return null (not enough data)

### EMA (Exponential Moving Average)
- Incremental EMA 9 matches batch (alpha = 2/10)
- Incremental EMA 21 matches batch
- Alpha formula verified correct
- First bar should return close (or null if no prior)

### RSI (Relative Strength Index)
- Incremental RSI 14 matches batch
- RS calculation (avg gains / avg losses) verified
- Edge case: all gains → RSI 100, all losses → RSI 0
- Edge case: no gains/losses → RSI 50 (neutral)

### Bollinger Bands
- Middle band (SMA 20) matches simple moving average
- Std dev calculation correct (sqrt of variance)
- Upper = Middle + 2×σ, Lower = Middle - 2×σ
- First 20 bars return null

### ATR (Average True Range)
- True Range = max(H-L, |H-PC|, |L-PC|) computed correctly
- Smoothed average (EMA-like smoothing) matches batch
- First bar TR = H - L

### VWAP (Volume-Weighted Average Price)
- Typical Price = (H+L+C)/3 computed correctly
- Cumulative TP×V / Cumulative V matches batch
- Volume = 0 edge case handled (VWAP stays at prior or null)
- Reset on session open

## Tier 2 Tests

### EMA 50/200
- Incremental matches batch (same as EMA 9/21 tests, different periods)

### SMA (Simple Moving Average)
- Incremental SMA 20 matches batch
- Incremental SMA 50 matches batch
- First (period-1) bars return null

### Stochastic %K
- %K = (Close - L14) / (H14 - L14) × 100
- Matches batch on 100-bar window
- First 14 bars return null
- Edge case: H = L (divide by zero) → %K = 50

### CCI (Commodity Channel Index)
- Typical Price (H+L+C)/3 computed
- SMA of TP computed
- Mean Deviation (avg absolute deviation from SMA) computed
- CCI = (TP - SMA) / (0.015 × MD)
- Matches batch on 100-bar window

### Momentum
- Momentum = Close - Close 12 bars ago
- First 12 bars return null
- Positive momentum = uptrend, negative = downtrend

### MACD
- Fast EMA (12) and Slow EMA (26) computed (see EMA tests)
- MACD = Fast - Slow
- Signal = EMA 9 of MACD
- Histogram = MACD - Signal
- All three lines match batch

### ADX (Average Directional Index)
- +DM = max(H - PH, 0), -DM = max(PL - L, 0)
- Smoothed directional movement
- True Range (ATR) calculated
- +DI = (+DM smoothed) / ATR, -DI similar
- ADX = smoothed ratio of DI difference
- Matches batch on 100+ bar window (slow to stabilize)

## For AI Agents

### Working In This Directory

1. **Use real market data** — Tests use actual SPX bars from known dates (e.g., 2026-02-20)
2. **Incremental = Batch invariant** — Every test compares incremental vs batch; they must match
3. **Null handling** — Indicators with period > available bars should return null, not error
4. **Floating point precision** — Use `toBeCloseTo()` for floating point comparisons (epsilon = 0.01)
5. **Edge cases** — Test all-gains, all-losses, zero volume, zero range (divide by zero)

### Testing Pattern

```typescript
it('HMA 3m should match batch computation', () => {
  const testBars = loadRealMarketData('2026-02-20-spx-1m.json');  // 390 bars

  // Incremental (production)
  let state = seedState();
  const incremental_results = [];
  for (const bar of testBars) {
    state = computeIndicators(state, bar);
    incremental_results.push(state.indicators.hma_3m);
  }

  // Batch (naive from scratch)
  const batch_results = testBars.map((_, i) => {
    const window = testBars.slice(Math.max(0, i - 2), i + 1);
    return computeHMABatch(window);
  });

  // Verify match
  for (let i = 0; i < testBars.length; i++) {
    if (batch_results[i] === null) {
      expect(incremental_results[i]).toBeNull();
    } else {
      expect(incremental_results[i]).toBeCloseTo(batch_results[i], 2);
    }
  }
});
```

## Test Data

All tests use realistic market data:
- **Date range**: 2026-02-20 to 2026-03-20
- **Timeframe**: 1-minute bars (390 bars per day)
- **Symbols**: SPX, select SPXW 0DTE contracts
- **Real OHLCV**: Actual traded prices, not synthetic

Fixtures stored in `tests/fixtures/` and loaded as JSON.

## Performance Tests

Optional performance assertions:

```typescript
it('should compute 100 bars in < 100ms', () => {
  const bars = loadTestData();

  const start = performance.now();
  let state = seedState();
  for (const bar of bars) {
    state = computeIndicators(state, bar);
  }
  const elapsed = performance.now() - start;

  expect(elapsed).toBeLessThan(100);  // All indicators on 100 bars < 100ms
});
```

## Dependencies

### Internal
- `src/pipeline/indicators/tier1.ts`
- `src/pipeline/indicators/tier2.ts`
- `src/types.ts` (IndicatorState)

### External
- `vitest` — Test framework
- Test data fixtures (real market data)

<!-- MANUAL: Add indicator test-specific notes or new edge cases below -->

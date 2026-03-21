<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# indicators — Technical Indicator Implementations

## Purpose

Pure computational functions for all technical indicators. Split into two tiers:

- **Tier 1**: Core indicators for all instruments (HMA, EMA, RSI, Bollinger Bands, ATR, VWAP)
- **Tier 2**: Extended indicators for underlying only (EMA 50/200, SMA, Stochastic, CCI, Momentum, MACD, ADX)

All indicators compute **incrementally** from rolling window state (IndicatorState), never from scratch.

## Key Files

| File | Description |
|------|-------------|
| `tier1.ts` | Core indicators: Hull Moving Average (HMA), Exponential Moving Average (EMA), Relative Strength Index (RSI), Bollinger Bands, Average True Range (ATR), Volume-Weighted Average Price (VWAP) |
| `tier2.ts` | Extended indicators: EMA 50/200, Simple Moving Average (SMA), Stochastic, Commodity Channel Index (CCI), Momentum, MACD, Average Directional Index (ADX) |

## Tier 1 Indicators (All Instruments)

### HMA (Hull Moving Average)
- **Periods**: 3m, 5m, 10m, 20m (e.g., HMA 3m uses 3-bar window on 1m timeframe = 3-minute HMA)
- **Formula**: Weighted average with emphasis on recent closes
- **Purpose**: Responsive moving average that reduces lag compared to SMA
- **State**: Rolling window of closes (size = period)

### EMA (Exponential Moving Average)
- **Periods**: 9, 21 (commonly used for short-term momentum)
- **Formula**: EMA_t = alpha × Close_t + (1 - alpha) × EMA_{t-1}, where alpha = 2 / (period + 1)
- **Purpose**: Smooth trend following with responsive recent price weighting
- **State**: Prior EMA value (single number per period)

### RSI (Relative Strength Index)
- **Period**: 14 (standard)
- **Formula**: RSI = 100 - 100 / (1 + RS), where RS = avg gain / avg loss over 14 bars
- **Thresholds**: > 80 = overbought, < 25 = oversold, 70 = strong bullish, 30 = strong bearish
- **Purpose**: Momentum oscillator, extremes signal mean reversion setups
- **State**: Rolling gains/losses, smoothed averages

### Bollinger Bands
- **Period**: 20 (standard)
- **Formula**: Middle = SMA(20), Upper/Lower = Middle ± (2 × StdDev(20))
- **Purpose**: Volatility bands; prices extreme to bands suggest mean reversion
- **State**: Rolling window of closes, running sum, sum of squares for std dev

### ATR (Average True Range)
- **Period**: 14 (standard)
- **Formula**: True Range = max(H - L, |H - prior_C|, |L - prior_C|), ATR = smoothed avg(TR)
- **Purpose**: Volatility measure; high ATR = high intraday swings
- **State**: Prior close, rolling true ranges

### VWAP (Volume-Weighted Average Price)
- **Formula**: VWAP = Σ(typical_price × volume) / Σ(volume), where typical_price = (H + L + C) / 3
- **Purpose**: Fair-value anchor; price above VWAP = bullish, below = bearish
- **State**: Cumulative TP×V, cumulative volume

## Tier 2 Indicators (Underlying Only)

### EMA 50/200
- **Purpose**: Intermediate/long-term trend following
- **State**: Prior EMA values

### SMA (Simple Moving Average)
- **Periods**: 20, 50 (support/resistance levels)
- **Formula**: SMA = Σ(last N closes) / N
- **State**: Rolling window of closes

### Stochastic
- **Period**: 14 (standard)
- **Formula**: %K = (Close - LowestLow_14) / (HighestHigh_14 - LowestLow_14) × 100
- **Purpose**: Momentum oscillator; > 80 = overbought, < 20 = oversold
- **State**: Rolling highs/lows over 14 bars

### CCI (Commodity Channel Index)
- **Period**: 20 (standard)
- **Formula**: CCI = (Typical Price - SMA of TP) / (0.015 × Mean Deviation)
- **Purpose**: Momentum; values > 100 = trending up, < -100 = trending down
- **State**: Rolling typical prices, mean, mean deviation

### Momentum
- **Period**: 12 (standard)
- **Formula**: Momentum = Close_t - Close_{t-12}
- **Purpose**: Rate of price change; positive = uptrend, negative = downtrend
- **State**: Prior closes (need 12-bar history)

### MACD (Moving Average Convergence Divergence)
- **Formula**: MACD = EMA(12) - EMA(26), Signal = EMA(9) of MACD, Histogram = MACD - Signal
- **Purpose**: Trend + momentum; crossovers signal regime changes
- **State**: Two EMA values (fast/slow), signal EMA

### ADX (Average Directional Index)
- **Period**: 14 (standard)
- **Formula**: +DM = max(H - prior_H, 0), -DM = max(prior_L - L, 0), DI_lines smoothed, ADX = smoothed DI ratio
- **Purpose**: Trend strength (0-100); > 25 = strong trend, < 20 = weak/no trend
- **State**: Prior high/low, +DM/-DM smoothing state, ATR state

## For AI Agents

### Working In This Directory

1. **Use incremental computation** — Never compute from scratch on the full window. Use state-based updates (O(1) per bar).
2. **Don't mutate state** — Return new IndicatorState objects; immutability prevents hidden bugs.
3. **Handle edge cases** — First few bars may have incomplete state (< period bars). Return null for unavailable indicators.
4. **Test against batch** — Verify incremental results match batch computation on full historical window.
5. **Documentation**: Each indicator needs a comment explaining the formula and state variables.

### Testing Requirements

- Unit tests verify incremental computation matches batch (full-window recomputation)
- Edge cases: first bar, not enough bars for period, zero volume (for VWAP)
- Performance: O(1) per bar (no loops on state), typically < 1ms per 100 bars

### Common Patterns

- **Window state**: Keep only necessary history (rolling array or deque)
- **Smoothing**: Use prior value + alpha × change for EMA-like indicators
- **Volatility**: Track sum and sum-of-squares for efficient std dev
- **Null handling**: Return null for indicators with insufficient data

## Dependencies

### Internal
- `src/types.ts` — IndicatorState type

### External
None (pure math)

## Indicator Formula Reference

### Quick Lookup

| Indicator | Period | Key State | Update Rule |
|-----------|--------|-----------|-------------|
| HMA | 3/5/10/20 | Rolling closes | Weighted avg of closes |
| EMA 9/21 | 9/21 | Prior EMA | EMA = α × Close + (1-α) × Prior EMA |
| RSI 14 | 14 | Gains/losses | RSI = 100 - 100/(1+RS) |
| BB 20 | 20 | Closes, sum, sum² | Mean ± 2×σ |
| ATR 14 | 14 | Prior close, TR | Smoothed true range |
| VWAP | cumulative | TP×V, V | Σ(TP×V)/ΣV |
| Stochastic 14 | 14 | H14, L14 | (Close - L14)/(H14-L14)×100 |
| MACD | 12/26/9 | EMA12, EMA26, Signal | MACD=EMA12-EMA26 |
| ADX 14 | 14 | +DM, -DM, TR | Directional movement ratio |

## Performance Notes

- **Memory per symbol**: ~1-2 KB per symbol (rolling windows + EMA states)
- **Compute per bar**: < 1ms for all indicators on one bar
- **Scaling**: 500+ symbols processed incrementally in < 1s per bar

<!-- MANUAL: Add indicator-specific optimization notes or formula variations below -->

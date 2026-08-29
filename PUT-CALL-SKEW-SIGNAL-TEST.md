# Put/Call Skew Signal Test Plan

**Objective**: Determine if put/call pricing skew at market peaks can be used as a directional signal for 0DTE afternoon trades.

**Problem Statement**: On June 8, 2026, when SPX peaked at 7462 (15:00 ET), the 7440 call was 4.1× more expensive than the 7440 put. By close, the ratio reversed completely (calls worthless, puts +2.7× gain). Can we predict reversals from this skew?

**Hypothesis**: When put/call ratio at ATM/near-ATM strikes shows extreme bias (calls 3x+ or puts 3x+) at what appears to be a peak, the market is priced for a sustained move in that direction but frequently reverses. Fading the skew (buying puts when calls are expensive) is profitable.

---

## Data Available

**Date Range**: March 27, 2025 – June 8, 2026 (280+ trading days)  
**Location**: `/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/`  
**Format**: Parquet files, one per trading day  
**Contents**: 1-minute bars for SPX + ~81-82 0DTE option contracts

**Data Quality**:
- June 8: 94% median coverage (BEST)
- June 4: 87% coverage
- June 3-2-1: 81-86% coverage  
- Earlier periods: 79-87% coverage

**Note**: June 5 excluded due to extreme move (152 pts) causing stale contract data at EOD.

---

## Test 1: Cross-Day Pattern Validation (High Priority)

**Objective**: Test if put/call skew predicts direction across different market regimes.

### Test 1a: Day-by-Day Skew Analysis

Run this DuckDB query on each day to extract afternoon put/call ratios:

```sql
-- For date 'YYYY-MM-DD', compute call/put ratio every 30 min in afternoon (13:00+ ET)
WITH afternoon AS (
  SELECT 
    ts,
    strftime(to_timestamp(ts), '%H:%M') as time,
    symbol,
    close,
    DATE_TRUNC('minute', to_timestamp(ts)) / 30 as bucket_30min
  FROM read_parquet('/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/YYYY-MM-DD.parquet')
  WHERE timeframe = '1m' AND ts >= 1717939200  -- 13:00 ET on 2026-06-08; adjust for each date
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY symbol, bucket_30min ORDER BY ts DESC) as rn
  FROM afternoon
)
SELECT 
  time,
  CASE WHEN symbol = 'SPX' THEN ROUND(close, 0) ELSE NULL END as spx,
  CASE WHEN symbol LIKE 'SPXW%' AND symbol LIKE '%P07440000' THEN ROUND(close, 2) ELSE NULL END as p7440,
  CASE WHEN symbol LIKE 'SPXW%' AND symbol LIKE '%C07440000' THEN ROUND(close, 2) ELSE NULL END as c7440,
  CASE WHEN symbol LIKE 'SPXW%' AND symbol LIKE '%P07430000' THEN ROUND(close, 2) ELSE NULL END as p7430,
  CASE WHEN symbol LIKE 'SPXW%' AND symbol LIKE '%C07430000' THEN ROUND(close, 2) ELSE NULL END as c7430
FROM ranked
WHERE rn = 1
ORDER BY ts, symbol;
```

**Dates to Test**:
- 2026-06-01 (+35 pts, UP)
- 2026-06-02 (+23 pts, UP)
- 2026-06-03 (-47 pts, DOWN)
- 2026-06-04 (+55 pts, UP)
- 2026-06-08 (-50 pts, DOWN)

**Analysis**:
For each date, record:
1. Peak SPX time and price
2. Call/put ratio at 7430-7440 strikes at the peak
3. How much price moved post-peak
4. Whether high call skew (calls 3x+ more expensive) predicted direction

**Expected Pattern** (if signal works):
- Days with extreme call skew (3:1 or more) at peaks should be followed by reversals (puts gain 2-3x)
- Days with balanced skew (1:1) at peaks should show minimal directional bias post-peak

---

## Test 2: Intraday Signal Timing (Medium Priority)

**Objective**: Can we detect the skew signal early enough (1-2pm ET) to trade the reversal?

### Test 2a: Time-Series Skew Progression

For 2026-06-08, extract hourly put/call ratios and correlate with subsequent 1-hour returns:

```sql
-- 2026-06-08 hourly snapshots
WITH hours AS (
  SELECT 1780925400 + (n * 3600) as target_ts, n as hour_num
  FROM (SELECT generate_subscripts(array[0,1,2,3,4,5,6,7,8,9], 1) as n)
)
SELECT 
  strftime(to_timestamp(ANY_VALUE(target_ts)), '%H:00 ET') as hour,
  ROUND(MAX(CASE WHEN symbol = 'SPX' THEN close END), 0) as spx,
  ROUND(MAX(CASE WHEN symbol LIKE '%P07440000' THEN close END), 2) as p7440,
  ROUND(MAX(CASE WHEN symbol LIKE '%C07440000' THEN close END), 2) as c7440,
  ROUND(MAX(CASE WHEN symbol LIKE '%C07440000' THEN close END) / 
         NULLIF(MAX(CASE WHEN symbol LIKE '%P07440000' THEN close END), 0), 1) as c_to_p_ratio,
  ROUND(MAX(CASE WHEN symbol LIKE '%P07430000' THEN close END), 2) as p7430,
  ROUND(MAX(CASE WHEN symbol LIKE '%C07430000' THEN close END), 2) as c7430
FROM hours h
JOIN read_parquet('/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/2026-06-08.parquet') d
  ON d.timeframe = '1m' 
  AND d.symbol IN ('SPX', 'SPXW260608P07440000', 'SPXW260608C07440000', 
                   'SPXW260608P07430000', 'SPXW260608C07430000')
  AND ABS(d.ts - h.target_ts) <= 30
GROUP BY h.hour_num
ORDER BY h.hour_num;
```

**Key Metrics**:
- When does the call/put ratio peak? (Answer: ~15:00 ET at 4.1:1 on June 8)
- What is the SPX move from peak time to close? (Answer: -57 pts on June 8)
- How much do put values change from peak to close? (Answer: 7.27 → 31.55 on 7440P)

**Test Success Criteria**:
- If skew peaks within 1 hour of actual price peak → signal is tradeable (entry at peak possible)
- If put values double by 16:00 ET → profit exists for put buyers at 15:00

---

## Test 3: Multi-Month Statistical Validation (High Priority)

**Objective**: Measure if extreme skew → reversal is statistically significant across 6+ months.

### Methodology

1. **For each trading day** in the 200-day window (2026-01-06 to 2026-06-08):
   - Find the intraday SPX peak time and price
   - Extract call/put ratio at ATM ±10 strike at that peak
   - Measure SPX movement from peak to 16:00 ET close
   - Record the outcome

2. **Categorize by skew level**:
   - Extreme call (calls 4x+ more expensive): Count reversal wins
   - High call (calls 2-4x): Count reversal wins
   - Balanced (calls 0.8-1.25x): Count neutral/random outcomes
   - High put (puts 2-4x): Count reversal wins (opposite direction)
   - Extreme put (puts 4x+): Count reversal wins

3. **Calculate win rates**:
   - For each skew category, count trades where fading the skew (buying puts on high call skew) was profitable
   - Target: >55% win rate to justify trading

### Expected Results

| Skew Category | Sample Size | Win % | Avg Return | Verdict |
|---|---|---|---|---|
| Extreme call (4x+) | ? | >60% | +2-5% | **TRADEABLE** |
| High call (2-4x) | ? | >55% | +1-3% | TRADEABLE |
| Balanced (0.8-1.25x) | ? | ~50% | ~0% | Not signal |
| High put (2-4x) | ? | >55% | +1-3% | TRADEABLE |
| Extreme put (4x+) | ? | >60% | +2-5% | TRADEABLE |

---

## Test 4: Implementation Test (Lowest Priority)

**Objective**: Once pattern is validated, can it be backtested in OptionX as a real trading rule?

### Pseudo-Config

```json
{
  "id": "skew-fade-0dte",
  "signal": {
    "type": "put_call_skew",
    "mode": "fade",
    "ratioThreshold": 3.0,
    "timeframe": "1m",
    "sampleWindow": "30min"
  },
  "contract": {
    "symbol": "SPX",
    "optionPrefix": "SPXW",
    "strikeOffset": 0,
    "strikeInterval": 5,
    "dte": 0
  },
  "risk": {
    "takeProfitMultiplier": 0.5,
    "stopLossMultiplier": 1.0,
    "maxPositions": 3,
    "maxDailyLoss": 500
  },
  "execution": {
    "mode": "PAPER",
    "maxSpreadForMarket": 1.0
  }
}
```

---

## How to Run Tests in SPXer

### Option A: Direct DuckDB Query

```bash
cd /home/ubuntu/SPXer
duckdb << 'EOF'
-- Paste Test 1a, 2a, or 3 query here
EOF
```

### Option B: Backtest Server (Studio)

1. **Start backtest-server** if not running:
   ```bash
   cd /home/ubuntu/SPXer
   npm run build
   npx tsx scripts/autoresearch/backtest-server.ts &
   # Server runs on :3700
   ```

2. **Open SPXer Studio** in browser:
   ```
   http://localhost:3800/spxer/studio
   ```

3. **Create a custom test config** (see "Test 4" above), add to `/home/ubuntu/optionx/configs/`, and run a single-day replay:
   ```bash
   cd /home/ubuntu/SPXer
   npx tsx scripts/replay-hma-test.ts
   ```

### Option C: Manual Python Analysis

If you want to script the analysis:

```python
import duckdb
import pandas as pd

conn = duckdb.connect()

# Test 1a for multiple dates
dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-08']

for date in dates:
    df = conn.execute(f"""
        -- Insert Test 1a query here, with date '{date}'
    """).df()
    
    # Compute call/put ratio
    df['c_to_p'] = df['c7440'] / df['p7440'].replace(0, 1)
    
    # Find peak
    spx_peak_idx = df['spx'].idxmax()
    peak_ratio = df.loc[spx_peak_idx, 'c_to_p']
    peak_time = df.loc[spx_peak_idx, 'time']
    
    # Measure reversion
    spx_at_close = df.iloc[-1]['spx']
    reversion = spx_peak_idx - spx_at_close
    
    print(f"{date}: peak={peak_time} ratio={peak_ratio:.1f} reversion={reversion:.0f}pts")
```

---

## Success Criteria

**This signal is worth trading if:**
1. ✅ **Test 1** shows consistent skew reversal pattern across 5+ different days
2. ✅ **Test 2** shows skew peaks within 30min of actual price peak (tradeable timing)
3. ✅ **Test 3** shows >55% win rate fading extreme skew (4x+) across 200+ days
4. ✅ **Test 4** backtest shows positive P&L with <500 max drawdown over 20+ days

**Red Flags**:
- ❌ Skew peaks AFTER price peak (not predictive, just reactive)
- ❌ Win rate <50% on any category (worse than random)
- ❌ Pattern breaks on different market regimes (morning vs afternoon)
- ❌ Signal requires historical context we don't have in live (violates 1-min-bar-only rule)

---

## Timeline

- **Week 1** (June 9-13): Complete Test 1 (5 days)  → Report pattern type
- **Week 2** (June 16-20): Complete Test 2 (1 deep day) → Report tradeable window
- **Week 3** (June 23-27): Complete Test 3 (200 days) → Report statistical significance
- **Week 4** (June 30-): Test 4 (live backtest) OR reject signal

---

## Resources

**Query Runner**: DuckDB CLI at `/home/ubuntu/SPXer`  
**Data Path**: `/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/`  
**Backtest Server**: http://localhost:3700 (when running)  
**Studio**: http://localhost:3800/spxer/studio (primary UI)  
**Config Template**: `/home/ubuntu/optionx/configs/`  

---

## Notes

- All times are ET (Eastern Time)
- "Close" = 16:00 ET market close
- All option prices are bid-ask midpoints from Parquet (not exact fills)
- Afternoon = 13:00 ET onwards (after initial theta burn)
- Contract symbol format: `SPXWYYYYMMDDX<strike×1000>` (e.g., SPXW260608C07440000)

---

## Test 5: Gamma Confirmation Signal (BONUS)

**Objective**: Can we use option gamma to confirm extreme skew signals?

**Theory**: Extreme call skew (4:1) alone might be noisy. But extreme skew **+ high gamma** creates a self-reinforcing reversal setup:
- Calls are expensive (4:1 skew)
- Call gamma is high (delta sensitive to moves)
- If price dips even slightly, calls lose 2-3x faster than puts gain
- This creates a "trap" for bullish traders → fast reversal

### How to Compute Gamma

For a 0DTE option, approximate gamma from the price series:

```
Gamma ≈ (delta(t+1) - delta(t)) / (underlying_move)
Delta ≈ (call_price - put_price) / underlying_spread  [crude, but fast]
```

Better approach: Use Black-Scholes with known parameters:
- S = SPX price at time t
- K = strike price
- T = time to expiry (0DTE = 1 min / 1440 = 0.0007 days)
- σ = implied volatility (if available; otherwise use realized vol)
- r = 0 (overnight rates)

**Key insight**: For 0DTE, 1-minute time decays fast. Gamma is HIGHEST 30-45 min before close.

### Expected Pattern

At 15:00 ET on June 8:
- Call/put ratio = 4.2:1 (extreme)
- Call gamma should be HIGH (deep ITM, time decay accelerating)
- This creates the "trap" → reversal likely

At 14:00 ET on June 8:
- Call/put ratio = 0.5:1 (balanced)
- Gamma is MODERATE on both sides (no trap)
- Reversal less likely

### Test Protocol

For each date/time, record:
1. Call/put ratio
2. Estimated gamma on calls
3. Estimated gamma on puts
4. Subsequent 1-hour return

**Analysis**: Build a 2D matrix (skew vs gamma) and measure win rate in each quadrant.

| Call/Put Ratio | Gamma Regime | Win Rate | Tradeable? |
|---|---|---|---|
| 4:1+ | High | ? | Likely ✅ |
| 4:1+ | Low | ? | Less clear |
| 1:1 | High | ? | Unclear |
| 1:1 | Low | ? | No signal |

---

## Files Reference

**Data location**: `/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/`  
**Data source**: Polygon aggregates (ThetaData removed 2026-05-17)  
**Contracts per day**: 82-83 (SPX + options)  
**Bars per day**: ~21,500-24,900 rows (sparse, not every contract every minute)  
**Date range**: March 27, 2025 – June 8, 2026


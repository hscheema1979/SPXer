# SPXer Config Optimization — Research Brief

## Goal
Increase 22-day backtest profitability (win rate, Sharpe ratio, total P&L) by finding optimal configuration parameters for the deterministic signal detection + position management pipeline.

## Current Baseline
- **Config**: DEFAULT_CONFIG (src/replay/config.ts)
- **22-day backtest**: ~40% win rate, negative P&L
- **Live data (3 days)**: 100% win rate, +$23,887 — proves the logic works when data is rich
- **Gap**: Polygon historical data has thinner options coverage than live Tradier

## System Context

### How Trades Happen
1. Every 1-minute bar, the system scans option contracts within `strikeSearchRange` points of SPX
2. For each contract, it checks RSI crosses (oversold→up = bullish, overbought→down = bearish)
3. If a signal fires AND the market regime allows it, a position opens
4. Position exits on: stop loss hit, take profit hit, or time cutoff (15:30 ET)

### Key Parameters (what we can tune)
| Parameter | Default | Range | What it controls |
|-----------|---------|-------|-----------------|
| `strikeSearchRange` | 60 | 20-200 | How many option contracts to scan (±N points from SPX) |
| `rsi.oversoldThreshold` | 20 | 10-35 | SPX RSI level that triggers call signals |
| `rsi.overboughtThreshold` | 80 | 65-90 | SPX RSI level that triggers put signals |
| `signals.optionRsiOversold` | 30 | 15-45 | Option contract RSI cross threshold (bullish) |
| `signals.optionRsiOverbought` | 70 | 55-85 | Option contract RSI cross threshold (bearish) |
| `position.stopLossPercent` | 50 | 30-90 | % below entry to set stop loss |
| `position.takeProfitMultiplier` | 5 | 2-15 | Entry price × N = take profit target |
| `position.maxPositionsOpen` | 3 | 1-6 | Max concurrent open positions |
| `timing.tradingStartEt` | 09:30 | 09:30-14:00 | Earliest time to open trades |
| `timing.tradingEndEt` | 15:45 | 11:30-15:45 | Latest time to consider signals |
| `judge.escalationCooldownSec` | 600 | 60-1800 | Min seconds between new positions |
| `risk.maxDailyLoss` | 500 | 200-2000 | Stop trading for the day after this loss |
| `risk.maxTradesPerDay` | 10 | 3-20 | Max total trades per day |

### Data Reality
- Polygon data: ~82-150 contracts/day (thinner than live)
- Some contracts have sparse bars (gaps, stale prices)
- RSI on thin data can be noisy (false crosses)
- Morning tends to have more volume/liquidity than afternoon

## Hypotheses to Test

### H1: Strike range affects signal quality, not just quantity
**Theory**: Wider strike range (±100-150) includes cheaper, more volatile OTM options where RSI is noisier. There may be a sweet spot where we get enough contracts for good coverage without adding noise.
**Test**: Compare strike ranges 40, 60, 80, 100, 120, 150 — look at win rate per range, not just trade count.
**Expected**: Middle range (80-100) outperforms both narrow (40-60) and wide (120-150).

### H2: Time-of-day matters more than RSI thresholds
**Theory**: Morning momentum (9:30-11:00) and power hour (14:00-15:45) have distinctly different optimal parameters. Morning is trend-following, afternoon is mean-reversion.
**Test**: Run morning-only vs afternoon-only vs all-day with same RSI/stop settings.
**Expected**: Splitting into time windows with different configs outperforms a single all-day config.

### H3: Stop loss is too tight for 0DTE options
**Theory**: 0DTE options have extreme intraday volatility. A 50% stop gets triggered by normal noise before the thesis plays out. Wider stops (70-80%) with larger TP multipliers should catch more winners.
**Test**: Compare SL 40/50/60/70/80% each with TP 3/5/8/10x.
**Expected**: SL 70%+ with TP 8x+ produces better Sharpe than tight stops.

### H4: Escalation cooldown is preventing good setups
**Theory**: 600s (10 min) cooldown between trades means the system misses clustered signals that occur during fast moves. But too-short cooldown leads to overtrading.
**Test**: Compare cooldown 120s, 300s, 600s, 900s.
**Expected**: 300s is optimal — short enough to catch clustered signals, long enough to avoid noise.

### H5: Max positions should be time-dependent
**Theory**: Morning volatility supports more positions. Afternoon decay (theta) makes multiple positions risky. Max 4-5 in morning, max 2 in afternoon.
**Test**: Compare static max (2,3,5) vs time-split configs.
**Expected**: Lower max positions improves win rate but reduces total P&L. Optimal is 3.

### H6: Option RSI thresholds need to be tighter than SPX RSI
**Theory**: Option contract RSI crosses are noisier than SPX-level crosses. Setting option RSI thresholds closer to extremes (25/75 or 20/80) filters out false signals from thin contracts.
**Test**: Compare option RSI 25/75 vs 30/70 vs 35/65.
**Expected**: Tighter option RSI (25/75) improves win rate at cost of fewer trades.

### H7: The interaction between strike range and option RSI matters
**Theory**: Wider strike ranges include noisier contracts. If we widen the strike range, we should also tighten option RSI thresholds to compensate.
**Test**: Cross-product of strike range × option RSI thresholds.
**Expected**: Wide strike (120) + tight option RSI (25/75) outperforms wide strike + loose option RSI.

## Metrics (ranked by importance)
1. **Sharpe ratio** — Risk-adjusted return (most important for live trading)
2. **Win rate** — Percentage of profitable trades (target: >50%)
3. **Total P&L** — Cumulative profit across all dates
4. **Max drawdown** — Worst single-day loss (must stay above -$500)
5. **Average daily P&L** — Must be positive for the config to be viable

## Verification
After each iteration:
- Run `npx tsx scripts/autoresearch/param-search.ts --dates=<test-dates>` with the modified config
- Check that Sharpe > previous best Sharpe
- Check that max daily loss > -$500
- Check that total trades >= 10 (enough sample size)

## Guard Rails
- Never modify files outside `src/replay/config.ts`
- Never change signal detection logic (only thresholds)
- Never remove existing presets
- Always keep DEFAULT_CONFIG unchanged (add new presets)
- If a change makes things worse, revert it
- If stuck after 3 consecutive failures, reassess the hypothesis

## Research Process
1. **Pick a hypothesis** to test (start with H1, as strike range is the biggest lever)
2. **Design the experiment** — what config changes to make, what dates to test
3. **Run the experiment** — execute backtest, record results
4. **Analyze results** — did the data support the hypothesis?
5. **Update beliefs** — revise hypotheses based on evidence
6. **Iterate** — pick next hypothesis or refine current one
7. **Combine winners** — once individual dimensions are optimized, combine best settings

## Expected Output
After completing research:
- A new preset in `src/replay/config.ts` named `optimized` with the best-found parameters
- A results summary showing improvement over baseline
- Updated hypotheses with evidence (what we learned)

# Agent Parameter Optimizer

Agent-driven parameter optimization for SPXer replay. The agent makes all decisions — what to test, when to stop, what to combine.

## Tools

```bash
# Run one variant (outputs JSON)
npx tsx scripts/autoresearch/optimizer/run-variant.ts \
  --dimension=stopLoss --label="SL 70%" --dates=quick6 \
  --config='{"position":{"stopLossPercent":70}}'

# Query prior results
npx tsx scripts/autoresearch/optimizer/query-results.ts --summary
npx tsx scripts/autoresearch/optimizer/query-results.ts --dimension=stopLoss
npx tsx scripts/autoresearch/optimizer/query-results.ts --top=10
```

## Protocol

1. `query-results.ts --summary` → see what's been done
2. If no baseline → run: `--dimension=baseline --label=Baseline --config='{}'`
3. Explore one dimension at a time:
   - Run 3-6 variants on `quick6` dates
   - **HARMFUL** (score < baseline - 2): skip this dimension entirely
   - **NO IMPACT** (score within ±2 of baseline): skip, not worth pursuing
   - **WINNER** (score > baseline + 5): note it for combination phase
   - **MARGINAL** (2-5 above baseline): include but lower priority
   - Stop when last 2 variants didn't beat running best for this dimension
4. Combine winners:
   - Start with single best variant
   - Layer on each other winner, one at a time
   - If adding drops score → remove it
5. Validate final combo on `full22` dates (--dates=full22 --phase=validate)
6. Report final config and score

## Dimensions

| # | Dimension | Config Path | Values |
|---|-----------|-------------|--------|
| 1 | hmaPeriods | signals.hmaCrossFast/Slow | 5×19, 5×25, 19×25 |
| 2 | emaPeriods | signals.enableEmaCrosses, emaCrossFast/Slow | off, 9×21, 9×50, 21×50 |
| 3 | stopLoss | position.stopLossPercent | 0, 30, 50, 70, 80 |
| 4 | takeProfit | position.takeProfitMultiplier | 2, 3, 4, 5, 7, 10 |
| 5 | rsiThresholds | signals.rsiOversold/Overbought | 15/85, 20/80, 25/75, 30/70 |
| 6 | optionRsi | signals.optionRsiOversold/Overbought | 25/75, 30/70, 35/65, 40/60 |
| 7 | strikeRange | strikeSelector.strikeSearchRange | 40, 60, 80, 100, 120 |
| 8 | contractPrice | strikeSelector.contractPriceMin/Max | 0.2/3, 0.2/5, 0.5/8, 1/10 |
| 9 | timeWindows | timeWindows.activeStart/End | full, morning, afternoon, power-hour |
| 10 | maxPositions | position.maxPositionsOpen | 1, 2, 3, 5, 10 |
| 11 | timeframe | pipeline.timeframe | 1m, 2m, 3m, 5m |
| 12 | cooldown | judges.escalationCooldownSec | 60, 120, 180, 300 |

## Date Presets

- `quick6`: 2026-02-20, 02-24, 03-05, 03-10, 03-19, 03-20 (~30s per variant)
- `full22`: all 22 dates (~2-3 min per variant)

## Composite Score

`(winRate * 40) + (min(sharpe, 1) * 30) + (avgDailyPnl > 0 ? 20 : 0) + (worstDay > -500 ? 10 : 0)`

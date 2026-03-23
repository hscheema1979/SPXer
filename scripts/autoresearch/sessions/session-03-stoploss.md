# Session 3: Stop Loss

## Goal
Find the optimal stop loss percentage, including testing no stop loss at all.

## Scope
`src/replay/config.ts` — only modify `position.stopLossPercent` in DEFAULT_CONFIG.

## Metric
Win rate (higher is better). Output from verify command.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20
```

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
6

## What to Test (one change per iteration)
1. `position: { stopLossPercent: 0 }` — No stop loss (ride to TP or time exit)
2. `position: { stopLossPercent: 40 }` — Tight stop
3. `position: { stopLossPercent: 50 }` — Current default
4. `position: { stopLossPercent: 60 }` — Medium
5. `position: { stopLossPercent: 70 }` — Wide
6. `position: { stopLossPercent: 80 }` — Very wide

## Hypothesis
0DTE options have extreme intraday volatility. Tight stops (40-50%) get shaken out by normal noise before the thesis plays out. Wider stops (70-80%) or no stop at all may produce better results by letting trades breathe. But no stop risks catastrophic single-trade losses.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

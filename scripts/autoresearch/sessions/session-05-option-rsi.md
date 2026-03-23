# Session 5: Option RSI Thresholds

## Goal
Find the optimal RSI cross thresholds for option contract signals (separate from SPX-level RSI).

## Scope
`src/replay/config.ts` — only modify `signals.optionRsiOversold` and `signals.optionRsiOverbought` in DEFAULT_CONFIG.

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
3

## What to Test (one change per iteration)
1. `signals: { optionRsiOversold: 25, optionRsiOverbought: 75 }` — Tight: only extreme option RSI crosses
2. `signals: { optionRsiOversold: 30, optionRsiOverbought: 70 }` — Current default
3. `signals: { optionRsiOversold: 35, optionRsiOverbought: 65 }` — Loose: more signals from options

## Hypothesis
Option contract RSI is noisier than SPX RSI because options trade thinner. Tighter thresholds (25/75) filter out false signals from thin contracts. Looser (35/65) may catch more setups but with lower quality.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

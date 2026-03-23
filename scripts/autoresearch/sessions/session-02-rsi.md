# Session 2: RSI Thresholds

## Goal
Find the optimal SPX-level RSI oversold/overbought thresholds for signal generation.

## Scope
`src/replay/config.ts` — only modify `rsi.oversoldThreshold` and `rsi.overboughtThreshold` in DEFAULT_CONFIG.

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
4

## What to Test (one change per iteration)
1. `rsi: { oversoldThreshold: 15, overboughtThreshold: 85 }` — Tight: only extreme moves trigger
2. `rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }` — Current default
3. `rsi: { oversoldThreshold: 25, overboughtThreshold: 75 }` — Moderate: more signals
4. `rsi: { oversoldThreshold: 30, overboughtThreshold: 70 }` — Loose: many signals

## Hypothesis
Tighter thresholds (15/85 or 20/80) produce fewer but higher-quality signals. Looser thresholds (30/70) generate too many false signals on thin Polygon data.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

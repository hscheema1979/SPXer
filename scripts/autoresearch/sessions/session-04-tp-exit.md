# Session 4: Take Profit / Exit Strategy

## Goal
Find the optimal exit strategy: fixed TP multiplier, time exit only, or reversal exit.

## Scope
`src/replay/config.ts` — only modify `position.takeProfitMultiplier` and `exit.strategy` in DEFAULT_CONFIG.

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
1. `takeProfitMultiplier: 3, exit.strategy: 'takeProfit'` — 300% TP (conservative, exits quick)
2. `takeProfitMultiplier: 5, exit.strategy: 'takeProfit'` — 500% TP (current default)
3. `takeProfitMultiplier: 8, exit.strategy: 'takeProfit'` — 800% TP
4. `takeProfitMultiplier: 10, exit.strategy: 'takeProfit'` — 1000% TP
5. `takeProfitMultiplier: 9999, exit.strategy: 'takeProfit'` — No TP (hold to time exit at 15:45)
6. `takeProfitMultiplier: 9999, exit.strategy: 'scannerReverse'` — No TP, exit on reversal signal

## Hypothesis
Fixed TP caps upside — the March 19 C6600 went +1,986% but a 5x TP would have exited at +400%. However, higher/no TP also means more trades go from green to red. Reversal exit ("stay in as long as thesis holds") may be the best balance.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

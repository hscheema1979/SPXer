# Session 6: Escalation Cooldown

## Goal
Find the optimal cooldown between trade entries. Too long = miss clustered signals. Too short = overtrade.

## Scope
`src/replay/config.ts` — only modify `judge.escalationCooldownSec` in DEFAULT_CONFIG.

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
1. `judge: { escalationCooldownSec: 120 }` — 2 min (aggressive, catches clusters)
2. `judge: { escalationCooldownSec: 300 }` — 5 min
3. `judge: { escalationCooldownSec: 600 }` — 10 min (current default)
4. `judge: { escalationCooldownSec: 900 }` — 15 min (conservative)

## Hypothesis
600s (10 min) may be too long — fast market moves can produce multiple valid signals within 5 minutes. But 120s risks entering on the same signal repeatedly. 300s is likely the sweet spot.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

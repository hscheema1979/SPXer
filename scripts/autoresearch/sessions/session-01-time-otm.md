# Session 1: Time × OTM Contract Cost

## Goal
Find the optimal OTM strike range for each time-of-day window. Morning can go wider ($25-$100 OTM), after 10:30 stick to $25-$50 OTM.

## Scope
`src/replay/config.ts` — only modify `strikeSelector.strikeSearchRange`, `strikeSelector.maxOtmPoints`, and `timing.tradingStartEt` / `timing.tradingEndEt` fields in DEFAULT_CONFIG.

## Metric
Win rate (higher is better). Output from: `npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20`

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
12 (one per combo below)

## What to Test (one change per iteration)

### Morning window (09:30-10:30)
1. `strikeSearchRange: 25, maxOtmPoints: 25, tradingStartEt: '09:30', tradingEndEt: '10:30'`
2. `strikeSearchRange: 50, maxOtmPoints: 50, tradingStartEt: '09:30', tradingEndEt: '10:30'`
3. `strikeSearchRange: 75, maxOtmPoints: 75, tradingStartEt: '09:30', tradingEndEt: '10:30'`
4. `strikeSearchRange: 100, maxOtmPoints: 100, tradingStartEt: '09:30', tradingEndEt: '10:30'`

### Midday window (10:30-14:00)
5. `strikeSearchRange: 25, maxOtmPoints: 25, tradingStartEt: '10:30', tradingEndEt: '14:00'`
6. `strikeSearchRange: 50, maxOtmPoints: 50, tradingStartEt: '10:30', tradingEndEt: '14:00'`

### Afternoon window (14:00-15:45)
7. `strikeSearchRange: 25, maxOtmPoints: 25, tradingStartEt: '14:00', tradingEndEt: '15:45'`
8. `strikeSearchRange: 50, maxOtmPoints: 50, tradingStartEt: '14:00', tradingEndEt: '15:45'`

### Risk caps (all-day, best OTM from above)
9. `risk.maxDailyLoss: 300`
10. `risk.maxDailyLoss: 500`
11. `risk.maxDailyLoss: 800`
12. `risk.maxDailyLoss: 1000`

## Hypothesis
$25-$75 OTM is the sweet spot for morning (09:30-10:30). After 10:30, beyond $50 OTM is dead money. Risk cap of $500 balances survival with opportunity.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults.

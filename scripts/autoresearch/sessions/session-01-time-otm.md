# Session 1: Time x OTM Contract Cost

## Goal
Find the optimal OTM strike range for each time-of-day window. Morning can go wider ($25-$100 OTM), after 10:30 stick to $25-$50 OTM.

## Scope
`src/replay/config.ts` — modify `strikeSelector.strikeSearchRange`, `strikeSelector.maxOtmPoints`, and `timing.tradingStartEt` / `timing.tradingEndEt` fields in DEFAULT_CONFIG.

## Scanner Prompt
`session01-time-otm-2026-03-23-v1.0` — Scanner evaluates whether the current OTM distance is appropriate for the current time window. Focuses on cost/gamma trade-off by time of day.

## Metric
Composite score (higher is better). Output from verify command.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20 --promptId=session01-time-otm-2026-03-23-v1.0
```

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
12 (one per combo below)

## Constant (DO NOT CHANGE)
```typescript
scanners: { enabled: true, enableKimi: true, enableGlm: true, enableMinimax: true, enableHaiku: false, cycleIntervalSec: 30, minConfidenceToEscalate: 0.5, promptId: 'session01-time-otm-2026-03-23-v1.0' }
escalation: { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false }
judge: { enabled: false }
rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }
signals: { enableRsiCrosses: true, enableHmaCrosses: true, enableEmaCrosses: false, optionRsiOversold: 30, optionRsiOverbought: 70 }
position: { stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 3, positionSizeMultiplier: 1.0 }
sizing: { baseDollarsPerTrade: 250, sizeMultiplier: 1.0, minContracts: 1, maxContracts: 10 }
```

## Variable (ONE change per iteration)

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
All config values not listed in Variable above remain at DEFAULT_CONFIG defaults.

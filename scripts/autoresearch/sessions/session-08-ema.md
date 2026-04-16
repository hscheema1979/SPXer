# Session 8: EMA Signals

## Goal
Find which EMA-based signals produce the most profitable trades: MA crossovers vs price crossing above/below a single EMA.

## Scope
`src/replay/config.ts` — modify `signals.enableEmaCrosses` and add new signal types. May also need to modify `src/replay/machine.ts` signal detection to support price > EMA signals.

## Scanner Prompt
`session08-ema-signals-2026-03-23-v1.0` — Scanner prioritizes EMA structure, stacking, and spread over all other indicators. RSI and HMA are secondary. Evaluates EMA stack order and price-vs-EMA.

## Metric
Composite score (higher is better). Output from verify command.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20 --promptId=session08-ema-signals-2026-03-23-v1.0
```

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
6

## Constant (DO NOT CHANGE)
```typescript
scanners: { enabled: true, enableKimi: true, enableGlm: true, enableMinimax: true, enableHaiku: false, cycleIntervalSec: 30, minConfidenceToEscalate: 0.5, promptId: 'session08-ema-signals-2026-03-23-v1.0' }
escalation: { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false }
judge: { enabled: false }
rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }
signals: { enableRsiCrosses: true, enableHmaCrosses: true, optionRsiOversold: 30, optionRsiOverbought: 70 }
position: { stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 3, positionSizeMultiplier: 1.0 }
strikeSelector: { strikeSearchRange: 60 }
```

## Variable (ONE change per iteration)

### EMA Crossovers (two MAs crossing each other)
1. EMA 9/21 cross — Fast, common short-term signal
2. EMA 9/50 cross — Medium, catches bigger trend changes
3. EMA 21/50 cross — Slow, major trend shifts only

### Price > EMA (price crossing above/below a single MA)
4. Price crosses EMA 9 — Very responsive
5. Price crosses EMA 21 — Medium trend filter
6. Price crosses EMA 50 — Slow trend filter, major support/resistance

## Prerequisites
Need to add `PRICE_CROSS_EMA` signal type to `src/replay/machine.ts` signal detection logic. Currently `enableEmaCrosses` exists in config but signal detection may need the price-cross variant.

## Hypothesis
EMA 9/21 cross is the standard short-term signal. Price > EMA 50 is a strong trend confirmation. Combining price > EMA with HMA crosses (from Session 7 winners) may produce the highest-quality entry signals.

## Hold Constant
All config values not listed in Variable above remain at DEFAULT_CONFIG defaults. RSI crosses remain enabled alongside EMA signals.

# Session 7: HMA Signals

## Goal
Find which HMA-based signals produce the most profitable trades: MA crossovers vs price crossing above/below a single HMA.

## Scope
`src/replay/config.ts` — modify `signals.enableHmaCrosses` and add new signal types. May also need to modify `src/replay/machine.ts` signal detection to support price > HMA signals.

## Scanner Prompt
`session07-hma-signals-2026-03-23-v1.0` — Scanner prioritizes HMA alignment and crosses over all other indicators. RSI and EMA are secondary. Evaluates HMA slope, alignment, and price-vs-HMA.

## Metric
Composite score (higher is better). Output from verify command.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20 --promptId=session07-hma-signals-2026-03-23-v1.0
```

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
7

## Constant (DO NOT CHANGE)
```typescript
scanners: { enabled: true, enableKimi: true, enableGlm: true, enableMinimax: true, enableHaiku: false, cycleIntervalSec: 30, minConfidenceToEscalate: 0.5, promptId: 'session07-hma-signals-2026-03-23-v1.0' }
escalation: { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false }
judge: { enabled: false }
rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }
signals: { enableRsiCrosses: true, enableEmaCrosses: false, optionRsiOversold: 30, optionRsiOverbought: 70 }
position: { stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 3, positionSizeMultiplier: 1.0 }
strikeSelector: { strikeSearchRange: 60 }
```

## Variable (ONE change per iteration)

### HMA Crossovers (two MAs crossing each other)
1. HMA 3/5 cross — Fast, noisy, early signal
2. HMA 5/19 cross — Medium speed
3. HMA 5/25 cross — Medium-slow
4. HMA 19/25 cross — Slow, fewer signals, potentially higher quality

### Price > HMA (price crossing above/below a single MA)
5. Price crosses HMA 5 — Fast, responsive to price action
6. Price crosses HMA 19 — Medium trend filter
7. Price crosses HMA 25 — Slow trend filter

## Prerequisites
Need to add `PRICE_CROSS_HMA` signal type to `src/replay/machine.ts` signal detection logic. Currently only supports MA-to-MA crosses.

## Hypothesis
Price > HMA signals are often stronger than two-MA crossovers because they directly measure price action vs trend. HMA 5/19 cross is likely the best crossover pair — fast enough to catch moves, slow enough to filter noise.

## Hold Constant
All config values not listed in Variable above remain at DEFAULT_CONFIG defaults. RSI crosses remain enabled alongside HMA signals.

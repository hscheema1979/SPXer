# Session 5: Option RSI Thresholds

## Goal
Find the optimal RSI cross thresholds for option contract signals (separate from SPX-level RSI).

## Scope
`src/replay/config.ts` — only modify `signals.optionRsiOversold` and `signals.optionRsiOverbought` in DEFAULT_CONFIG.

## Scanner Prompt
`session05-option-rsi-2026-03-23-v1.0` — Scanner evaluates per-contract RSI quality: volume context, divergence from SPX RSI, and whether thin-trade RSI signals are noise.

## Metric
Composite score (higher is better). Output from verify command.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20 --promptId=session05-option-rsi-2026-03-23-v1.0
```

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
3

## Constant (DO NOT CHANGE)
```typescript
scanners: { enabled: true, enableKimi: true, enableGlm: true, enableMinimax: true, enableHaiku: false, cycleIntervalSec: 30, minConfidenceToEscalate: 0.5, promptId: 'session05-option-rsi-2026-03-23-v1.0' }
escalation: { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false }
judge: { enabled: false }
rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }
signals: { enableRsiCrosses: true, enableHmaCrosses: true, enableEmaCrosses: false }
position: { stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 3, positionSizeMultiplier: 1.0 }
strikeSelector: { strikeSearchRange: 60 }
```

## Variable (ONE change per iteration)
1. `signals: { optionRsiOversold: 25, optionRsiOverbought: 75 }` — Tight: only extreme option RSI crosses
2. `signals: { optionRsiOversold: 30, optionRsiOverbought: 70 }` — Current default
3. `signals: { optionRsiOversold: 35, optionRsiOverbought: 65 }` — Loose: more signals from options

## Hypothesis
Option contract RSI is noisier than SPX RSI because options trade thinner. Tighter thresholds (25/75) filter out false signals from thin contracts. Looser (35/65) may catch more setups but with lower quality.

## Hold Constant
All config values not listed in Variable above remain at DEFAULT_CONFIG defaults.

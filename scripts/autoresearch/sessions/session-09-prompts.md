# Session 9: Regime Awareness / Prompt Framing

## Goal
Find the optimal prompt lens for scanner agents. How you frame the scanner's role and what you tell it to prioritize changes what it sees.

## Scope
`src/replay/config.ts` — switch `scanners.promptId` to test each prompt variant. Config parameters stay constant — ONLY the scanner prompt changes.

## Scanner Prompts (5 variants)
| Variant | Prompt ID | Focus |
|---------|-----------|-------|
| 1. Regime-guided | `session09-regime-aware-2026-03-23-v1.0` | Uses regime classification to filter signals |
| 2. Regime-blind | `session09-regime-blind-2026-03-23-v1.0` | Ignores regime, pure data analysis |
| 3. Trend-first | `session09-trend-first-2026-03-23-v1.0` | HMA/EMA alignment overrides RSI |
| 4. Reversal-first | `session09-reversal-first-2026-03-23-v1.0` | RSI extremes, pivots, V-reversals |
| 5. Risk-framed | `session09-risk-framed-2026-03-23-v1.0` | Only high-conviction setups, quality over quantity |

## Metric
Composite score (higher is better). Output from verify command. NOTE: This session requires scanner API calls.

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19,2026-03-20 --promptId=<VARIANT_ID>
```
(Smaller date set because scanner calls are expensive)

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
5 (one per prompt variant)

## Constant (DO NOT CHANGE)
```typescript
scanners: { enabled: true, enableKimi: true, enableGlm: true, enableMinimax: true, enableHaiku: false, cycleIntervalSec: 30, minConfidenceToEscalate: 0.5 }
escalation: { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false }
judge: { enabled: false }
rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }
signals: { enableRsiCrosses: true, enableHmaCrosses: true, enableEmaCrosses: false, optionRsiOversold: 30, optionRsiOverbought: 70 }
position: { stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 3, positionSizeMultiplier: 1.0 }
strikeSelector: { strikeSearchRange: 60 }
```

## Variable (ONE change per iteration)
Only `scanners.promptId` changes:
1. `promptId: 'session09-regime-aware-2026-03-23-v1.0'` — Regime-guided
2. `promptId: 'session09-regime-blind-2026-03-23-v1.0'` — Regime-blind
3. `promptId: 'session09-trend-first-2026-03-23-v1.0'` — Trend-first
4. `promptId: 'session09-reversal-first-2026-03-23-v1.0'` — Reversal-first
5. `promptId: 'session09-risk-framed-2026-03-23-v1.0'` — Risk-framed

## Hypothesis
Scanners given all indicator data but told to prioritize trend indicators (HMA/EMA) over RSI will produce better signals. Reversal-first may catch the big moves (3/19 emergency). Risk-framed may have the best win rate but miss opportunities. The neutral regime-blind baseline may actually be the best — don't bias the model, let it find patterns.

## Independence
This session is INDEPENDENT of sessions 1-8. It tests prompt framing, not config parameters.

## Hold Constant
All config parameters remain at DEFAULT_CONFIG defaults. Only the scanner prompt ID changes.

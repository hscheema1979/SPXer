# Session 10: Calendar/Macro Context

## Goal
Test whether feeding economic calendar and earnings data to scanners improves their signal quality.

## Scope
`src/replay/config.ts` — switch `scanners.promptId` to test each variant. Config parameters stay constant — ONLY the scanner prompt changes. Optionally add `prompts.extraContext` with calendar data for calendar-aware variants.

## Scanner Prompts (3 variants)
| Variant | Prompt ID | Focus |
|---------|-----------|-------|
| 1. Calendar-blind | `session10-calendar-blind-2026-03-23-v1.0` | No macro context, pure price action |
| 2. Calendar-aware | `session10-calendar-aware-2026-03-23-v1.0` | Economic events with timing + impact levels |
| 3. Calendar + earnings | `session10-calendar-earnings-2026-03-23-v1.0` | Events + mega-cap earnings context |

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
3

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
Only `scanners.promptId` changes (and `prompts.extraContext` for calendar-aware variants):
1. `promptId: 'session10-calendar-blind-2026-03-23-v1.0'` — No calendar
2. `promptId: 'session10-calendar-aware-2026-03-23-v1.0'` — Economic calendar injected via extraContext
3. `promptId: 'session10-calendar-earnings-2026-03-23-v1.0'` — Calendar + earnings injected via extraContext

## Calendar Data Needed (for 22 backtest days)
Build `src/data/economic-calendar.json`:
```json
{
  "2026-02-20": { "events": ["Initial Jobless Claims 8:30AM"], "impact": "medium" },
  "2026-03-07": { "events": ["NFP/Jobs Report 8:30AM"], "impact": "high" },
  "2026-03-12": { "events": ["CPI 8:30AM"], "impact": "high" },
  "2026-03-18": { "events": ["PPI 8:30AM"], "impact": "medium" },
  "2026-03-19": { "events": ["FOMC Rate Decision 2:00PM", "Powell Presser 2:30PM"], "impact": "critical" }
}
```

## Hypothesis
High-impact events (FOMC, CPI, NFP) create predictable volatility patterns. Telling the scanner "FOMC at 2PM" should make it avoid entries before the event and look for breakouts after. Calendar context should improve win rate on event days and have no effect on non-event days.

## Independence
This session is INDEPENDENT of sessions 1-8. It tests macro awareness, not config parameters.

## Hold Constant
All config parameters remain at DEFAULT_CONFIG defaults. Only the scanner prompt ID and extraContext change.

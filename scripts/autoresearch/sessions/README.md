# Autoresearch Sessions

Each session tests ONE dimension while holding all others constant.
All sessions run the FULL scanner pipeline (Kimi, GLM, MiniMax) — this is an agentic system.
No judges yet — we test scanner performance first, then layer judges on top.

Run each in its own tmux pane via the autoresearch skill.

## Sessions

| # | Dimension | Prompt ID | File |
|---|-----------|-----------|------|
| 1 | Time x OTM contract cost | session01-time-otm-2026-03-23-v1.0 | session-01-time-otm.md |
| 2 | RSI thresholds | session02-rsi-thresholds-2026-03-23-v1.0 | session-02-rsi.md |
| 3 | Stop loss | session03-stoploss-2026-03-23-v1.0 | session-03-stoploss.md |
| 4 | TP / exit strategy | session04-exit-strategy-2026-03-23-v1.0 | session-04-tp-exit.md |
| 5 | Option RSI | session05-option-rsi-2026-03-23-v1.0 | session-05-option-rsi.md |
| 6 | Cooldown | session06-cooldown-2026-03-23-v1.0 | session-06-cooldown.md |
| 7 | HMA signals | session07-hma-signals-2026-03-23-v1.0 | session-07-hma.md |
| 8 | EMA signals | session08-ema-signals-2026-03-23-v1.0 | session-08-ema.md |
| 9 | Regime awareness | session09-regime-* variants | session-09-prompts.md |
| 10 | Calendar/macro context | session10-calendar-* variants | session-10-calendar.md |

## All Sessions Use Scanners

Every session runs with `scanners.enabled: true`. Scanners (Kimi, GLM, MiniMax) evaluate
each bar's market state and flag setups. Each session has a TAILORED scanner prompt that
focuses the scanner's attention on the dimension being tested.

- Sessions 1-8: One scanner prompt per session, testing config parameter variations
- Session 9: 5 scanner prompt variants (regime-aware, regime-blind, trend-first, reversal-first, risk-framed)
- Session 10: 3 scanner prompt variants (calendar-aware, calendar-blind, calendar+earnings)

## Independence

All 10 sessions are INDEPENDENT. Sessions 9 and 10 do NOT depend on results from 1-8.
Run them all in parallel if you have the resources.

## Constant (across all sessions)

```typescript
scanners: {
  enabled: true,
  enableKimi: true,
  enableGlm: true,
  enableMinimax: true,
  enableHaiku: false,
  cycleIntervalSec: 30,
  minConfidenceToEscalate: 0.5,
}
escalation: {
  signalTriggersJudge: true,
  scannerTriggersJudge: true,
  requireScannerAgreement: false,
  requireSignalAgreement: false,
}
judge: { enabled: false }  // No judges — scanner evaluation only
```

## Variable (per session)

Each session modifies ONE config dimension + uses its own scanner prompt.
See individual session files for the exact variable and test values.

# Backtest Scorecard

> **Latest study**: [HMA Speed Study (2026-04-21)](HMA-SPEED-STUDY.md) — 32 configs, 267 days, 4 HMA speeds x 2 strikes x 2 TPs x 2 timeframes. OTM5 + 3x12 3m is #1.

---

## Legacy Scorecard (Feb-Mar 2026)

**Date range**: 2026-02-20 → 2026-03-20
**Days tested**: 21 (6 with trades)
**Friction model**: $0.05/side spread + $0.35/contract/side commission (always on)

| Metric | Raw | With Friction | Target | Pass |
|--------|-----|---------------|--------|------|
| Win rate | 42.9% | 42.9% | >40% | ✅ |
| Total P&L | $1,380 | $1,203 | >$0 | ✅ |
| Avg P&L/trading day | $230 | $201 | >$0 | ✅ |
| Avg P&L/all days | $66 | $57 | >$0 | ✅ |
| Worst day loss | -$444 | -$464 | >-$500 | ✅ |
| Total friction | - | $177 | - | - |
| Friction % of gross | - | 12.8% | - | - |

## Parameters
```json
{
  "trendThreshold": 0.15,
  "rsiOversoldTrigger": 25,
  "rsiOverboughtTrigger": 75,
  "rsiEmergencyOversold": 15,
  "rsiEmergencyOverbought": 85,
  "rsiMorningEmergencyOversold": 12,
  "rsiMorningEmergencyOverbought": 90,
  "priceMin": 0.2,
  "priceMax": 8,
  "idealPrice": 1.5,
  "emergencyIdealPrice": 1,
  "stopPct": 0.7,
  "tpMultiplier": 5,
  "maxRiskPerTrade": 300,
  "cooldownBars": 10,
  "morningEndMinute": 615,
  "gammaStartMinute": 840,
  "noTradeMinute": 930,
  "closeMinute": 945
}
```

## Per-Day Results

| Date | Trades | W/L | Raw P&L | Net P&L | Friction |
|------|--------|-----|---------|---------|----------|
| 2026-02-24 | 1 | 1/0 | $69 | $37 | $32 |
| 2026-03-03 | 1 | 0/1 | -$444 | -$464 | $20 |
| 2026-03-09 | 1 | 0/1 | -$300 | -$314 | $14 |
| 2026-03-11 | 1 | 1/0 | $231 | $199 | $32 |
| 2026-03-19 | 2 | 1/1 | $1,905 | $1,859 | $46 |
| 2026-03-20 | 1 | 0/1 | -$81 | -$113 | $32 |

## Per-Trade Detail

| Date | Side | Entry | Exit | Qty | Raw P&L | Eff Entry | Eff Exit | Net P&L | Drag |
|------|------|-------|------|-----|---------|-----------|----------|---------|------|
| 2026-02-24 | call | $0.68 | $0.91 | 3 | $69 | $0.73 | $0.86 | $37 | $32 |
| 2026-03-03 | put | $1.50 | $0.02 | 3 | -$444 | $1.55 | $0.01 | -$464 | $20 |
| 2026-03-09 | call | $1.00 | $0.00 | 3 | -$300 | $1.05 | $0.01 | -$314 | $14 |
| 2026-03-11 | put | $0.77 | $1.54 | 3 | $231 | $0.82 | $1.49 | $199 | $32 |
| 2026-03-19 | call | $1.50 | $8.85 | 3 | $2,205 | $1.55 | $8.80 | $2,173 | $32 |
| 2026-03-19 | put | $1.00 | $0.00 | 3 | -$300 | $1.05 | $0.01 | -$314 | $14 |
| 2026-03-20 | put | $0.92 | $0.65 | 3 | -$81 | $0.97 | $0.60 | -$113 | $32 |

## Notes

- **Friction is inherent** — baked into `src/core/friction.ts`, applied automatically to all replay/backtest P&L
- **$0.05/side spread** covers typical 0DTE SPXW bid-ask ($0.05–$0.15, we use conservative low end)
- **$0.35/contract commission** is Tradier standard rate
- **Drag per trade**: ~$14–$46 depending on qty and whether exit hits the $0.01 floor
- **Friction hurts small winners most**: the $69 win on 02-24 drops 46% to $37; the $2,205 win on 03-19 drops only 1.5%
- 15 of 21 days had no trades (regime/signal filters too restrictive) — friction is irrelevant on those days

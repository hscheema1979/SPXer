# Backtest Scorecard

**Date range**: 2026-03-19 → 2026-03-19
**Days tested**: 1

| Metric | Value | Target | Pass |
|--------|-------|--------|------|
| Win rate | 50.0% | >40% | ✅ |
| Avg P&L/day | $1905 | >$0 | ✅ |
| Max day loss | $0 | >-$500 | ✅ |
| Emergencies caught | 1/1 | >80% | ✅ |

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

| Date | Trades | W/L | P&L | WR | Emerg |
|------|--------|-----|-----|----|-------|
| 2026-03-19 | 2 | 1/1 | $1905 | 50% | 1/1 |

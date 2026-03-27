# Parameter Sweep Analysis — 2026-03-27

## KC-Enabled Sweep Results (sw4)

### Comparison: Original vs KC Filter

| Metric | Original (sw3) | KC (sw4) | Change |
|--------|----------------|----------|--------|
| Total Trades | 476,678 | 273,211 | **-42.7%** |
| Total PnL | $25.42M | $15.57M | -38.8% |
| PnL/Trade | $53.3 | $57.0 | **+6.8%** |
| Win Rate | 31.5% | 34.5% | **+3.0%** |

### Top 5 KC Configs

| Config | PnL ($K) | Trades | Win Rate |
|--------|----------|--------|----------|
| HMA 5×19, 3mD/3mE, SL 0%, TP 3x | 82.6 | 969 | 39.5% |
| HMA 5×19, 3mD/3mE, SL 80%, TP 3x | 82.4 | 968 | 39.4% |
| HMA 5×19, 3mD/5mE, SL 80%, TP 3x | 82.0 | 827 | 40.4% |
| HMA 5×19, 3mD/3mE, SL 0%, TP 8x | 81.8 | 1,001 | 39.1% |
| HMA 5×19, 3mD/3mE, SL 80%, TP 8x | 81.6 | 1,000 | 39.0% |

### KC Implementation Notes

- **Filter Logic**: KC slope < -threshold → block calls (downtrend); KC slope > +threshold → block puts (uptrend)
- **Threshold**: 0.3 (default)
- **Slope Computed On**: Direction timeframe bars (not 1m bars)
- **Parameters**: EMA 20, ATR 14, Multiplier 2.5, Slope lookback 5

---

## Original Sweep (sw3)

**Sweep Version:** 3
**Date Range:** 23 trading days (Feb-Mar 2026)
**Total Configurations:** 432
**Total Runs:** 35,076 (432 configs × ~81 date runs each)

---

## Executive Summary

The sweep tested 432 configurations across HMA periods (19-29), timeframe combinations (3m/5m), stop-loss levels (0%/40%/80%), and take-profit multipliers (3x/5x/8x).

**Key Finding:** HMA 5×19 with 3m direction/3m exit timeframe is the dominant configuration, significantly outperforming all other combinations. Stop-loss has minimal impact on total P&L (0% and 80% nearly identical).

---

## Top 10 Configurations by Total P&L

| Rank | Config | Total P&L | Trades | Avg Win Rate |
|------|--------|-----------|--------|--------------|
| 1 | HMA 5×19, 5mD/3mE, SL40%, TP8x | $120,871 | 1,507 | 37.8% |
| 2 | HMA 5×19, 3mD/5mE, SL80%, TP3x | $120,493 | 1,368 | 38.1% |
| 3 | HMA 5×19, 3mD/3mE, SL0%, TP5x | $120,196 | 1,522 | 38.2% |
| 4 | HMA 5×19, 3mD/3mE, SL80%, TP5x | $120,176 | 1,522 | 38.2% |
| 5 | HMA 5×19, 3mD/5mE, SL0%, TP3x | $120,115 | 1,369 | 38.1% |
| 6 | HMA 5×19, 3mD/3mE, SL0%, TP8x | $120,097 | 1,525 | 38.2% |
| 7 | HMA 5×19, 3mD/3mE, SL80%, TP8x | $120,077 | 1,525 | 38.2% |
| 8 | HMA 5×19, 5mD/3mE, SL0%, TP8x | $118,807 | 1,541 | 37.9% |
| 9 | HMA 5×19, 5mD/3mE, SL80%, TP8x | $118,684 | 1,541 | 37.9% |
| 10 | HMA 5×19, 3mD/3mE, SL0%, TP3x | $118,577 | 1,515 | 38.6% |

**Observation:** All top 10 use HMA 5×19 (fast=5, slow=19). This is the original baseline and outperforms all alternatives.

---

## Parameter Impact Analysis

### 1. HMA Slow Period (Strong Effect)

| Period | Avg P&L per Config | Ranking |
|--------|-------------------|---------|
| **19** | **$1,611** | 🥇 Best |
| 25 | $1,321 | 2nd |
| 21 | $1,319 | 3rd |
| 27 | $1,191 | 4th |
| 29 | $1,096 | 5th |
| 23 | $1,087 | 6th |

**Finding:** HMA 19 as the slow period is significantly better (+22% vs 25, +48% vs 29). Longer HMA periods (27-29) smooth too much and miss timing. Shorter periods (23) may be too noisy.

**Recommendation:** Keep `hmaCrossSlow: 19` as the default.

### 2. Timeframe Combination (Moderate Effect)

| Direction/Exit | Avg P&L | Ranking |
|----------------|---------|---------|
| **3mD / 3mE** | **$1,647** | 🥇 Best |
| 5mD / 3mE | $1,207 | 2nd |
| 3mD / 5mE | $1,131 | 3rd |
| 5mD / 5mE | $1,104 | 4th |

**Finding:** Using 3m bars for both direction and exit timing is best (+37% vs 5mD/5mE). The faster exit detection (3m vs 5m) captures reversals better. Symmetric 3m/3m is optimal.

**Recommendation:** Default to `directionTimeframe: '3m'`, `exitTimeframe: '3m'`.

### 3. Stop Loss (Minimal Effect)

| Stop Loss | Avg P&L | Difference |
|-----------|---------|------------|
| **0%** | **$1,347** | — |
| 80% | $1,341 | -0.4% |
| 40% | $1,129 | -16% |

**Finding:** Stop-loss has almost no impact when comparing 0% vs 80% — only $6 difference. The 40% stop-loss is worse, likely because it gets triggered on normal volatility before the signal reverses.

**Recommendation:** Use 80% stop-loss (contracts can recover from temporary dips) or 0% (rely purely on signal reversal). Avoid mid-range stops (40%).

### 4. Take Profit (Small Effect)

| Multiplier | Avg P&L | Ranking |
|------------|---------|---------|
| **3x** | **$1,391** | 🥇 Best |
| 5x | $1,233 | 2nd |
| 8x | $1,193 | 3rd |

**Finding:** Lower TP (3x) slightly outperforms higher TP (8x) because more trades hit the target. However, the absolute best single-day runs (3/9 spike) came from 8x TP capturing massive moves.

**Recommendation:** Use 5x as a balanced default. Consider 8x if expecting high-volatility days.

---

## Concerning Patterns & Overfitting Risks

### 1. March 9, 2026 Anomaly
The top single-day results ($30K+) all come from 2026-03-09, which had a massive afternoon spike:
- SPX rallied ~3% in the final 30 minutes
- OTM calls went 20x-40x
- All configs benefited, regardless of parameters

**Risk:** The sweep may be overweighting this single event. Removing 3/9 would significantly change rankings.

### 2. Win Rate is Low (~38%)
All top configs have win rates around 37-39%. This means:
- ~62% of trades are losers
- P&L is driven by a few big winners (convexity)
- Position sizing is critical

**Risk:** In live trading, consecutive losses could trigger psychological issues or risk limits before a big winner hits.

### 3. Counter-Trend Entries
The current system fires HMA crosses regardless of macro trend direction. On 3/27 (a -90pt down day), the system would have taken many call entries that got steamrolled.

**Mitigation:** The Keltner Channel trend filter (just implemented) should significantly reduce these counter-trend trades.

---

## Recommendations for Live Trading

### Immediate Actions
1. **Use HMA 5×19** as the baseline
2. **Use 3m bars** for both direction and exit detection
3. **Set stop-loss to 80%** (let contracts breathe)
4. **Set take-profit to 5x** (balanced)
5. **Enable Keltner Channel gate** with threshold 0.3

### Suggested Config
```typescript
{
  signals: {
    hmaCrossFast: 5,
    hmaCrossSlow: 19,
    directionTimeframe: '3m',
    exitTimeframe: '3m',
    enableKeltnerGate: true,
    kcSlopeThreshold: 0.3,
  },
  position: {
    stopLossPercent: 80,
    takeProfitMultiplier: 5,
  }
}
```

### Next Steps
1. **Re-run sweep with KC gate enabled** to measure filter impact
2. **Exclude 3/9 from analysis** to check robustness
3. **Add max consecutive loss limit** to risk guard
4. **Test on 3/27 specifically** to validate KC trend filter

---

## Files Modified for KC Filter

The Keltner Channel trend filter has been implemented:

| File | Changes |
|------|---------|
| `src/pipeline/indicators/tier1.ts` | Added `computeKeltnerChannel()`, `kcStep()`, `makeKCState()` |
| `src/types.ts` | Added `KCState` interface to `IndicatorState` |
| `src/core/indicator-engine.ts` | Added KC indicator computation (kcUpper, kcMiddle, kcLower, kcWidth, kcSlope) |
| `src/config/types.ts` | Added KC config fields to `Config.signals` |
| `src/config/defaults.ts` | Added KC defaults (disabled by default) |
| `src/replay/machine.ts` | Added KC trend gate after HMA cross filter |

---

## Summary

The sweep confirms HMA 5×19 with 3m bars is the best baseline configuration. Stop-loss has minimal impact. The key improvement opportunity is the **Keltner Channel trend filter**, which should eliminate counter-trend entries on strong trend days like 3/27.

**Next milestone:** Re-run sweep with KC gate enabled to quantify the improvement.

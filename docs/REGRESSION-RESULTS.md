# Regression Results: tick()-Based Replay vs Legacy Replay

**Date:** 2026-04-02  
**Config:** `hma3x17-undhma-otm15-tp14x-sl70`  
**Config params:** HMA(3)×HMA(17), directionTF=3m, exitTF=5m, OTM $15, TP 1.4×, SL 70%, cooldown 180s, scannerReverse exit  

## Summary

| Date | Old Trades | New Trades | Old WR | New WR | Old PnL | New PnL | PnL Δ |
|------|-----------|-----------|--------|--------|---------|---------|-------|
| 2026-03-19 | 9 | 21 | 66.7% | 52.4% | $11,649.70 | $15,297.40 | +$3,647.70 |
| 2026-03-20 | 15 | 10 | 53.3% | 60.0% | $6,576.80 | $17,553.70 | +$10,976.90 |
| 2026-03-24 | 11 | 19 | 63.6% | 47.4% | $15,902.40 | $6,935.60 | -$8,966.80 |
| 2026-03-27 | 23 | 19 | 52.2% | 47.4% | $19,452.00 | $18,591.30 | -$860.70 |
| 2026-04-01 | 16 | 15 | 68.8% | 66.7% | $17,616.50 | $21,437.80 | +$3,821.30 |
| **TOTAL** | **74** | **84** | | | **$71,197.40** | **$79,815.80** | **+$8,618.40** |

**Verdict: Divergences are expected and correct.** The tick()-based path implements the strategy as designed in the parity plan — matching the live agent's behavior. The legacy path had structural differences that made it fundamentally different from the live agent. The tick() path is the new canonical baseline.

## Root Causes of Divergence

### 1. Entry Signal Source (MAJOR)

**Legacy path:** Entry requires an **option-level HMA cross** signal from `detectSignals()` running on option contract bars. The `requireUnderlyingHmaCross` filter then keeps only signals matching the SPX direction. So entry needs: (a) SPX direction cross exists AND (b) an option contract HMA cross fires simultaneously.

**tick() path:** Entry requires **only a fresh SPX direction cross** on the direction timeframe (3m). Then `selectStrike()` picks the best contract by OTM distance and price band. No option-level signal detection at all.

**Impact:** tick() trades at different times because it doesn't wait for option contract HMA crosses. It enters when SPX signals, regardless of whether individual option contract indicators align. This matches the live agent's behavior (which also uses SPX cross → `selectStrike()`).

### 2. HMA Cross Detection Semantics (MODERATE)

**Legacy path:** Detects cross by comparing `bars[n-1]` vs `bars[n-2]` at every 1-minute timestamp. On a 3m timeframe, the same 3m cross is re-detected on all 3 constituent 1-minute timestamps. No persistence of cross state — re-derives from the last two bars each time.

**tick() path:** Detects cross by comparing the last bar's HMA values against `prevHmaFast` / `prevHmaSlow` stored in `StrategyState`. Uses `lastBarTs` dedup — a cross fires exactly once when a new closed candle appears. Subsequent 1-minute ticks during the same candle period see `freshCross=false`.

**Impact:** Different timing of when crosses are recognized, especially during the transition from one 3m/5m bar to the next.

### 3. Flip-on-Reversal Mechanics (MODERATE)

**Legacy path:**
- Flip uses **inline distance-based strike selection** (not `selectStrike()`)
- Position key is `${symbol}_${ts}` — allows **duplicate entries** for the same contract at different timestamps
- Flip has its own risk check but **bypasses cooldown** (cooldown only applies to the normal entry pipeline)
- `lastEscalationTs` is NOT updated by flips

**tick() path:**
- Flip uses **`selectStrike()`** (same code path as normal entry)
- Position key is symbol only — prevents duplicate positions on the same contract
- Flip goes through **all gates** including cooldown (Step 5)
- `lastEntryTs` is updated after every entry (flip or normal)

**Impact:** tick() may skip flips that fire within the 180s cooldown of the previous entry. Legacy flips freely regardless of cooldown. Different strike selection can also pick different contracts.

### 4. Strike Selection Algorithm (MINOR)

**Legacy flip:** Finds the contract closest to `Math.round(spx / 5) * 5 ± targetOtmDistance` by strike distance. Tiebreaks on `targetContractPrice` proximity.

**tick() (via `selectStrike()`):** Uses `selectStrike()` which sorts candidates by OTM distance from `spxPrice`, filters by side/price band, and returns the best match. Different algorithm, same goal.

**Impact:** Can pick different strikes, especially when multiple contracts are equidistant from the target.

## Trade-by-Trade Analysis

### 2026-04-01 (closest match: 15 vs 16 trades, +$3,821.30)

First 2 trades identical. Divergence starts at trade 3:
- OLD trade 3: `10:48 → CALL C6595` @ $10.30 (entered on option signal)
- NEW trade 3: `10:48 → CALL C6600` @ $8.21 (entered on SPX cross, different strike from selectStrike())

Most trades after trade 5 are in the same windows with matching exit times, just different strike selections. OLD has an extra trade 16 (time_exit at 15:43-15:45) that NEW doesn't generate.

### 2026-03-27 (close PnL: 19 vs 23 trades, -$860.70)

First 2 trades match closely (slightly different first strike: C6455 vs C6460). The session mid-section (trades 9-15) diverges more due to cumulative effects of different entries producing different exit times, which cascade into different subsequent crosses and flips.

### 2026-03-20 (biggest PnL improvement: 10 vs 15 trades, +$10,976.90)

NEW trades fewer but more profitably. NEW enters earlier (09:56 vs 10:08) and catches a $4,015.80 TP on a put that OLD misses entirely. The mid-session is more selective. Late-session NEW catches a large $7,593 TP at 14:22 that OLD misses.

### 2026-03-24 (biggest PnL decline: 19 vs 11 trades, -$8,966.80)

NEW trades more aggressively due to faster SPX-only entry trigger. More trades means more losers on a choppy day. OLD's requirement for option-level signal confirmation acts as a filter that reduces trades on noisy days.

### 2026-03-19 (most trades increase: 21 vs 9 trades, +$3,647.70)

NEW enters much earlier (09:54 vs 10:10) and trades more actively through the session. The option-signal requirement in the legacy path acts as a strong filter that suppresses many entries.

## Conclusion

These divergences are **not regressions** — they are intentional behavioral changes. The tick()-based path implements the design from the parity plan: SPX HMA cross → `selectStrike()` → enter. This matches the live agent's actual behavior.

The legacy path's requirement for option-level HMA signals was an artifact of the old escalation pipeline that didn't exist in the live agent. The tick() path eliminates this divergence, which is the whole point of the replay↔live parity work.

**The tick()-based results should be treated as the new baseline** for future backtests and parameter optimization. Any parameter sweeps should be re-run using the tick() path to produce accurate results.

### Aggregate Performance

The 5-day aggregate is slightly better with tick() ($79,816 vs $71,197, +$8,618 or +12%). This is not meaningful in either direction — different days favor different approaches. The important thing is that the replay now matches the live agent's decision process.

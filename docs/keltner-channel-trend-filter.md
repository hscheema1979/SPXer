# Keltner Channel Trend Filter — Design Spec

**Date:** 2026-03-27
**Status:** Planned — implement after sweep completes
**Priority:** High — addresses critical counter-trend entry problem

---

## Problem Statement

On strong trend days (e.g., 3/27: SPX dropped ~90pts from 6570→6475), HMA crosses on 3m bars repeatedly fire bullish long signals on every micro-bounce. Every one is a counter-trend trade that gets steamrolled.

**Current defenses are insufficient:**

1. **Regime classifier** — 20-bar linear regression slope on 1m bars (20min window). Slope flattens during bounces, briefly allowing bullish signals before the next leg down.
2. **`requireUnderlyingHmaCross`** — SPX HMA5/HMA19 cross fires on every bounce too (same micro-timeframe problem).
3. **RSI gate** — RSI stayed oversold all day. On trend days, "oversold" = "trend is strong," not "bounce incoming."

**Root cause:** No macro-trend awareness. All current filters operate on the same short timeframe as the entry signals.

## Proposed Solution: Keltner Channel Trend Filter

### Why Keltner Channels (not Bollinger Bands)

| Feature | Bollinger Bands (current) | Keltner Channels (proposed) |
|---------|--------------------------|----------------------------|
| Center line | SMA(20) | EMA(20) — more responsive |
| Band width | Standard deviation | ATR — captures true range including gaps |
| Volatility response | Backward-looking (σ of closes) | Forward-looking feel (ATR adapts to range expansion) |
| Band behavior in trends | Contract during grind → false squeeze signals | Widen proportionally to ATR → respects trend |

### Architecture: Two-Layer Trend Filter

#### Layer 1: Macro Trend Gate (KC midline slope)
```
KC_middle = EMA(close, 20)
KC_slope = (KC_middle[now] - KC_middle[N bars ago]) / N     // pts/bar rate of change

If KC_slope < -threshold → DOWNTREND → block calls, allow puts only
If KC_slope > +threshold → UPTREND   → block puts, allow calls only  
If |KC_slope| < threshold → RANGE    → allow both (current behavior)
```

**Key insight:** The KC midline slope operates on a *longer effective window* than HMA crosses. EMA(20) on 3m or 5m bars = 60-100 minutes of smoothed price action. The slope of that line is the macro trend direction that individual HMA5/HMA19 crosses can't see.

#### Layer 2: Entry Refinement (KC bands for position-within-trend)
```
KC_upper = EMA(20) + multiplier × ATR(14)
KC_lower = EMA(20) - multiplier × ATR(14)

In DOWNTREND: 
  - Enter puts when price bounces to KC upper/middle (selling the rip)
  - Avoid puts at KC lower (exhaustion point)
In UPTREND:
  - Enter calls when price pulls back to KC lower/middle (buying the dip)
  - Avoid calls at KC upper (exhaustion point)
In RANGE:
  - Mean-revert at band touches (existing behavior)
```

#### Layer 3: HMA for Execution Timing (existing, unchanged)
```
HMA crosses still fire for entry timing
BUT only when aligned with KC trend gate (Layer 1)
AND positioned well within KC bands (Layer 2)
```

**Signal flow:** KC trend gate → KC band position → HMA cross timing → Entry

### How It Works With MTF

The KC trend filter naturally slots into the existing MTF framework:

| Component | Timeframe | Purpose |
|-----------|-----------|---------|
| KC trend gate | `directionTimeframe` (3m or 5m) | Macro trend direction — gates call vs put |
| KC band position | `signalTimeframe` (1m or 3m) | Where in the channel — entry quality |
| HMA crosses | `signalTimeframe` | Precise entry timing (existing) |
| HMA exit crosses | `exitTimeframe` | Exit signal (existing) |

The `directionTimeframe` KC slope replaces or augments `requireUnderlyingHmaCross` as the primary entry gate.

### 3/27 Walk-through (what would have happened)

```
09:30 - SPX opens ~6565, KC midline from prior session is flat
09:45 - Big selloff begins, KC slope goes negative
10:00 - KC slope < -0.3 pts/bar → DOWNTREND gate activates
10:00-16:00 - ALL call entries blocked. Only put entries allowed.
        
Every HMA "Long +2.9" signal → BLOCKED by KC downtrend gate
Put entries on bounces to KC upper band → ALLOWED
```

**Expected improvement:** Eliminates ~15-20 losing counter-trend call entries on strong trend days.

## Implementation Plan

### 1. Add `computeKeltnerChannel()` to `src/pipeline/indicators/tier1.ts`

```typescript
export interface KeltnerChannel {
  upper: number;
  middle: number;  // EMA(period)
  lower: number;
  width: number;   // (upper - lower) / middle
  slope: number;   // rate of change of middle line (pts/bar)
}

export function computeKeltnerChannel(
  closes: number[],
  highs: number[],
  lows: number[],
  emaPeriod: number,    // default 20
  atrPeriod: number,    // default 14
  multiplier: number,   // default 2.5
  slopeLookback: number // default 5 — how many bars back for slope calc
): KeltnerChannel | null {
  // Middle = EMA of closes
  // Bands = middle ± multiplier × ATR
  // Slope = (middle_now - middle_N_ago) / N
}
```

### 2. Add KC to indicator engine output (`src/core/indicator-engine.ts`)

New fields in the indicators record:
```typescript
kcUpper: number | null;
kcMiddle: number | null;   // = EMA(20) 
kcLower: number | null;
kcWidth: number | null;     // normalized band width
kcSlope: number | null;     // pts/bar rate of change of middle line
```

**Note:** Requires tracking EMA(20) history for slope calculation. Add a small circular buffer (5-10 values) to IndicatorState.

### 3. Add config fields to `Config.signals`

```typescript
// In Config.signals:
enableKeltnerGate: boolean;           // master toggle
kcEmaPeriod: number;                  // default 20
kcAtrPeriod: number;                  // default 14  
kcMultiplier: number;                 // default 2.5
kcSlopeLookback: number;             // default 5 (bars)
kcSlopeThreshold: number;            // default 0.3 (pts/bar) — below this = range
kcBandEntryFilter: boolean;          // Layer 2: filter entries by position in channel
kcTimeframe: string | null;          // TF override for KC (null = directionTimeframe)
```

### 4. Add KC trend gate in replay machine (`src/replay/machine.ts`)

After the existing `requireUnderlyingHmaCross` filter, add:

```typescript
// ── Keltner Channel trend gate ───────────────────────────────────
if (config.signals.enableKeltnerGate && optionSignals.length > 0) {
  const kcBars = getSpxBarsAt(kcCache, ts);
  const kcSlope = kcBars[kcBars.length - 1]?.indicators?.kcSlope ?? null;
  
  if (kcSlope != null) {
    const threshold = config.signals.kcSlopeThreshold;
    if (kcSlope < -threshold) {
      // DOWNTREND: block calls
      optionSignals = optionSignals.filter(s => s.side !== 'call');
    } else if (kcSlope > threshold) {
      // UPTREND: block puts
      optionSignals = optionSignals.filter(s => s.side !== 'put');
    }
    // RANGE (|slope| < threshold): allow both — no filter
  }
}
```

### 5. Add to `ensureKcFields()` (analogous to `ensureHmaPeriods()`)

On-the-fly computation with DB caching, same pattern as HMA periods.

### 6. Add to sweep grid

New sweep dimensions:
- `kcEnabled: [true, false]`
- `kcSlopeThreshold: [0.2, 0.3, 0.5]`
- `kcMultiplier: [2.0, 2.5, 3.0]`

### 7. Backtest validation

Run 3/27 specifically to confirm:
```bash
npx tsx scripts/autosweep.ts --config=kc-test --dates=2026-03-27 --verbose
```

Then full 23-day suite to check it doesn't over-filter range days.

## Open Questions for Discussion

1. **KC vs pure EMA slope:** Should we just compute EMA(20) slope without the full channel? Simpler, but loses the band-position information for Layer 2.

2. **Interaction with regime classifier:** The regime classifier already has a `trendSlope` from linear regression. Should KC slope *replace* it, or be an additional gate? Recommend: KC gate is separate, regime classifier stays for time-of-day logic.

3. **EMA period:** 20 is standard for KC. But on 3m bars, EMA(20) = 60 minutes. On 5m bars, EMA(20) = 100 minutes. Do we want the same period across TFs, or adjust? Recommend: same period, let TF selection control the effective window.

4. **Multiplier tuning:** Standard KC uses 2.0 or 2.5. For 0DTE where moves are fast, 2.5-3.0 might be better to avoid false band touches. Sweep will tell.

5. **Should KC replace BB entirely?** BB is currently computed but barely used (only in scanner prompts). Could drop BB and replace with KC to reduce indicator clutter.

## Dependencies

- Sweep must complete first (currently running, ETA ~30min)
- Sweep results analysis to establish baseline for comparison
- Implementation: ~2-3 hours
- Validation: ~1 hour (23-day backtest)

## Files to Modify

| File | Change |
|------|--------|
| `src/pipeline/indicators/tier1.ts` | Add `computeKeltnerChannel()` |
| `src/core/indicator-engine.ts` | Add KC fields to output, track EMA history for slope |
| `src/types.ts` | Add KC fields to IndicatorState if needed |
| `src/config/types.ts` | Add KC config fields to `Config.signals` |
| `src/config/defaults.ts` | Add KC defaults |
| `src/replay/machine.ts` | Add KC trend gate logic |
| `src/core/signal-detector.ts` | Optional: add KC band position as signal quality filter |
| `scripts/autosweep.ts` | Add KC dimensions to sweep grid |
| `scripts/build-mtf-bars.ts` | Ensure KC indicators are computed for stored bars |

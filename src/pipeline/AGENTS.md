<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# pipeline — Data Processing Pipeline

## Purpose

Transform raw OHLCV data into enriched bars with indicators, handle contract lifecycle, aggregate to higher timeframes, and coordinate market data scheduling.

**Processing stages**:
1. **Bar Builder** — Raw OHLCV → Bar objects (with gap interpolation)
2. **Indicator Engine** — Attach technical indicators to bars (HMA, EMA, RSI, Bollinger, ATR, VWAP, MACD, ADX, etc.)
3. **Contract Tracker** — Sticky band model (UNSEEN → ACTIVE → STICKY → EXPIRED)
4. **Aggregator** — Build higher timeframes (5m, 15m, 1h, 1d) from 1m bars
5. **Scheduler** — Switch between data sources (ES overnight vs SPX RTH)

All computation is **incremental** (uses rolling window state), never recomputes from scratch.

## Key Files

| File | Description |
|------|-------------|
| `bar-builder.ts` | Convert OHLCVRaw to Bar objects, handle gap interpolation |
| `indicator-engine.ts` | Compute indicators incrementally from rolling window state |
| `contract-tracker.ts` | Track contract lifecycle with sticky band model |
| `aggregator.ts` | Build higher timeframes from 1m bars |
| `scheduler.ts` | Determine market mode, decide which data source to poll |
| `indicators/` | Indicator implementations (Tier 1 and Tier 2) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `indicators/` | Technical indicator implementations (HMA, EMA, RSI, MACD, ADX, etc.) — see `indicators/AGENTS.md` |

## Data Processing Flow

```
Raw OHLCV           Bar Builder           Gap Filler           Indicator Engine
(from providers)    (symbol + timeframe)  (interpolate/stale)  (HMA, EMA, RSI, etc.)
    │                    │                      │                    │
    ▼                    ▼                      ▼                    ▼
OHLCVRaw[]          Bar (no indicators)    Bar (synthetic flag)   Bar (all indicators)
                                                                       │
                                                                       ▼
                                                              Contract Tracker
                                                              (sticky band model)
                                                                       │
                                                                       ▼
                                                                   Storage
                                                              (upsertBar, upsertBars)
                                                                       │
                                                                       ▼
                                                                  Aggregator
                                                              (build 5m/15m/1h/1d)
```

## For AI Agents

### Working In This Directory

1. **Bar builder must preserve identity** — `symbol`, `timeframe`, `ts` define a unique bar. Don't reuse bar objects.
2. **Indicators are stateful** — Each symbol has `IndicatorState` with rolling windows, EMA memory, etc. Maintain state across calls.
3. **Gap interpolation flags bars** — Synthetic bars must be marked with `gapType: 'interpolated' | 'stale'` so consumers know. Stale bars freeze price (gap > 60 min).
4. **Contract state is persistent** — Once STICKY, contract stays tracked until EXPIRED. Don't drop from sticky band early.
5. **Aggregator reuses 1m bars** — Higher timeframes built from 1m bars in storage, not fetched directly.
6. **Scheduler is time-aware** — Respects market hours, holidays, early closes. Switches data sources based on time of day.

### Testing Requirements

- **Bar builder**: Gap interpolation edge cases (2 min gap, 60 min gap, 120 min gap)
- **Indicators**: Incremental computation matches batch computation (compute from scratch on full window)
- **Contract tracker**: State transitions (UNSEEN → ACTIVE → STICKY), band updates as SPX moves
- **Aggregator**: OHLC correct, volume summed
- **Scheduler**: Mode switches correctly at 6 PM and 9:30 AM ET

### Common Patterns

- **Immutability**: Use spread operators for bar objects, don't mutate in-place
- **Indicator state**: Separate `IndicatorState` per symbol, reset only on explicit signal
- **Error handling**: Invalid OHLC data (prices < 0, volume < 0) logged and skipped
- **Performance**: Incremental computation O(1) per bar (not O(n) on window)

## Bar Object Structure

```typescript
interface Bar {
  symbol: string;           // e.g., 'SPX', 'SPXW260318C05000000'
  timeframe: Timeframe;     // '1m' | '5m' | '15m' | '1h' | '1d'
  ts: number;               // Unix timestamp (seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic: boolean;       // true if interpolated/stale, false if real trade
  gapType: null | 'interpolated' | 'stale';  // null = no gap, 'interpolated' = gap ≤ 60 min, 'stale' = gap > 60 min
  indicators: Record<string, number | null>;  // Flat JSON: { 'hma_3m': 4550.2, 'rsi_14': 72.5, ... }
}
```

## Contract State Machine

```
       ┌─────────────┐
       │   UNSEEN    │  Contract detected, not yet in ±$100 band
       └──────┬──────┘
              │
              │ Enter ±$100 strike band
              ▼
       ┌─────────────┐
       │   ACTIVE    │  In band, being tracked
       └──────┬──────┘
              │
              │ Confirm sticky (not leaving band soon)
              ▼
       ┌─────────────┐
       │   STICKY    │  Permanent tracking until expiry
       └──────┬──────┘
              │
              │ Expiration date reached
              ▼
       ┌─────────────┐
       │  EXPIRED    │  Archived to parquet, removed from live tracking
       └─────────────┘
```

## Key Algorithms

### Gap Interpolation

For gaps between consecutive bars:
- **Gap ≤ 60 minutes**: Create synthetic bars with linearly interpolated prices
- **Gap > 60 minutes**: Create synthetic bars with stale prices (frozen at last trade price)
- **Purpose**: Ensure momentum indicators (HMA, EMA) work across gaps without false reversals

### Contract Sticky Band

1. Contract enters ACTIVE when first bar falls within ±$100 strike band around SPX
2. Once ACTIVE for N bars, transitions to STICKY
3. STICKY contracts never leave the tracking list — ensures we catch late reversals near expiry
4. Band auto-adjusts as SPX moves (if SPX moves up $50, band shifts up $50)

### Indicator Incremental Computation

Each indicator maintains rolling state:
- **HMA (Hull Moving Average)**: Rolling windows of closes, recomputed per new bar
- **EMA (Exponential Moving Average)**: Prior EMA value + alpha × (new close - prior EMA)
- **RSI (Relative Strength Index)**: Rolling gains/losses with smoothing
- **Bollinger Bands**: Rolling mean + std dev
- **VWAP**: Cumulative typical price × volume / cumulative volume
- **MACD**: Two EMAs (fast/slow) + signal line EMA
- **ADX**: True range + directional movement, smoothed

Never compute from scratch on full window — O(n) operations slow at scale. Use state-based O(1) updates.

## Dependencies

### Internal
- `src/types.ts` — Bar, Contract, Timeframe, IndicatorState
- `src/config.ts` — Configuration (gap threshold, max bars in memory, poll intervals)
- `indicators/` — Indicator calculation modules

### External
None (pure computational logic)

## Key Files by Purpose

### Bar Processing
- `bar-builder.ts` — OHLCVRaw → Bar, gap interpolation

### Indicator Computation
- `indicator-engine.ts` — Orchestrate indicator computation, manage per-symbol state
- `indicators/tier1.ts` — Core indicators: HMA, EMA, RSI, Bollinger Bands, ATR, VWAP
- `indicators/tier2.ts` — Extended indicators: EMA 50/200, SMA, Stochastic, CCI, Momentum, MACD, ADX

### Contract Management
- `contract-tracker.ts` — Sticky band model, state transitions, band updates

### Aggregation & Scheduling
- `aggregator.ts` — Build 5m/15m/1h/1d from 1m bars
- `scheduler.ts` — Market mode detection, data source switching

## Design Principles

1. **Incremental, not batch** — All indicators computed from rolling state (O(1) per bar)
2. **Immutable bars** — Never modify bar objects; create new ones with updates
3. **Sticky contracts** — Once tracked, never drop early (allows late reversals)
4. **Gap marking** — Synthetic bars explicitly flagged so consumers can handle gaps
5. **State separation** — Per-symbol state kept separate; no cross-symbol indicator pollution

<!-- MANUAL: Add pipeline-specific notes below -->

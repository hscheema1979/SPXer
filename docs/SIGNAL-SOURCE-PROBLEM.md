# Signal Source: Tick Pipeline vs Polling

**Date**: 2026-04-23
**Status**: Open — decision needed
**Impact**: Signal detection reliability for live trading

## Problem Statement

The live trading system's signal detection depends on a fragile tick-to-bar pipeline that has failed repeatedly during live market hours. Multiple sessions have been spent fixing cascading issues in the bar construction chain, each fix exposing another edge case. The core question: **should signal detection use bars built from live ticks, or polled historical bars from the broker API?**

## Current Architecture: Tick-Based Signal Detection

```
ThetaData WS ticks → PriceLine (last price per minute) → rawToBar() → bar-validator → upsertBar() → DB
                                                                                                    ↓
                                                                                      aggregateAndStore() (3m/5m)
                                                                                                    ↓
                                                                                      detectContractSignals() → WS broadcast
```

### What Went Wrong (2026-04-23)

1. **Bar validator rejects near-ATM option bars** — PriceLine builds bars where close comes from last trade but high/low come from quotes. For fast-moving near-ATM options, last trade regularly exceeds quoted high/low. Result: `REJECTED bar SPXW260423C07105000@1m: close(5.15) > high(3)`.

2. **Bar clamp fix** — Clamped close to [low, high] before storage. Fixed storage but altered prices, potentially masking real crosses.

3. **3m aggregation breaks** — 3m bars are aggregated from stored 1m bars. When 1m bars get rejected, the 3m bar is incomplete or missing. No 3m bar = no 3m signal. Observed: zero 3m signals stored after 19:48 UTC despite 1m signals firing continuously.

4. **Indicator state breaks on restart** — PriceLine is in-memory. After restart, indicator warmup requires reprocessing bars. If warmup doesn't complete before next bar close, signals are missed.

5. **Dedup complexity** — Tick stream fires multiple times within a bar period. Added `emittedSignals` dedup set (keyed on `symbol:pair:tf:bar.ts`) to prevent duplicate signal broadcasts. One more moving part.

6. **Catchup scan needed** — After restart, bars in DB have crosses that were never emitted. Added a catchup scan that reads last 3 DB bars per contract per higher TF. More complexity.

### Cumulative Cost

- 6+ distinct bugs fixed in the tick pipeline across sessions
- Each fix adds complexity (dedup sets, catchup scans, bar clamps)
- No session has completed a full trading day without a pipeline failure
- Developer time spent on bar construction instead of trading logic

## Proposed Architecture: Poll-Based Signal Detection

```
Every TF boundary (e.g. :00, :03, :06 for 3m):
  For each tracked contract:
    fetchOptionTimesales(symbol, '1m', last 50 bars)  ← Tradier REST API
    aggregateToHigherTFs(1m bars → 3m/5m/15m)
    computeIndicators(all TFs)
    detectSignals(enriched bars)
    Emit matches on WS → handler picks up
```

### How It Works

- **Timing**: Poll precisely at bar close boundaries for the configured `signalTimeframe`. A 3m config polls at :00, :03, :06, etc. A 5m config at :00, :05, :10. Not a fixed interval — tied to bar close.
- **Data source**: Tradier timesales API returns clean OHLCV bars that Tradier already aggregated. No validator issues. No bar construction.
- **Indicator computation**: Same incremental engine (`src/core/indicator-engine.ts`), seeded from polled bars.
- **Signal detection**: Same `detectSignals()` from `src/core/signal-detector.ts`. Identical to replay.
- **Parity**: Replay reads bars from DB (historical timesales). Live polls bars from Tradier (same timesales API). Same data, same logic, same results.

### What It Removes

- PriceLine bar construction for signal purposes
- Bar validator dependency for signal purposes
- 3m/5m aggregation from live 1m bars
- Dedup set for signal broadcasts
- Catchup scan on restart
- Indicator warmup from live ticks

### What It Keeps

- **ThetaData WS + PriceLine still run** — for real-time WS broadcasts, dashboard price display, and contract tracking. Just not for signal detection.
- **Backfill cycle still runs** — stores bars from Tradier timesales to DB for historical queries and replay.
- **Signal emission on WS** — same `contract_signal:{hmaPair}` channels. Handler doesn't change.

## Tradeoffs

| | Tick Pipeline | Poll-Based |
|---|---|---|
| Latency | ~1s after tick | ~2-5s after bar close (API round-trip) |
| Reliability | Fragile — bar validator, indicator state, restart gaps | Robust — clean bars from broker, matches replay |
| Complexity | High — dedup, catchup, warmup, clamp, validator | Low — fetch, aggregate, detect |
| Replay parity | Approximate — different bar construction | Exact — same data source, same logic |
| Edge cases | Many — OHLCV consistency, tick gaps, stale quotes | Few — API timeout, rate limit |
| Market impact | 0 (reads existing ticks) | ~50 API calls per poll cycle (batch endpoint) |

### Why Latency Doesn't Matter

We act on **bar close**, not on tick arrival. A 3m signal fires at the 3m bar boundary (:00, :03, :06). Whether we detect it 1s or 5s after that boundary is irrelevant — we're already waiting 180 seconds between opportunities. The handler won't act faster because the signal arrived 4 seconds sooner.

## Open Questions

1. **Polling interval**: Poll exactly at TF boundary, or add a small offset (e.g. +5s) to ensure the bar is fully formed in Tradier's API?
2. **Indicator state persistence**: If we poll every 3m, do we keep indicator state in memory between polls, or recompute from the 50-bar window each time? (Replay recomputes from the full bar window — simpler.)
3. **Contract list**: Poll all tracked contracts (~200+) or only those within strike selection range (~10-20)? The latter reduces API calls significantly.
4. **Fallback**: If Tradier API is down at a TF boundary, do we fall back to the tick pipeline for that cycle, or skip the bar entirely?

## Decision

**Not yet made.** Waiting for user confirmation to proceed with poll-based implementation.

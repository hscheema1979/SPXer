# Fill / Volume Gate Study & the `shorts-fresh` Exit Gate

**Status:** ✅ implemented — `SWEEP_EXIT_GATE=shorts-fresh` is the default in
`scripts/diag/iron-sweep.ts` and `scripts/diag/credit-spread-sweep.ts`.

## The problem: "false mid" exits

The credit-structure sweeps value a spread by carrying each leg's **last close**
forward until its next print: `V(t) = Σ sign_i × close_i(t)` (short legs sign
`+1`, long/wing legs sign `−1`). The exit logic fired a TP the first minute
`V ≤ (1−tpFrac)×credit`.

But a leg that hasn't traded for several minutes contributes a **stale** close.
When that stale close makes `V` look like it crossed the take-profit, the engine
booked a TP that was **not actually tradeable** — a "false mid." Symptoms:
- absurdly short average hold times (~3–5 min) that live bid/ask never reproduced,
- inflated win rate and net P&L.

Data facts (historical sweep cache): option bars carry **OHLC-mid + volume only**
(bid/ask 0% populated), and there are ~0% zero-volume bars — so "staleness" =
a leg has **no bar** at minute `t` (a gap), not a zero-volume bar. A leg is
**fresh** at trajectory ts `t` iff it has a bar with `ts === t`.

## The study (`scripts/diag/fill-volume-study.ts`)

Standalone diagnostic (writes only to `/tmp`, never touches production sweeps).
It re-evaluates the **same** entries/trajectories under many exit-fill gates over
20 evenly-spaced dates, for the live variants. Signal detection + structure
building are copied verbatim from the engines, so only the exit evaluation varies.

### Headline finding — it's the SHORT legs that go stale, not the wings

At baseline TP triggers (iron `IB±25 w10`):
- **wing/long-leg freshness ≈ 98–99.8%**, but **short (ATM) freshness ≈ 85–94%**.
- fresh-leg count at trigger: 4 legs ~67%, 3 legs ~32%, 2 legs ~1%.

So a false-mid TP is almost always a **stale short**, not a stale wing. This
inverts the original assumption and decides which gate is valid.

### Gate comparison (20-day study, iron `HMA 1m 3x12 | IB±25 w10 | TP10`)

| Approach | WR% | hold(min) | $Net (20d) | verdict |
|---|--:|--:|--:|---|
| baseline (no gate) | 92.8 | 35 | +58.6K | optimistic ceiling |
| "20% of combined volume" | ~92.8 | ~36 | +59.2K | **filters nothing** — wings dominate the sum |
| "2–3 of legs fresh" (k-of-n) | 92.8 | 35 | +58.7K | **too lax** — always-fresh wings satisfy it |
| all-legs-fresh | 82.5 | 56 | +42.0K | correct but over-strict (penalizes dead wings) |
| **shorts-fresh** ✅ | **85.5** | **50** | **+46.9K** | realistic *and* least-destructive |

The 2-leg `15ITM w10` spread is fill-robust (only ~6% of triggers have a stale
leg), so its edge barely moves under any gate.

**Conclusion:** "20% of combined volume" and "2–3 legs fresh" both collapse to
baseline because the chronically-stale leg is a single short while the wings
carry the volume/quorum. The honest middle ground between baseline (too
optimistic) and all-legs (too strict) is **`shorts-fresh`** — gate on exactly
the leg(s) you transact to realize the exit. It trims the iron edge ~20% and is
the correct replacement for the rejected "all-legs ≥X% volume" gate.

## The implementation: `shorts-fresh`

`buildTrajectory` / `buildSpreadTrajectory` flag each point with whether **every
short leg (sign `+1`) printed at exactly that minute** (`shortsFresh` /
`shortFresh`). `applyExit` honors a TP/SL only when that flag is true (or when
the gate is disabled).

```
SWEEP_EXIT_GATE = shorts-fresh   # default — honor TP/SL only when shorts are fresh
SWEEP_EXIT_GATE = none           # legacy optimistic behavior (no gate)
```

Rationale recap: you realize a credit-structure exit by **buying back the
shorts**; the long wings are protection that expires worthless, so their
illiquidity must not block or fake a fill. Gating on the shorts removes the
phantom TPs without penalizing the structure for dead wings.

## Reproduce

```bash
# the study (writes /tmp/fill-volume-study.{json,md})
npx tsx scripts/diag/fill-volume-study.ts

# full sweep with the gate (default shorts-fresh) — regenerates dashboard JSON
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine both --shards 8
# reproduce legacy optimistic numbers:
SWEEP_EXIT_GATE=none npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine both --shards 8
```

## Caveat / future work

This is a **volume/freshness** gate, not a true bid/ask model — historical bars
have no quotes (`spread` 0% populated). A real combo-fill model needs NBBO
backfill from ThetaData (the `spread` field exists end-to-end but was never
captured historically). `shorts-fresh` is the best available approximation until
quote data is captured going forward.

# Regime → Strategy Playbook

**Goal:** stop waiting for the one perfect day. Classify every day into a *regime*
("what happened / what's happening"), and have a measured, out-of-sample-validated
strategy for each regime — so we trade most days, the right way.

> **This strategy (SMC sweep+BOS) is just one entry in the library.** The playbook
> is the system; individual strategies are interchangeable cells.

## The 4 layers

1. **Regime measurement** — `scripts/diag/regime-classify.ts` (lib + tests).
   Per day computes gap%/bucket/dir, gap-fill, opening-range break, trendiness,
   day range, realized-vol percentile (prior-only), open-vs-20SMA trend. Assigns
   a **primary regime** + tags. Emits `regimes-{sym}.json` (consumed by this
   session AND the gap session). Gap thresholds (0.1/0.3/0.6/1.0%) match the gap
   study so gap cells map 1:1.

2. **Strategy library** — `playbook.json -> strategy_library`. The engines we've
   built: `smc-credit`, `iron`, `credit`, `theta-burner-study`, `or-fade-sweep`,
   `broken-wing-butterfly`, long-configs. Each tagged with the regimes it fits.

3. **The matrix** — `playbook.json -> matrix[symbol][regime]` = ranked strategies
   with train/test expectancy + status (`candidate` = in-sample only;
   `confirmed` = passed strict OOS; `rejected` = failed OOS).

4. **Nightly research cycle** — see below. Grinds the matrix toward full coverage.

## Regimes (primary labels)

`gap_go` (gap continues) · `gap_fade` (gap reverses/fills) · `gap_chop` ·
`trend` · `trend_vol` (volatile trend) · `chop` · `quiet_range` · `mixed`.

## Validation bar (STRICT out-of-sample — chosen by the user)

- Chronological **70/30 train/test split within each regime's days**.
- Metric = **expectancy ($/trade) NET of realistic fills** (SPX hs=0.40, NDX hs=0.65).
- **WR is NOT a pass criterion** — credit spreads are negative-skew; a high WR with
  a big un-sampled tail is the trap we keep catching. Judge expectancy + tail only.
- `status=confirmed` requires positive expectancy on BOTH train and test, test N≥10,
  and one max-loss survivable vs accumulated wins.

## Current state (2026-06-14)

First real finding (in-sample, pending OOS): **SMC OTM-put-hold is regime-split.**
Profitable in `chop` (+$197/trade), `gap_fade` (+$132), `mixed` (+$116),
`gap_chop` (+$80), `trend` (+$69), `quiet_range` (+$54). **Loses** in
`trend_vol` (−$164) and `gap_go` (−$174) — which together hold ~all its losses.
→ Those two regimes need a **directional/continuation** strategy instead.

## Nightly research cycle (the loop)

Each night, alternating SPX/NDX:

1. Read `playbook.json`. Pick the next target: an **uncovered** regime first
   (`uncovered[symbol]`), else the weakest `candidate` cell due for OOS confirmation.
2. From `regimes-{sym}.json`, gather that regime's dates. Chronological 70/30 split.
3. Form/choose a hypothesis: a `strategy_library` entry whose `fits` includes the
   regime (for `gap_go`/`trend_vol`, prioritize `directional_credit`/momentum).
4. Backtest on **train** dates (`SWEEP_ONLY_DATES`, realistic fills), pick the best
   variant by expectancy. Re-run that exact variant on **test** dates.
5. Apply the validation bar. Update `matrix` (promote/reject) and append a
   `theory_log` entry — **record disproven theories too**.
6. If a regime has no positive-expectancy strategy after its library is exhausted,
   log it as "stand aside" (don't force a trade).

**Coordination with the gap session:** gap cells (`gap_go`/`gap_fade`/`gap_chop`)
are co-owned. This cycle may seed them, but defer to the gap session's deeper,
significance-tested findings when they land; merge by taking the higher-OOS-expectancy
strategy per cell. Never purge the other session's dashboard rows.

## Operating notes

- Backtests run on date-subsets (one regime ≈ 20–70 days) → fast, serial is fine.
- Throttle behind live services; run off-hours.
- Expand the strategy library (new engines) in interactive sessions; the nightly
  cycle tests cells. Creative hypothesis generation = human/Claude sessions;
  mechanical OOS grinding = the cycle.

# Ticker & Backfill Management — Known Gaps (for a dedicated session)

> Status: **RESOLVED 2026-05-18.** All 3 blockers below are fixed and the
> backfill/sweep path is fully registry-driven. `sweep-manager onboard` now
> calls `discoverProfile()` (Polygon) to auto-fill the registry
> (class/strikeInterval/optionPrefix/underlyingPolygonTicker/band) for a
> genuinely new ticker — CLI flags `--class --strike-interval --option-prefix
> --underlying-ticker --band` override; heuristic fallback when offline.
> Regression coverage: `tests/diag/sweep-symbol.test.ts` +
> `tests/instruments/discovery.test.ts`. The original gap analysis is kept
> below for historical context.
>
> _Originally captured 2026-05-17 while removing ThetaData._

## Context

After the ThetaData removal (2026-05-17) **Polygon is the sole backfill
vendor** for both underlying and options, all profiles. `sweep-manager
backfill|onboard` already routes through the Polygon-only
`backfill-replay-options.ts`, so the **existing 4 profiles**
(`spx-0dte`, `ndx-0dte`, `spy-1dte`, `qqq-1dte`) work end-to-end.

What does **not** work yet: collecting underlying + options for a *genuinely
new* ticker (e.g. `IWM`, `TSLA`, `RUT`) via `sweep-manager onboard`. Three
hardcoded chokepoints block it. None are ThetaData-related — they predate the
removal.

## Blocker 1 — `backfill-replay-options.ts::resolveTarget()` is a 4-way switch

> ✅ RESOLVED: `resolveTarget()` keeps the 4 fast-path cases and on `default`
> resolves from `sweep-registry.json` (parses `{symbol}-{dte}dte`).

`scripts/backfill/backfill-replay-options.ts`

```ts
function resolveTarget(profileId): BackfillTarget {
  switch (profileId) {
    case 'ndx-0dte': ...
    case 'spy-1dte': ...
    case 'qqq-1dte': ...
    case 'spx-0dte': case undefined: ...
    default: throw new Error(`Unknown profile id: ${profileId} ...`);
  }
}
```

Any profile outside the four throws `Unknown profile id`. `sweep-manager
cmdBackfill()` shells out to this script with `--profile=<id>`, so onboarding
`iwm-1dte` dies here immediately.

**Fix direction:** keep the 4 fast-path cases (SPX must stay byte-identical,
incl. the `.brc` path and `protected` flag), but on `default` resolve the
target from `scripts/diag/sweep-registry.json` instead of throwing. Parse
`profileId` as `{symbol}-{dte}dte`.

## Blocker 2 — `getUnderlyingDay()` requires a pre-existing 0DTE parquet

> ✅ RESOLVED: when the 0DTE underlying parquet is absent, `getUnderlyingDay()`
> fetches the underlying 1m straight from Polygon (RTH-filtered, 429-aware) and
> writes it into the profile's own parquet.

`backfill-replay-options.ts::getUnderlyingDay()` reads the underlying series
(and derives the strike band) from `data/parquet/bars/{spx|spy|qqq|ndx}/
{date}.parquet`. A brand-new ticker has **no** such file, so a new ticker can
never get its underlying collected — and without the underlying close there is
no strike band, so options can't be enumerated either.

**Fix direction:** when the 0DTE underlying parquet is absent, fetch the
underlying 1m **directly from Polygon** (port `fetchPolygonUnderlying()` from
`scripts/backfill/eod-backfill.ts` — it already does exactly this, RTH-filtered,
429-aware), build the underlying `BarRow[]` + strike band in-process, and write
them into the profile's own parquet so the profile is self-contained. Requires
the Polygon underlying ticker (see Blocker 3 / registry schema).

## Blocker 3 — `sweep-symbol.ts::BASES` is hardcoded; registry lacks fields

> ✅ RESOLVED: `registrySymbolBase()` synthesizes a `SymbolBase` from the
> registry when a symbol isn't in `BASES`; the schema now carries
> `underlyingPolygonTicker` + `bandHalfWidthDollars` (defaults derived when
> absent, so the existing 4 entries needed no edit). `discoverAndRegister()`
> populates these from Polygon discovery on onboard.

`scripts/diag/sweep-symbol.ts`

```ts
const BASES = { SPX:..., SPY:..., QQQ:..., NDX:... };
// resolveSymbolTarget throws: `Unknown --symbol ... Use SPX | SPY | QQQ | NDX.`
```

`sweep-registry.json`'s own `_comment` admits the coupling: *"symbol must also
exist in sweep-symbol.ts BASES."* So even after Blockers 1–2, the sweeps
themselves can't resolve a new symbol.

`sweep-registry.json` schema today (per profile):
`{ symbol, dte, class, strikeInterval, optionPrefix, protected, note }`

**Missing fields needed to drive Polygon backfill for a new ticker:**

| Field | Why needed | Default heuristic |
|---|---|---|
| `underlyingPolygonTicker` | Polygon agg ticker; indices need `I:` prefix, ETFs/equities bare | `class==='index' ? 'I:'+symbol : symbol` |
| `bandHalfWidthDollars` | strike band = lastClose ± this; today hardcoded per profile in `resolveTarget()`/`eod-backfill.ts ROSTER` | by class/price (e.g. index wide, ETF ±$10) |
| `assetClass` | already partly covered by `class` (index\|etf) — reuse for the `I:` decision | — |

**Fix direction:** make `BASES` fall back to a registry-synthesized
`SymbolBase` when the symbol isn't hardcoded; extend the registry schema with
the fields above (backward-compatible: derive defaults when absent so the
existing 4 entries need no edit).

## Also fold in during that session

- `eod-backfill.ts` `ROSTER` is a separate hardcoded list of the same 4
  profiles (with `underlyingPolygonTicker`, `bandHalfWidthDollars`, `dte`).
  Once the registry carries those fields, `ROSTER` should be **derived from
  the registry** so there's a single source of truth for "what gets
  collected nightly" and "what can be onboarded."
- `sweep-manager cmdOnboard()` registers a new entry with only
  `{symbol, dte, strikeInterval, optionPrefix, protected, note}`. Extend it to
  capture/derive the new registry fields (consider `--underlying-ticker`,
  `--band`, `--class` flags with class-based defaults).
- Decide the onboarding UX: a brand-new ticker also has no 0DTE underlying
  parquet for *historical* days — backfill must fetch underlying per-day from
  Polygon for the whole `--days K` window, not just options.
- Holiday calendar: backfill is weekday-only (holidays just yield empty days
  and are skipped). Fine for now; note it if a proper trading calendar lands.

## Acceptance for the future session

`npx tsx scripts/diag/sweep-manager.ts onboard --symbol IWM --dte 1 --days 60`
should: register IWM-1dte in the registry → fetch IWM underlying 1m from
Polygon for 60 trading days → fetch the 1DTE option band from Polygon → write
`data/parquet/bars/iwm-1dte/{date}.parquet` (underlying + contracts) → verify →
execute the sweeps — with **zero** code edits to `BASES`/`resolveTarget`/
`ROSTER` (all registry-driven), Polygon-only.

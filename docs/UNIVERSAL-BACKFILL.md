# Universal Symbol Backfill & Replay — Design Doc

**Status**: Proposed, pending implementation
**Authors**: Claude + user
**Date**: 2026-04-20

## Problem

Today, backfilling data for a new symbol is a code-edit exercise:

1. A profile must be added to `src/instruments/` as a code literal.
2. Vendor routing (Polygon/ThetaData/Tradier) is switch-cased in `backfill-worker.ts`.
3. Post-processing (MTF aggregation + indicator computation) is SPX-hardcoded — `build-mtf-bars.ts` has `WHERE symbol='SPX'` in its trading-day query, and `backfill-worker.ts` has an early-return that skips MTF/indicator work for any non-SPX profile.
4. "Adding NDX" was done with a bespoke shell script (`run-ndx-batch.sh`) that wired only the raw-data fetch, producing 266 days of 1m bars with zero 3m/5m/10m/15m rows and zero denormalized indicator columns.
5. Nothing is surfaced in the UI. To backfill a symbol you SSH to the box and run scripts.

## Goal

From the replay viewer UI, a user types a ticker (e.g. `AAPL`), confirms a discovered profile, and the system handles the rest — raw data fetch, multi-timeframe aggregation, Tier 1 + Tier 2 indicators, all wired end-to-end. The orchestrator is fully symbol-agnostic; SPX stops being special.

## Non-goals

- **Live trading for new symbols.** This is backfill + replay only. Going live requires an execution account mapping, which is deliberately kept out of scope.
- **Vendor auto-onboarding.** We assume Polygon (underlying + options fallback) and ThetaData (SPX options primary). Adding a new vendor is still a code change.
- **Profile authoring for exotic instruments.** Futures, crypto, FX — out of scope. Equity, ETF, and US index profiles only.

## Principles

1. **Ticker is the only required input.** Everything else is auto-discovered with sensible overrides.
2. **Profiles are data, not code.** An `instrument_profiles` table holds profile records. Existing code profiles (SPX, NDX, SPY, QQQ) become seed data on first boot.
3. **The orchestrator is the single entry point.** CLI, daily cron, and UI all invoke the same function.
4. **No half-done states.** If a date is "complete" for a symbol, it has underlying 1m + option 1m + 2m/3m/5m/10m/15m aggregates + populated indicator columns. No more raw-only loads.
5. **Everything observable via `replay_jobs`.** Backfill jobs and replay jobs share one table with a `kind` discriminator.

## Data Model

### New table: `instrument_profiles`

```sql
CREATE TABLE instrument_profiles (
  id TEXT PRIMARY KEY,                     -- slug: 'spx', 'ndx', 'aapl'
  display_name TEXT NOT NULL,              -- 'SPX 0DTE', 'Apple Weekly'
  underlying_symbol TEXT NOT NULL,         -- DB symbol: 'SPX','NDX','AAPL'
  asset_class TEXT NOT NULL,               -- 'index' | 'equity' | 'etf'
  option_prefix TEXT NOT NULL,             -- 'SPXW','NDXP','AAPL'
  strike_divisor INTEGER NOT NULL,         -- always 1 (OCC format)
  strike_interval REAL NOT NULL,           -- 5, 25, 2.5, 1
  band_half_width_dollars REAL NOT NULL,   -- auto-computed
  avg_daily_range REAL,                    -- 30d avg H-L (informational)
  expiry_cadence_json TEXT NOT NULL,       -- ['0dte','daily','weekly']
  session_json TEXT NOT NULL,              -- {preMarket,rthStart,rthEnd,postMarket}
  vendor_routing_json TEXT NOT NULL,       -- {underlying:{vendor,ticker},options:{vendor}}
  tier INTEGER NOT NULL DEFAULT 1,         -- 1=basic, 2=index-grade (EMA50/200 etc)
  can_go_live INTEGER NOT NULL DEFAULT 0,
  execution_account_id TEXT,               -- broker account for live; NULL = backtest-only
  source TEXT NOT NULL,                    -- 'seed' | 'ui-discovered' | 'manual'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Load order: on boot, seed from code profiles if row absent. Runtime code reads from DB first, falls back to code profile if DB row missing (for graceful migration).

### Extend `replay_jobs`

```sql
ALTER TABLE replay_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'replay';
ALTER TABLE replay_jobs ADD COLUMN profile_id TEXT;
ALTER TABLE replay_jobs ADD COLUMN progress_json TEXT DEFAULT '{}';
```

`kind` ∈ `'replay' | 'backfill'`. Unifies job tracking.

### `replay_bars` schema

Unchanged — already symbol-agnostic. Denormalized indicator columns already exist from prior SPX work; we'll write them for every symbol.

## Symbol Discovery Service

**File**: `src/instruments/discovery.ts`

```ts
export interface DiscoveredProfile {
  id: string;                       // slug, lowercased ticker
  ticker: string;                   // user input
  displayName: string;
  assetClass: 'index' | 'equity' | 'etf';
  underlyingSymbol: string;
  optionPrefix: string;
  strikeDivisor: number;
  strikeInterval: number;
  bandHalfWidthDollars: number;
  avgDailyRange: number | null;
  expiryCadences: string[];
  vendorRouting: VendorRouting;
  tier: 1 | 2;
  warnings: string[];               // "No 0DTE available", "Strike interval inferred from 3 samples", etc.
}

export async function discoverProfile(ticker: string): Promise<DiscoveredProfile>;
```

### Discovery steps

1. **Classify asset** — `GET polygon.io/v3/reference/tickers/{ticker}`
   - `market='indices'` → `assetClass='index'`
   - `type='ETF'` / `type='ETV'` → `'etf'`
   - `type='CS'` / `'ADRC'` → `'equity'`
   - Unknown type → throw with a helpful error.

2. **Resolve underlying ticker**
   - Index: `I:${ticker}` for Polygon (e.g., `I:SPX`, `I:NDX`, `I:RUT`).
   - Equity/ETF: `${ticker}` as-is.

3. **Option prefix overrides** — a small hardcoded table for known cases:
   ```ts
   const OPTION_PREFIX_OVERRIDES: Record<string,string> = {
     SPX: 'SPXW',   // weekly/PM-settled root
     NDX: 'NDXP',
   };
   ```
   Default: `optionPrefix = ticker`.

4. **Strike interval detection** — `GET polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&limit=200`
   - Pull unique strike prices, sort, compute gcd of consecutive diffs.
   - Confidence check: if < 10 samples, add warning and fall back to heuristic (`index: 5`, `equity: round-to-$0.50`).

5. **Band half-width**
   - **Index**: fetch last 30 daily bars from Polygon. Compute `mean(high - low)`. Band = `round(mean × 1.5, nearest $5)`. Clamp to `[50, 200]`.
   - **Equity/ETF**: `$10` (user spec).

6. **Expiry cadence** — `GET polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date.gte=${today}&limit=50`
   - If any expiration == today → `'0dte'`
   - If consecutive daily expirations → `'daily'`
   - Else → `'weekly'` / `'monthly'` as appropriate.

7. **Tier** — indexes get tier 2 (full indicator battery). Everything else tier 1.

8. **Vendor routing**
   ```ts
   {
     underlying: { vendor: 'polygon', ticker: underlyingPolygonTicker },
     options: {
       vendor: assetClass === 'index' && ticker === 'SPX' ? 'thetadata' : 'polygon'
     }
   }
   ```

All discovery calls are cached per-ticker for 24h in memory to keep the UI snappy.

## Backfill Orchestrator

**File**: `scripts/backfill/orchestrate-backfill.ts`

```ts
export interface OrchestrateOptions {
  profileId: string;               // resolved profile
  dates?: string[];                // explicit dates
  fillGaps?: boolean;              // auto-discover missing
  lookbackDays?: number;           // default 30
  force?: boolean;                 // re-backfill even if complete
  onProgress?: (ev: ProgressEvent) => void;
}

export async function orchestrateBackfill(opts: OrchestrateOptions): Promise<OrchestrationResult>;
```

### Flow per date

1. **Discover missing** — `findMissingDates(db, profile, lookbackDays)` returns per-date `MissingReport`.
2. **Fetch underlying 1m** — vendor-routed via `profile.vendorRouting.underlying`.
3. **Fetch option 1m** — iterate strike band (`±profile.bandHalfWidthDollars` around daily-open underlying), per-expiry, per-side. Routed via `profile.vendorRouting.options`.
4. **Build MTFs** — call `buildMtfForSymbolDate(db, profile, date, ['2m','3m','5m','10m','15m'])` for the underlying AND for every option contract that got new 1m bars. Cross-day indicator state seeded from prior trading day.
5. **Populate denormalized indicator columns** — Tier 1 for all, Tier 2 for `profile.tier === 2`.
6. **Emit progress** — writes to `replay_jobs.progress_json` every 5 contracts.
7. **Verify** — re-run `findMissingDates`; mark date complete or partial.

### `findMissingDates` primitive

**File**: `src/backfill/missing-dates.ts`

```ts
export interface MissingReport {
  date: string;                   // 'YYYY-MM-DD'
  isTradingDay: boolean;
  missingUnderlying: boolean;
  expectedContracts: number;      // from profile.bandHalfWidthDollars / strikeInterval × 2
  presentContracts: number;
  missingTimeframes: Timeframe[];
  missingIndicators: { tf: Timeframe; columns: string[] }[];
}

export async function findMissingDates(
  db: Database,
  profile: InstrumentProfile,
  lookbackDays: number
): Promise<MissingReport[]>;
```

Trading-day calendar: union of SPX-known dates (SPX trades every US equity day), falling back to `MARKET_HOLIDAYS` in `src/config.ts`. Symbol-independent.

## Generalized MTF Builder

**Extract** `scripts/backfill/build-mtf-bars.ts` → `src/pipeline/mtf-builder.ts`:

```ts
export async function buildMtfForSymbolDate(
  db: Database,
  profile: InstrumentProfile,
  symbol: string,                  // underlying or option contract
  date: string,
  timeframes: Timeframe[],
  opts?: { priorDate?: string; skipIndicators?: boolean }
): Promise<BuildResult>;
```

Existing file becomes a thin CLI wrapper. Drop `WHERE symbol='SPX'` from trading-day query; use `profile.underlyingSymbol` everywhere.

Tier selection: `profile.tier` determines indicator set. Tier 2 adds EMA50/200, SMA20/50, MACD, Stoch, CCI, Momentum, ADX — all already implemented in `src/pipeline/indicators/tier2.ts`.

## Generalized Backfill Worker

**File**: `scripts/backfill/backfill-worker.ts`

Changes:
- Drop non-SPX early return at lines 475–489.
- After Phase 2 (options fetch), always run `buildMtfForSymbolDate` for underlying + every touched option contract.
- Replace `resolveTarget()` internal switch with profile lookup: `const profile = await loadProfile(spec.profileId)`.
- Vendor routing comes from `profile.vendorRouting`.
- Phase 3 (replay-all-configs) becomes opt-in and filters configs by `profileId` (requires a `profile_id` field on `replay_configs` — ALTER TABLE, default to `'spx'` for existing rows).

## Server API

Mounted under `/replay/api/` in `src/server/replay-routes.ts`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/symbols` | List all profiles + data-coverage summary |
| `GET` | `/api/symbols/discover?ticker=XYZ` | Preview discovered profile (no DB write) |
| `POST` | `/api/symbols` | Create profile from discovery (body: `DiscoveredProfile` + optional overrides + `backfill: bool`) |
| `GET` | `/api/symbols/:id` | Profile details + coverage breakdown |
| `PATCH` | `/api/symbols/:id` | Edit profile fields (manual overrides) |
| `DELETE` | `/api/symbols/:id` | Remove profile. Optional `?purgeData=true` deletes `replay_bars` rows. |
| `GET` | `/api/symbols/:id/missing-dates?lookback=30` | Per-date `MissingReport` |
| `POST` | `/api/symbols/:id/backfill` | Kick off backfill job. Body: `{ dates?, fillGaps?, lookbackDays?, force? }` |
| `GET` | `/api/jobs?kind=backfill&profileId=X` | Active jobs |
| `POST` | `/api/jobs/:id/cancel` | Cancel running job (SIGTERM the worker) |

Advisory locking: before spawning, check `replay_jobs WHERE kind='backfill' AND profile_id=? AND status='running'` — if any date overlaps, return 409.

## UI: Symbol Manager

**File**: `src/server/replay-viewer.html`

### Sidebar symbol selector
- Replaces hardcoded `<select id="instrument-select">` (lines 1077–1080).
- Populated from `GET /api/symbols`.
- Each option shows `displayName` + coverage badge: `(266 days, complete)` or `(266 days, 12 missing)` or `(backtest-only)`.
- Sentinel last option: `+ Add symbol…` opens add-symbol modal.

### Add-symbol modal
1. Text input: **"Enter ticker"** (e.g., `AAPL`).
2. User clicks "Discover" → `GET /api/symbols/discover?ticker=AAPL`.
3. Modal body populates with discovered fields, each editable:
   - Display name, underlying symbol, asset class (locked), option prefix, strike interval, band half-width, tier, expiry cadences, vendor routing.
   - Warnings shown inline (e.g., "Strike interval inferred from 6 samples — verify").
4. Actions:
   - **"Save profile only"** — POST `/api/symbols` with `backfill: false`.
   - **"Save and backfill last 30 days"** — POST `/api/symbols` with `backfill: true, lookbackDays: 30`.

### Per-symbol panel (replaces the single "Backfill" button)
Visible once a symbol is selected:
- **Coverage heatmap**: grid of last 90 trading days × [underlying, options, 1m, 3m, 5m, 15m, indicators]. Green = complete, yellow = partial, red = missing. Hover shows exact counts.
- **"Fill missing dates"** button — POST `/api/symbols/:id/backfill` with `fillGaps: true, lookbackDays: 90`.
- **"Backfill specific date range"** — date-range picker → POST with explicit dates.
- **"Re-backfill (force)"** — opens confirm modal, then POST with `force: true`.
- **Active jobs list** — polls `/api/jobs?profileId=:id` every 2s. Shows per-job progress: `NDX 2026-03-15 — mtf aggregation (142/260)` with cancel button.
- **Delete symbol** — button at bottom, confirm modal, optional "also purge data" checkbox.

## Implementation Phases

### Phase 1 — Data model + discovery (2 days)

**New files**:
- `src/instruments/profile-store.ts` — DB-backed repo: `loadProfile(id)`, `saveProfile(p)`, `listProfiles()`, `deleteProfile(id)`.
- `src/instruments/discovery.ts` — Polygon-backed discovery service.
- `src/instruments/backfill-routing.ts` — resolves vendor routing from profile.

**Modified**:
- `src/storage/db.ts` — add `instrument_profiles` table migration; seed from code profiles on first run.
- `src/instruments/registry.ts` — `listProfiles()`/`getProfile()` read from DB first, code fallback.

**Tests**:
- `tests/instruments/discovery.test.ts` — mock Polygon responses for SPX, NDX, AAPL, SPY; assert classification.
- `tests/instruments/profile-store.test.ts` — CRUD round-trip.
- `tests/instruments/backfill-routing.test.ts` — every profile resolves to valid vendor config.

### Phase 2 — Generic backfill orchestrator (2 days)

**New files**:
- `src/pipeline/mtf-builder.ts` — extracted reusable MTF logic.
- `src/backfill/missing-dates.ts` — `findMissingDates()` primitive.
- `scripts/backfill/orchestrate-backfill.ts` — CLI + library entry.
- `scripts/backfill/backfill-orchestrator-worker.ts` — detached job worker.

**Modified**:
- `scripts/backfill/backfill-worker.ts` — drop non-SPX early return; delegate to orchestrator.
- `scripts/backfill/build-mtf-bars.ts` — thin CLI wrapper over mtf-builder.
- `scripts/backfill/daily-backfill.ts` — loop over `listProfiles()`, call orchestrator.

**Tests**:
- `tests/backfill/missing-dates.test.ts` — fixture DB with known gaps; assert report.
- `tests/backfill/orchestrate.test.ts` — mocked vendors; full flow for SPX and AAPL.
- `tests/pipeline/mtf-builder.test.ts` — byte-identical output vs old `build-mtf-bars.ts` for SPX.

### Phase 3 — Server API (1 day)

**Modified**:
- `src/server/replay-routes.ts` — add 10 endpoints listed above.
- `src/server/replay-store.ts` (or equivalent) — extend `replay_jobs` schema; add locking check.

**Tests**:
- `tests/server/symbols-api.test.ts` — integration tests against throwaway DB.

### Phase 4 — UI (2 days)

**Modified**:
- `src/server/replay-viewer.html` — dynamic dropdown, add-symbol modal, per-symbol panel, coverage heatmap, job progress.

No new tests — manual E2E verification via viewer.

### Phase 5 — Migration + cleanup (0.5 day)

1. Seed existing code profiles (SPX, NDX, SPY, QQQ) into DB.
2. Run `npx tsx scripts/backfill/orchestrate-backfill.ts --profile=ndx --fill-gaps --lookback=400` to populate missing NDX MTFs + indicators.
3. Verify NDX reaches parity with SPX:
   ```sql
   SELECT timeframe, COUNT(*), COUNT(DISTINCT date(ts,'unixepoch'))
   FROM replay_bars WHERE symbol='NDX' GROUP BY timeframe;
   ```
   Should show all 6 timeframes with matching day counts.
4. Delete `scripts/backfill/run-ndx-batch.sh`, `backfill-spx.ts`, `backfill-spx-force.ts`, `backfill-spx-tradier.ts`, `backfill-spx-yahoo.ts`.
5. Update `scripts/backfill/README.md` — document orchestrator-first flow.
6. Update `docs/MULTI-TICKER-PLAN.md` — mark Phase 2 complete.

**Total**: ~7.5 days. Can parallelize Phase 3 + 4.

## Rollback Plan

- `instrument_profiles` table is additive; drop table + remove `kind`/`profile_id` columns to revert.
- Old scripts (`run-ndx-batch.sh`, etc.) stay in git history; revert is a single commit.
- Seed-from-code logic means code profiles remain the source of truth for SPX/NDX as long as DB rows aren't edited.

## Open Questions (for user)

All either have reasonable defaults or need a yes/no:

1. **Purge-on-delete default**: when deleting a symbol, keep data by default (safer) or purge (cleaner)? → **Proposed: keep, with explicit checkbox to purge.**
2. **UI-only profile authoring for exotic tickers**: if discovery fails (e.g., unknown ticker on Polygon), should the UI let you hand-author a profile? → **Proposed: no — show error, ask user to verify ticker. Manual editing happens via PATCH on existing profiles.**
3. **Date range default for new-symbol backfill**: 30 days, 90 days, or match SPX's full range (~266 days)? → **Proposed: 30 days on "Save + Backfill" quick action; full "Backfill specific dates" is manual.**
4. **Tier-2 denormalized columns**: currently tier-2 indicators live only in the JSON blob. Extend `replay_bars` with 7 more denorm columns for NDX/SPX parity? → **Proposed: yes — ALTER TABLE adds: `ema50, ema200, sma20, sma50, macd, macdSignal, adx14`.**
5. **Polygon rate-limiting**: for a full NDX migration (266 days × ~200 strikes) we're making ~100K option-agg requests. Add a global throttle (e.g., 5 req/s) to avoid 429s? → **Proposed: yes, with configurable env var.**

## Files Touched (complete)

**New** (7):
- `src/instruments/profile-store.ts`
- `src/instruments/discovery.ts`
- `src/instruments/backfill-routing.ts`
- `src/pipeline/mtf-builder.ts`
- `src/backfill/missing-dates.ts`
- `scripts/backfill/orchestrate-backfill.ts`
- `scripts/backfill/backfill-orchestrator-worker.ts`

**Modified** (8):
- `src/storage/db.ts`
- `src/instruments/registry.ts`
- `scripts/backfill/backfill-worker.ts`
- `scripts/backfill/build-mtf-bars.ts`
- `scripts/backfill/daily-backfill.ts`
- `src/server/replay-routes.ts`
- `src/server/replay-viewer.html`
- `scripts/backfill/README.md`

**Deleted** (5):
- `scripts/backfill/run-ndx-batch.sh`
- `scripts/backfill/backfill-spx.ts`
- `scripts/backfill/backfill-spx-force.ts`
- `scripts/backfill/backfill-spx-tradier.ts`
- `scripts/backfill/backfill-spx-yahoo.ts`

**Tests added** (7):
- `tests/instruments/discovery.test.ts`
- `tests/instruments/profile-store.test.ts`
- `tests/instruments/backfill-routing.test.ts`
- `tests/backfill/missing-dates.test.ts`
- `tests/backfill/orchestrate.test.ts`
- `tests/pipeline/mtf-builder.test.ts`
- `tests/server/symbols-api.test.ts`

## Acceptance Criteria

1. From a fresh clone, `npm run dev` + `npm run viewer`, user opens `/replay`, types `AAPL` in Add-symbol modal, clicks "Save and backfill", waits for job to complete, then replays a config against AAPL data with full MTFs and indicators. No code edits required.
2. `SELECT DISTINCT timeframe FROM replay_bars WHERE symbol='NDX'` returns all 6 timeframes after migration.
3. `npm run test` passes.
4. `run-ndx-batch.sh` no longer exists.
5. `daily-backfill.ts` successfully backfills every profile in the registry (not just SPX) on cron.

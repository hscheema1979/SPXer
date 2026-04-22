# Historical Backfill Scripts

Universal, symbol-agnostic backfill pipeline. Supports SPX, NDX, SPY, QQQ, and
any equity/ETF that has options listed on Polygon.

## Architecture

The recommended entry point is the **orchestrator** — either via the Backfill
management UI (`/replay/backfill`) or CLI. It detects coverage gaps (raw 1m,
MTFs, indicators) per symbol and fills them automatically.

```
UI / CLI
  └─ POST /api/backfill/orchestrate (replay-routes.ts)
       └─ backfill-orchestrator-worker.ts  (detached process)
            ├─ Phase A: spawn backfill-worker.ts per raw-missing date
            └─ Phase B: in-process buildMtfForSymbol() per MTF-missing date
```

Progress is tracked in the `replay_jobs` table (`kind='backfill'`) and polled
by the UI via `GET /api/jobs/:jobId`.

## Data sources

| Asset | Source | Why |
|-------|--------|-----|
| Index underlying (SPX, NDX) | Polygon `I:{ticker}` aggregates | Clean, firm close; pre/post coverage |
| Equity/ETF underlying | Polygon `{ticker}` stock aggregates | Standard source |
| SPX options (1m OHLCV) | ThetaData REST (`fetchOptionTimesales`) | OPRA tick-level; best for SPX |
| Other options (NDX, SPY, etc.) | Polygon options aggregates | Universal coverage |

The `replay_bars.source` column records origin: `'polygon'`, `'thetadata'`,
`'live'`, or `'aggregated'`. The replay engine reads all sources transparently.

## Quick start

```bash
# Via UI: navigate to /replay/backfill, select a profile, click "Start Backfill"

# Via CLI orchestrator (fill all gaps for a profile)
npx tsx scripts/backfill/orchestrate-backfill.ts --profile=ndx-0dte

# Single-date worker (low-level, usually spawned by orchestrator)
npx tsx scripts/backfill/backfill-worker.ts <job-spec.json>

# MTF-only rebuild for a profile
npx tsx scripts/backfill/build-mtf-bars.ts --profile=spx-0dte --recompute-1m

# Options-only backfill (ThetaData, SPX-specific)
npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20
```

## Scripts

### `backfill-orchestrator-worker.ts`

Detached worker spawned by `POST /api/backfill/orchestrate`. Reads a JSON spec:
```json
{ "jobId": "...", "profileId": "spx-0dte", "start": null, "end": null, "onlyMtf": false, "dbPath": "data/spxer.db" }
```

Orchestrates gap-fill in two phases:
- **Phase A** — for each raw-missing date, spawns `backfill-worker.ts` as child
- **Phase B** — for each MTF/indicator-missing date, runs `buildMtfForSymbol()` in-process

Supports cancellation via `replay_jobs.status='cancelled'` polling + SIGTERM.

### `backfill-worker.ts`

Single-date worker that fetches raw 1m bars from vendor(s) based on the
instrument profile. Steps:
1. Fetch underlying from Polygon
2. Compute strike band; fetch options from ThetaData (SPX) or Polygon (others)
3. Build MTFs + indicators for all symbols on that date
4. Optionally run replays against the new data

### `orchestrate-backfill.ts`

CLI wrapper over the orchestrator logic. Flags:
- `--profile=<id>` — instrument profile to fill
- `--start=YYYY-MM-DD`, `--end=YYYY-MM-DD` — date range
- `--only-mtf` — skip raw fetch, only build MTFs + indicators
- `--dry-run` — report gaps without filling

### `build-mtf-bars.ts`

Builds/rebuilds multi-timeframe bars (2m, 3m, 5m, 10m, 15m) + indicators.
Thin CLI over `src/pipeline/mtf-builder.ts`.

```bash
npx tsx scripts/backfill/build-mtf-bars.ts --profile=spx-0dte --tf=5m
npx tsx scripts/backfill/build-mtf-bars.ts --symbol=NDX --recompute-1m
```

### `daily-backfill.ts`

Runs nightly (via cron or PM2). Copies live `bars` → `replay_bars` for each
`canGoLive` profile. Falls back to Polygon/ThetaData if live data is missing.

### `backfill-replay-options.ts`

Standalone options-only backfill via ThetaData. Useful when underlying exists
but options need filling.

### `polygon-validate.ts`

Compare local bars against Polygon to detect data quality issues.

## Environment

Required in `.env`:
```
POLYGON_API_KEY=<key>       # Historical data (all tickers)
```

ThetaData requires the local `ThetaTerminal.jar` running on `127.0.0.1:25510`
(REST) and `127.0.0.1:25520` (WS). No API key in env — auth is terminal-side.
Only needed for SPX options backfill.

## Instrument Profiles

Profiles define how each ticker is discovered, backfilled, and traded:
- **Seeded on boot**: SPX, NDX, SPY (from `src/instruments/profiles/`)
- **UI-discovered**: added via `/replay/backfill` → "+ Add Symbol" → Polygon discovery

Profile fields: asset class, option prefix, strike interval, band half-width,
vendor routing, tier, expiry cadences.

## Coverage Detection

`src/backfill/missing-dates.ts` detects per-date gaps:
- `missingRaw` — no 1m bars at all
- `missingMtfs` — which aggregated timeframes are absent
- `missingIndicators` — which timeframes lack denormalized indicator columns

The heatmap in the UI renders these as red (missing) / yellow (partial) /
green (complete) cells.

## Contract symbol format

**Database / ThetaData symbol:** `SPXW260320C06575000`
- `SPXW` = SPX weekly (or `NDXP`, `SPY`, etc.)
- `260320` = expiry YYMMDD
- `C` = call (or `P` for put)
- `06575000` = strike x 1000, zero-padded to 8 digits

## Troubleshooting

### "No SPX data in replay_bars"

Underlying must be backfilled before options (strike band is derived from
the day's close). The orchestrator handles this ordering automatically.

### ThetaData returns 0 bars

Far-OTM strikes legitimately don't trade. If ALL contracts return empty:
1. `curl http://127.0.0.1:25510/v2/list/expirations?root=SPXW`
2. Verify subscription covers SPXW options
3. Confirm date is a trading day

### Polygon "NOT_AUTHORIZED"

1. Check `POLYGON_API_KEY` in `.env`
2. Verify plan includes index aggregates (`I:SPX`, `I:NDX`)

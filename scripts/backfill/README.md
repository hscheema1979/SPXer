# Polygon Backfill Scripts

This directory contains scripts for backfilling historical options data from Polygon API.

## Quick Start

### Full Replay Data Setup (Recommended)

```bash
# 1. Build SPX underlying data in replay_bars
npx tsx scripts/backfill/build-replay-bars.ts --spx-only 2026-02-20 2026-03-24

# 2. Fetch clean options data from Polygon to replay_bars
npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24
```

## Scripts

### `backfill-replay-options.ts` ⭐ (NEW - Recommended)

Fetches SPXW 0DTE option bars directly from Polygon API and writes to `replay_bars` table only.

**Features:**
- Clean, reliable data directly from Polygon
- Writes to `replay_bars` table only (never touches production `bars` table)
- Automatic strike range detection (±100 points from SPX close)
- 5-point strike intervals
- Both calls and puts
- No rate limiting issues (uses paid Polygon plan)

**Usage:**
```bash
npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20           # Single date
npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24  # Date range
```

**Output:**
- ~235K option bars per day (82 contracts × ~390 bars/day)
- ~550K total bars for 23 trading days
- All data marked with `source='polygon'` in replay_bars table

### `build-replay-bars.ts`

Builds the `replay_bars` table with SPX data from Polygon.

**Usage:**
```bash
npx tsx scripts/backfill/build-replay-bars.ts --spx-only 2026-02-20 2026-03-24  # SPX only (recommended)
```

**Deprecated:** The default mode (without `--spx-only`) copies unreliable options data from the live `bars` table. Use `backfill-replay-options.ts` instead.

### `backfill-polygon.ts` (Legacy)

Original backfill script that writes to the production `bars` table. **DO NOT USE** - it pollutes production data.

### `polygon-validate.ts`

Compare local bars against Polygon to detect data quality issues.

**Usage:**
```bash
npx tsx scripts/backfill/polygon-validate.ts compare 2026-03-20
npx tsx scripts/backfill/polygon-validate.ts compare 2026-02-20 2026-03-24  # Date range
npx tsx scripts/backfill/polygon-validate.ts overwrite 2026-03-20           # Fix mismatches
```

## Data Quality

### replay_bars Table (Sanitized ✅)

| Metric | Value |
|--------|-------|
| **Total Bars** | 546,354 |
| **SPX Bars** | 10,913 (Polygon) |
| **Option Bars** | 535,441 (Polygon) |
| **Unique Contracts** | 1,885 |
| **Trading Days** | 23 |
| **Date Range** | Feb 20 → Mar 24, 2026 |
| **Data Source** | Polygon API only |
| **Synthetic Bars** | 0 (all real market data) |

### bars Table (Production - Mixed Quality)

- Contains live collection data (unreliable for backtesting)
- Mixed sources (Tradier, Yahoo, live streaming)
- May have gaps, interpolation, and data quality issues
- **DO NOT USE** for replay/backtesting

## API Keys

Required in `.env`:
```
POLYGON_API_KEY=your_polygon_api_key_here
```

## Rate Limits

- **Paid Polygon plan:** No effective rate limit
- **Free/starter plan:** 5 requests/minute (requires 12s delays between requests)

## Troubleshooting

### "No SPX data in replay_bars"

Run `build-replay-bars.ts --spx-only` first to populate SPX data. `backfill-replay-options.ts` needs SPX data to determine strike ranges.

### "NOT_AUTHORIZED" errors

1. Check your `POLYGON_API_KEY` in `.env`
2. Verify your Polygon plan includes options data
3. Some far-OTM strikes may not have data on Polygon (normal - expect `_` symbols in output)

### Database size growing

The `replay_bars` table is separate from production. To reset:
```sql
DELETE FROM replay_bars WHERE source = 'polygon';
```

## Contract Symbol Format

**Polygon ticker:** `O:SPXW260320C06575000`
- `O:` prefix = option
- `SPXW` = SPX weekly
- `260320` = expiry (March 20, 2026)
- `C` = call (or `P` for put)
- `06575000` = strike (6575 × 1000)

**Database symbol:** `SPXW260320C06575000` (same format without `O:` prefix)

## Future Work

- [ ] Add Massive API as fallback for missing contracts
- [ ] Implement parallel fetching for faster backfills
- [ ] Add progress bar and ETA calculation
- [ ] Store metadata (fetch date, API version) in replay table

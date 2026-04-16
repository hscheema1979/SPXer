# Replay Data Source Configuration

The replay system supports configurable data sources for backtesting and historical analysis.

## Data Sources

### `replay_bars` (Default - Recommended)

Clean, sanitized data sourced directly from Polygon API.

**Pros:**
- ✅ Reliable, consistent data quality
- ✅ No gaps or interpolation
- ✅ All real market data (no synthetic bars)
- ✅ Proper timezone handling
- ✅ Recommended for backtesting and parameter optimization

**Cons:**
- ❌ Limited to historical backfilled dates
- ❌ Must run backfill script to add new dates

**Data Coverage:**
- 23 trading days (Feb 20 → Mar 24, 2026)
- 1,885 unique option contracts
- 535,441 option bars + 10,913 SPX bars

### `bars`

Live collection data from Tradier/Yahoo APIs.

**Pros:**
- ✅ Always current (live system)
- ✅ Contains real-time data for today's session
- ✅ Useful for paper trading forward-testing

**Cons:**
- ❌ May have data quality issues
- ❌ Potential gaps from API failures
- ❌ Mixed sources (Tradier, Yahoo)
- ❌ Not recommended for rigorous backtesting

## Configuration

Set the `REPLAY_DATA_SOURCE` environment variable in `.env`:

```bash
# Use sanitized Polygon data (recommended)
REPLAY_DATA_SOURCE=replay_bars

# Or use live collection data
REPLAY_DATA_SOURCE=bars
```

## Usage Examples

### Backtesting with Sanitized Data (Default)

```bash
# Already set to replay_bars by default
npm run backtest

# Or explicitly
REPLAY_DATA_SOURCE=replay_bars npm run backtest
```

### Paper Trading with Live Data

```bash
# Switch to live data source
REPLAY_DATA_SOURCE=bars npm run agent

# Run replay on today's live data
REPLAY_DATA_SOURCE=bars npm run replay
```

### Comparing Results

```bash
# Run with sanitized data
REPLAY_DATA_SOURCE=replay_bars npm run backtest > results-sanitized.log

# Run with live data
REPLAY_DATA_SOURCE=bars npm run backtest > results-live.log

# Compare
diff results-sanitized.log results-live.log
```

## Implementation

The data source is configurable via:

1. **Environment variable:** `REPLAY_DATA_SOURCE` in `.env`
2. **Default:** Falls back to `replay_bars` if not set
3. **Code locations:**
   - `src/replay/machine.ts` - Main replay engine
   - `src/replay/framework.ts` - Snapshot builder

All SQL queries use the configured table:
```typescript
const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';

const spxRows = db.prepare(`
  SELECT ts, open, high, low, close, volume, indicators
  FROM ${REPLAY_DATA_SOURCE} WHERE symbol='SPX' AND timeframe=?
  AND ts >= ? AND ts <= ? ORDER BY ts
`).all(timeframe, start, end);
```

## Adding New Data to replay_bars

To backfill additional dates with sanitized Polygon data:

```bash
# 1. Fetch SPX from Polygon
npx tsx scripts/backfill/build-replay-bars.ts --spx-only 2026-03-25 2026-03-27

# 2. Fetch options from Polygon
npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-25 2026-03-27

# 3. Run replay on new dates
npm run replay -- 2026-03-25
```

See `scripts/backfill/README.md` for complete documentation.

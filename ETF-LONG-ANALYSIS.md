# ETF Long-Only Analysis (Swing Trading)

This documents the ETF long-only swing study — multi-day share trading with moving average signals on leveraged ETF pairs.

## What is This?

The system backtests swing trading strategies on leveraged ETF shares (not options):
- **SOXL** (3× leveraged semiconductor index)
- **TQQQ** (3× leveraged Nasdaq-100)
- **TNA** (3× leveraged small-cap Russell 2000)
- **UPRO**, **SDSQ**, **UDOW**, **SDOW**, etc.

Each ticker runs ~6,336 HMA/EMA parameter combinations across 252 trading days (1 year), measuring:
- **Daily P&L** (continuous swing series, not per-day-only)
- **Hourly P&L** (aggregated by hour)
- **Win rate**, **profit factor**, **Sharpe**, **max drawdown**, **profit ratio**

## Running Sweeps

### Single Ticker (serial, ~10 min)
```bash
npx tsx scripts/diag/etf-long-sweep.ts --symbol SOXL
# Output: etf-long-sweep-soxl.json, etf-long-daily-soxl.json, etf-long-hourly-soxl.json
```

### Multiple Tickers (4 workers, parallelized)
```bash
# All discovered ETF dirs
npx tsx scripts/diag/etf-long-sweep-parallel.ts

# Specific tickers
npx tsx scripts/diag/etf-long-sweep-parallel.ts --tickers=SOXL,TQQQ,TNA

# Custom worker count (default 4, max 6)
npx tsx scripts/diag/etf-long-sweep-parallel.ts --workers=6
```

### Distributed (Across Tailscale Peers)
```bash
# Template only (requires homogeneous repos on all VPS):
npx tsx scripts/diag/etf-long-sweep-distributed.ts --tickers=SOXL,TQQQ,SQQQ,SOXS

# Check available hosts
tailscale status | grep -E "vps[0-9]"
```

## Analysis Endpoints (Backtest Studio :3700)

### Configuration Metadata
- **GET /api/etf-profiles** — Available tickers (auto-discovered from sweep outputs)
- **GET /api/etf-long-sweep?profile=-{ticker}** — All configs for a ticker (flatten first 50 by ratio)

### Single Ticker Best Config
- **GET /api/etf-long-all?by=ratio&minN=20** — Best-config summary per ticker (one row per ETF)
  - `?by=ratio|pnlPct|sharpe|wr|profitFactor` (default: ratio = pnl/maxDD)
  - `?minN=20` (filters to configs with ≥20 trades)

### Daily/Hourly Heatmaps
```bash
# Heatmap data for charting: 252 dates × N configs
curl "http://localhost:3700/api/etf-long-daily?profile=-tqqq&keys=best" | jq .

# Response schema:
# {
#   "dates": ["2025-05-09", "2025-05-12", ...],
#   "series": {
#     "best": [89.04, -15.2, 32.1, ...],           # P&L per date
#     "hma-1h-20x25": [45.3, -8.2, 21.0, ...]     # Optional keyed configs
#   }
# }
```

Hourly version:
```bash
curl "http://localhost:3700/api/etf-long-hourly?profile=-tqqq&keys=best" | jq .

# Response:
# { "hours": ["09:30", "10:30", ...], "series": {...} }
```

### Inverse Pair Analysis
```bash
# Combined long+short pair study (hedge quality)
curl "http://localhost:3700/api/etf-pairs?pair=SOXL-SOXS" | jq .

# Usage: Compare hedge effectiveness
# SOXL long + SOXS short = net neutrality + cost-of-carry study
```

## Output Files

All outputs live in `scripts/autoresearch/output/`:

- **etf-long-sweep-{TICKER}.json** — 6,336 config rows × 252 days analysis
  - Row: `{ ticker, signal, period, tp, sl, n, wr, pnlPct, pnl, dd, sharpe, ratio, profitFactor, ...}`
  - ~18 MB per ticker

- **etf-long-daily-{TICKER}.json** — Heatmap for daily view
  - Schema: `{ dates: [...], series: { "HMA-1h-20x25": [...], ... } }`
  - ~1.2 MB per ticker

- **etf-long-hourly-{TICKER}.json** — Heatmap for hourly view
  - Schema: `{ hours: [...], series: { ... } }`
  - ~50 KB per ticker

- **etf-long-pairs-{T1}-{T2}.json** — Pair combination study
  - Schema: `{ pair: "SOXL-SOXS", best: {...}, combinations: [...] }`
  - Lists top 10 best combined-config strategies

## Key Findings (High-Volume Tickers)

| Ticker | Count | Best Config | P&L | WR | Trades | DD | Sharpe |
|--------|-------|-------------|-----|----|---------|----|--------|
| **SOXL** | 6,336 | EMA 5m 15×50 | +551.9% | 35.0% | 186 | 23.4% | 2.31 |
| **TQQQ** | 6,336 | HMA 4h 20×30 | +110.3% | 66.7% | 18 | 8.1% | 4.12 |
| **TNA** | 6,336 | HMA 1h 20×25 | +89.0% | 51.9% | 77 | 18.6% | 2.18 |

### Observations
- **SOXL**: Extreme volatility (551% on 35% WR) = swing-heavy, needs position sizing
- **TQQQ**: Quality win rate (67%) on modest sample (18) = reliable but low frequency
- **TNA**: Balanced profile (52% WR, 89% P&L) = steady performer

### Strategy Types
- **EMA-heavy** (SOXL) → Momentum-following, high variance
- **HMA-based** (TQQQ, TNA) → Mean-reversion, stable
- **Multi-frame** (3m+5m+1h) → Better signal reliability

## Aggregation Logic

For each variant (signal, period, tp, sl):

1. **Daily tracking**: On each exit, record exit-date and P&L to running map
   - `daily[exitDate] += exitPnl` (continuous, not per-calendar-day)
2. **Hourly tracking**: On each exit, record exit-hour
   - `hourly[exitHour] += exitPnl`
3. **Aggregate**: Sum trades per date/hour → produce heatmap series

**Key**: Exits are recorded on exit-date, not entry-date. A 5-day hold entered Monday, exited Friday records P&L to Friday's row.

## Next Steps

1. **Pairs analysis** — Run `etf-long-pairs-study.ts` on all inverse pairs:
   ```bash
   npx tsx scripts/diag/etf-long-pairs-study.ts --pair SOXL,SOXS --minTrades 50 --top 10
   ```

2. **Studio dashboard** — Create UI in Next.js studio for:
   - Ticker leaderboard (sortable by ratio/pnl/wr)
   - Daily heatmap (calendar view, color-coded by P&L)
   - Hourly profile (time-of-day analysis)
   - Pair hedging comparison

3. **Live config export** — Convert top N configs to OptionX format for paper trading

## Troubleshooting

### Sweep hung or slow
- Check log: `tail -f etf-sweep-full-74.log`
- Kill workers: `pkill -f "etf-long-sweep"`
- Reduce workers: `npx tsx scripts/diag/etf-long-sweep-parallel.ts --workers=2`

### Backtest-server endpoints return empty
- Ensure outputs exist: `ls -lh scripts/autoresearch/output/etf-long-sweep-*.json`
- Restart server: `pkill -f "backtest-server" && nohup npx tsx scripts/autoresearch/backtest-server.ts &`

### Parquet files missing for a ticker
- Check: `ls -la data/parquet/bars/soxl/` (should have 252 *.parquet files)
- If missing, fetch via backfill: `npm run backfill -- --symbol SOXL`

# Post-ETF-Sweep Checklist

**When**: After 74-ticker sweep completes (~8-9 AM 2026-05-24)  
**Status**: Follow in sequence, each step is independent

---

## Phase 1: Verify Completion ✓ (2 min)

```bash
# Check all 74 are complete
ls -1 scripts/autoresearch/output/etf-long-sweep-*.json | wc -l
# Should output: 74

# Verify heatmap files
ls -1 scripts/autoresearch/output/etf-long-daily-*.json | wc -l
ls -1 scripts/autoresearch/output/etf-long-hourly-*.json | wc -l
# Both should be 74

# Check total disk usage
du -sh scripts/autoresearch/output/
# Expected: ~1.3 GB sweep data + 89 MB daily + 3.7 MB hourly = ~1.4 GB
```

---

## Phase 2: Test Endpoints (3 min)

```bash
# Verify backtest-server is running
curl -s http://localhost:3700/api/etf-profiles | jq . | head -20
# Should list 74 tickers

# Leaderboard (best config per ticker by ratio)
curl -s "http://localhost:3700/api/etf-long-all?by=ratio" | jq '.[] | {symbol, pnlPct, ratio, wr}' | head -30

# Daily heatmap for TQQQ (example)
curl -s "http://localhost:3700/api/etf-long-daily?profile=-tqqq" | jq '.dates | length'
# Should output: 252

# Hourly profile for SOXL
curl -s "http://localhost:3700/api/etf-long-hourly?profile=-soxl" | jq '.hours | length'
# Should output: 24
```

---

## Phase 3: Run Inverse-Pairs Analysis (20 min)

**Option A: Automated (Recommended)**
```bash
bash scripts/diag/etf-long-pairs-batch.sh
# Runs: SOXL/SOXS, TQQQ/SQQQ, TNA/TZA, UPRO/DPST, URTY/SRTY, NUGT/DUST, UGL/GLL
# Output: etf-long-pairs-*.json files

# With higher confidence (≥50 trades per config)
bash scripts/diag/etf-long-pairs-batch.sh --minTrades 50 --top 5
```

**Option B: Custom Pairs**
```bash
# Single pair analysis with detailed output
npx tsx scripts/diag/etf-long-pairs-study.ts --pair SOXL,SOXS --minTrades 20 --top 10

# Check specific pairs
npx tsx scripts/diag/etf-long-pairs-study.ts --pair TQQQ,SQQQ
npx tsx scripts/diag/etf-long-pairs-study.ts --pair UPRO,DPST
```

---

## Phase 4: Query & Analyze Results (10 min)

### Leaderboard (Best config per ticker)
```bash
# By P&L ratio (risk-adjusted)
curl -s "http://localhost:3700/api/etf-long-all?by=ratio" | jq '.[] | select(.pnlPct > 0) | {symbol, pnlPct, ratio, wr, trades: .n}'

# By win rate (quality of signals)
curl -s "http://localhost:3700/api/etf-long-all?by=wr" | jq '.[] | {symbol, wr, trades: .n}'

# By raw P&L %
curl -s "http://localhost:3700/api/etf-long-all?by=pnlPct" | jq '.[] | {symbol, pnlPct, dd, sharpe}'
```

### Heatmap Data (For charting)
```bash
# Get daily series for SOXL (all configs)
curl -s "http://localhost:3700/api/etf-long-daily?profile=-soxl" | jq '.series | keys'

# Top 3 configs for TQQQ
curl -s "http://localhost:3700/api/etf-long-daily?profile=-tqqq&keys=best%0AHMA-1h-20x25%0AEMA-4h-15x50" | jq '.series | keys'

# Hourly breakdown for TNA (time-of-day analysis)
curl -s "http://localhost:3700/api/etf-long-hourly?profile=-tna" | jq '.hours'
```

### Pairs Analysis
```bash
# SOXL/SOXS hedge quality
curl -s "http://localhost:3700/api/etf-pairs?pair=SOXL-SOXS" | jq '.analysis[0] | {longConfig, shortConfig, combinedPnl: .combined_P_L, hedgeQuality}'

# TQQQ/SQQQ best combination
curl -s "http://localhost:3700/api/etf-pairs?pair=TQQQ-SQQQ" | jq '.analysis[0]'

# All available pairs
ls -1 scripts/autoresearch/output/etf-long-pairs-*.json | xargs -I {} basename {} .json | sed 's/etf-long-pairs-//'
```

---

## Phase 5: Optional Enhancements (Tomorrow)

### Dashboard Integration (Next.js)
Create `components/ETFLongDashboard.tsx` in `spxer-studio` (:3800):
- Leaderboard table (sortable by ratio, pnl, wr)
- Daily heatmap (calendar view, color-coded P&L)
- Hourly profile (bar chart: time-of-day performance)
- Pairs comparison (hedge quality metrics)

### Export to OptionX (Paper Trading)
```bash
# Convert top-10 configs to OptionX format
curl -s "http://localhost:3700/api/etf-long-all?by=ratio" | jq '.[] | select(.ratio > 0.5)' | \
  # Convert each row to OptionX Config JSON
  # Place in ~/optionx/configs/{id}.json
  # Start with pm2
```

### Systematic Backtesting
- Test live-trading limits: max positions, cooldown, daily loss cap
- Compare execution models: market order vs. limit order impact
- Run on paper account (Tradier or Interactive Brokers)

---

## Expected Results

### Performance Spread (All 74 Tickers)
- **Top 10**: Likely ratio > 0.8, P&L > 50%
- **Median**: Likely ratio 0.3–0.5, P&L 10–20%
- **Bottom 10**: Likely ratio < 0.2, P&L near-zero or negative

### Pairs Hedge Quality
- **Perfect hedge** (ratio near 1.0): One long + short offset each other, neutral P&L, low DD
- **Poor hedge** (ratio < 0.2): Long + short don't correlate, additive DD, confusing signals
- **Best pairs**: Likely TQQQ/SQQQ and SOXL/SOXS (tight inverse correlation)

### Time-of-Day Patterns
- Expect **morning volatility spike** (9:30–11:00 ET) → high P&L trades
- Expect **afternoon flatness** (2:00–4:00 ET) → fewer signals
- Expect **EOD reversal** (3:30–4:00 ET) → mixed results

---

## Troubleshooting

**Q: Endpoints return empty?**
```bash
# Check files exist
ls -la scripts/autoresearch/output/etf-long-sweep-*.json | head -5

# Restart backtest-server
pkill -f "backtest-server"
nohup npx tsx scripts/autoresearch/backtest-server.ts > /tmp/backtest-server.log 2>&1 &

# Wait 5s and retry
sleep 5
curl http://localhost:3700/api/etf-profiles
```

**Q: Pairs analysis missing?**
```bash
# Run post-sweep automation
bash scripts/diag/etf-long-post-sweep.sh

# Or run pairs batch manually
bash scripts/diag/etf-long-pairs-batch.sh --minTrades 20
```

**Q: Memory explosion during manual analysis?**
```bash
# Run one pairs at a time instead of batch
npx tsx scripts/diag/etf-long-pairs-study.ts --pair SOXL,SOXS
# Wait 30s
npx tsx scripts/diag/etf-long-pairs-study.ts --pair TQQQ,SQQQ
```

---

## Files to Commit/Archive

After verification:
```bash
# Commit this milestone
git add scripts/autoresearch/output/etf-long-sweep-*.json scripts/autoresearch/output/etf-long-pairs-*.json
git commit -m "data: Complete 74-ticker ETF long sweep + pairs analysis (2026-05-24)"

# Optional: Archive to separate branch for historical reference
git branch archive/etf-sweep-2026-05-24
git push origin archive/etf-sweep-2026-05-24
```

---

**Next Action**: Run this checklist step-by-step once sweep completes. Each phase is self-contained and can be run independently.

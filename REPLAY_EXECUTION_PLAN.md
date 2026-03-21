# SPXer Replay Backtesting Execution Plan

**Target**: Full-day historical replay backtesting for 22 trading days (Feb 20 - Mar 20, 2026) with revised signal detection, narrative-driven context, and multi-model judgment.

**Current State**:
- ✅ Database: 1.27M bars, 2,632 contracts
- ✅ Code: All 44 tests pass, zero compilation errors
- ✅ Data: 3 major expirations fully tracked (3/18, 3/19, 3/20)
- ⏳ Replay: Running on March 20 data

---

## Phase 1: Full Backfill Validation (Optional)

**Why**: Ensure all 22 trading days have complete option data from Polygon/Massive API

```bash
# Backfill all 22 days (Feb 20 → Mar 20, 2026)
npx tsx backfill-polygon.ts 2026-02-20 2026-03-20

# Expected:
#   - Fetches 1-min SPXW bars for each day
#   - Rate-limited: 5 req/min (Polygon starter)
#   - Duration: ~45 min for 22 days
#   - Result: DB grows from 1.27M → ~1.5M bars (if backfill finds new data)
```

**Checkpoint**: After backfill completes, verify:
```bash
sqlite3 data/spxer.db "SELECT DATE(ts, 'unixepoch'), COUNT(*) FROM bars WHERE symbol LIKE '%26032%' GROUP BY DATE(ts, 'unixepoch');"
```
Expected: 20-22 rows (one per trading day) with bars from 9:30 AM to 4:15 PM ET

---

## Phase 2: Single-Day Replay Validation

**Why**: Test replay on one day to validate signal detection, judgment flow, and scoring before running full 22-day suite

### Step 1: Run Single-Day Replay (March 20)

```bash
npx tsx replay-full.ts 2026-03-20
```

**Expected Output**:
```
═══════════════════════════════════════════════════════════════════════
  REPLAY RESULTS
═══════════════════════════════════════════════════════════════════════

💼 TRADES (N total):
  ✅ CALL 6600 | 10:34@$2.15 → 11:02@$5.88 | +173% ($373)
  ❌ PUT 6525 | 12:45@$1.50 → 13:15@$0.95 | -37% (-$55)
  ...

📈 SUMMARY:
  Trades: N | Win rate: X% | Total P&L: $XXX
```

**Checkpoint**:
- Trades generated? ✅
- P&L calculated? ✅
- Win rate > 0%? Check output
- No errors or crashes? ✅

### Step 2: Inspect Individual Trades

For each trade in output:
1. **Entry**: Time, strike, price, reason (signal type)
2. **Exit**: Time, price, P&L
3. **Signal**: What triggered? (RSI cross, EMA cross, HMA cross, judge escalation?)

```bash
# Grep for specific signal types in logs
grep -i "RSI\|EMA\|HMA\|escalate" replay-output.log
```

### Step 3: Validate Signal Detection

Check that signals fired correctly:
- RSI oversold (< 20) generated CALL signals? ✅
- RSI overbought (> 80) generated PUT signals? ✅
- EMA/HMA crosses detected? ✅
- Regime gate blocked inappropriate signals? ✅

---

## Phase 3: Full 22-Day Replay Suite

**Why**: Comprehensive backtesting across entire dataset to get aggregate statistics

```bash
# Run replay on all 22 days (sequential, can take 2-3 hours)
for date in 2026-02-20 2026-02-23 2026-02-24 2026-02-25 2026-02-26 2026-02-27 2026-03-02 2026-03-03 2026-03-04 2026-03-05 2026-03-06 2026-03-09 2026-03-10 2026-03-11 2026-03-12 2026-03-13 2026-03-16 2026-03-17 2026-03-18 2026-03-19 2026-03-20; do
  echo "═══ Replaying $date ═══"
  npx tsx replay-full.ts $date >> replay-results-22day.log 2>&1
  sleep 5  # brief pause between days
done
```

**Or use batch script** (if exists):
```bash
npx tsx backtest-multi.ts --from 2026-02-20 --to 2026-03-20
```

### Collect Results

```bash
# Extract summary from logs
grep -E "Trades:|Win rate:|Total P&L:" replay-results-22day.log
```

**Expected Aggregate Stats**:
- Total trades: 30-50 across 22 days
- Win rate: 40-50% (target: > 40%)
- Avg P&L per day: > $0 (positive)
- Max losing day: > -$500 (within risk limits)

---

## Phase 4: Generate Scorecard

Create `SCORECARD.md` summarizing results:

```markdown
# 22-Day Replay Scorecard (Feb 20 - Mar 20, 2026)

## Summary
- **Trading Days**: 22
- **Total Trades**: N
- **Win Rate**: X%
- **Avg P&L/Day**: $Y
- **Total P&L**: $Z

## By Day
| Date | Trades | Win % | P&L |
|------|--------|-------|-----|
| 2026-02-20 | 2 | 50% | +$245 |
| 2026-02-23 | 0 | N/A | $0 |
| ...

## Key Insights
- Which day had most trades?
- Which signal type (RSI/EMA/HMA) was most profitable?
- Any regime patterns (morning vs afternoon)?
- Which expirations (3/18, 3/19, 3/20) traded best?
```

---

## Phase 5: Validate Against Live Signals (March 20 Deep Dive)

March 20 is the most important day — actual live trading happened. Compare:

1. **Replay signals** (what backtester detected)
2. **Live signals** (what multi-model scanner actually triggered)
3. **Actual trades** (what was executed)

Check files:
- `replay-library/2026-03-20-replay.md` — Replay results for March 20
- `replay-library/live-2026-03-20.md` — Live scanner output for March 20
- `logs/agent-activity.jsonl` — Actual trades executed

Questions to answer:
- Did replay catch the same signals as live scanners? ✅
- Did replay make better/worse strike selections?
- Did deterministic system outperform LLM judges?
- Was regime classifier useful (compare +regime vs -regime decisions)?

---

## Execution Timeline

| Phase | Duration | Notes |
|-------|----------|-------|
| **Phase 1** (Backfill) | 45 min | Optional if data complete |
| **Phase 2** (Single Day) | 15 min | Validate before full suite |
| **Phase 3** (22 Days) | 2-3 hrs | Can run in background |
| **Phase 4** (Scorecard) | 30 min | Analyze results |
| **Phase 5** (Deep Dive) | 1-2 hrs | Compare with live data |
| **TOTAL** | **4-6 hours** | Includes waiting time |

---

## Success Criteria

✅ **Phase 2 Single-Day Validation**:
- At least 1 trade executed
- P&L calculated correctly
- No runtime errors or crashes

✅ **Phase 3 Full Suite**:
- All 22 days complete
- Total win rate ≥ 40%
- No day loses > $500

✅ **Phase 5 Deep Dive**:
- Replay signals match live scanner detection
- Deterministic strikes as good or better than judge selections
- Regime classifier improves accuracy or reduces false positives

---

## Commands Quick Reference

```bash
# Single day
npx tsx replay-full.ts 2026-03-20

# Backfill (if needed)
npx tsx backfill-polygon.ts 2026-02-20 2026-03-20

# Tests
npm run test

# Database snapshot
sqlite3 data/spxer.db "SELECT COUNT(*) FROM bars; SELECT COUNT(*) FROM contracts;"

# View results
cat replay-library/2026-03-20-replay.md
```

---

## Known Blockers & Mitigations

| Blocker | Mitigation |
|---------|-----------|
| Replay very slow (1.27M bars) | Run overnight, or use parallel processing |
| Polygon API rate limits | Backfill has built-in sleep; 5 req/min = 22 days in ~45 min |
| Judge timeout (SDK serialization) | Judges run in fallback mode; scanners run direct HTTP |
| Missing option data | Fallback to ±$100 strike band (sticky band model) |

---

## Next Steps After Execution

1. **If win rate < 40%**: Review signal detection thresholds (RSI, EMA crossover levels)
2. **If P&L negative**: Tighten stop-loss (currently 50-70%), reduce position size
3. **If judges timeout**: Switch to LiteLLM proxy or direct HTTP for Claude calls
4. **If promising results**: Deploy live or run paper trading monitor (`live-monitor.ts`)


# Put/Call Skew Signal — Test Summary & Next Steps

## What We Found (June 8, 2026)

**The Signal**: When put/call ratio at ATM strikes reaches extreme skew (4:1 or higher in favor of calls), the market is priced for further upside **but frequently reverses**.

**Evidence from June 8**:
```
14:00 ET: SPX 7433, C/P ratio 0.5 (balanced)
15:00 ET: SPX 7464 (PEAK), C/P ratio 4.2 (EXTREME call bias)
16:00 ET: SPX 7440 (-24 from peak)
17:00 ET: SPX 7434 (-30 from peak)
18:00 ET: SPX 7431 (-33 from peak)
20:00 ET: SPX 7406 (-58 from peak)

7440 Put values: 7.27 (15:00) → 31.99 (20:00) = +340% in 5 hours
```

**Interpretation**: The extreme call skew (4.2:1) at 15:00 ET signaled the market was WAY too bullish. Prices collapsed 1.5%, making puts the trade of the day.

---

## The Problem: One Day ≠ A Signal

**Why June 8 alone doesn't prove anything**:
- ✅ It worked spectacularly on this one day
- ❌ No data on whether it works on 20+ other days
- ❌ No data on what happens when skew does NOT show extreme bias
- ❌ No understanding of false signals (times it looked extreme but didn't reverse)

**Your challenge** (which you correctly called out):
> "Did you test this on one day or across several days and months?"

**Answer**: Only one day. That's insufficient for a trading signal.

---

## The Complete Test Suite

I've created **PUT-CALL-SKEW-SIGNAL-TEST.md** with 4 progressive tests:

### Test 1: Cross-Day Pattern Validation ⭐ START HERE
**Duration**: 2 hours  
**Data**: 5 trading days (June 1, 2, 3, 4, 8)  
**Question**: Does extreme call skew → reversal hold on ALL days, or just June 8?

**Expected outcomes**:
- Scenario A: All 5 days show same pattern → Signal is REAL
- Scenario B: Only 1-2 days show it → Signal is a FLUKE
- Scenario C: Pattern reverses on some days (put skew predicts rallies) → Signal is BIDIRECTIONAL but valid

**How to run**:
```bash
bash /home/ubuntu/SPXer/run-skew-test.sh
# Then manually edit it to test other dates
```

### Test 2: Intraday Timing Validation
**Duration**: 4 hours  
**Question**: Can we detect the skew signal by 2-3pm ET, early enough to trade the 5-hour reversion?

**Key metric**: Does skew peak WITHIN 1 hour of actual price peak?
- ✅ YES → Signal is tradeable (enter at 3:00 ET, exit at close)
- ❌ NO → Signal is reactive, too late to profit

### Test 3: Statistical Validation Across 200+ Days ⭐ CRITICAL
**Duration**: 6-12 hours  
**Data**: All available 0DTE days (March 2025 – June 2026)  
**Question**: What win rate do we get fading extreme skew?

**Success threshold**: >55% win rate on extreme call skew (4:1+)
- >60% = TRADEABLE
- 55-60% = BORDERLINE
- <55% = NOT WORTH TRADING (worse than random)

### Test 4: Live Backtest in OptionX
**Duration**: Once Test 3 passes  
**Question**: Can we encode this as an actual trading rule and backtest it?

---

## How to Use This Document in SPXer Studio

### You can access/reference these files from:

1. **The Test Plan**:
   ```
   /home/ubuntu/SPXer/PUT-CALL-SKEW-SIGNAL-TEST.md
   ```
   Open this in any text editor or browser to see the full test methodology.

2. **Quick Test Script**:
   ```bash
   bash /home/ubuntu/SPXer/run-skew-test.sh
   # Runs the June 8 analysis to confirm the baseline
   ```

3. **DuckDB Queries** (embedded in the test plan):
   ```bash
   cd /home/ubuntu/SPXer && duckdb
   # Paste queries for other dates
   ```

4. **Data Location**:
   ```
   /home/ubuntu/SPXer/data/parquet/bars/spx-0dte/
   # Contains 280+ trading days of 0DTE option bars
   ```

---

## Critical Unknowns (Must Be Answered)

### Q1: Does the pattern generalize?
- June 8 had a -50 pt move
- June 1 had a +35 pt move
- Do different move sizes change the skew pattern?

### Q2: When is skew "extreme enough" to trade?
- 4:1 clearly worked on June 8
- What about 3:1? 2:1?
- Is there a threshold, or is it continuous?

### Q3: What about opposite direction (put skew → upside)?
- If calls 4:1 more expensive → fade with puts
- Does puts 4:1 more expensive → fade with calls?

### Q4: How reliable is the timing?
- June 8 peak was 3pm ET, skew peaked at 3pm ET (perfect)
- Is this typical? Do you always get 30 min warning?

---

## What I Did Wrong (Lesson for Next Signal Hunt)

1. **Fitted one day** without validating others ✗
2. **Ignored data quality** (June 5 was corrupt) ✗
3. **Claimed I had a signal** after looking at one chart ✗
4. **Didn't ask "what would disprove this?"** ✗

**What I should have done**:
1. ✅ Picked 5+ days with different characteristics
2. ✅ Verified data quality upfront (coverage %, gaps)
3. ✅ Computed win rate on ALL days before claiming success
4. ✅ Tested opposite signals (put skew) to understand directionality

---

## Your Next Move

### Option A: Run Test 1 Yourself (Recommended)
- Takes 2 hours
- Will immediately tell you if this signal is worth pursuing
- Start with: `bash /home/ubuntu/SPXer/run-skew-test.sh`

### Option B: Request I Run All Tests
- Takes 6-12 hours wall-clock
- I'd compute win rates on 200+ days
- Gives you a definitive YES/NO

### Option C: Abandon This Signal
- Focus on something else (different indicator, timeframe, strike selection)
- This one might be a dead end

---

## Files Created for You

| File | Purpose | Action |
|------|---------|--------|
| `PUT-CALL-SKEW-SIGNAL-TEST.md` | Full test methodology | 📖 Read this first |
| `run-skew-test.sh` | Automated test runner | ▶️ Run this to start |
| `scripts/test-put-call-skew.ts` | TypeScript test harness | 🛠️ Reference/extend |
| `SKEW-TEST-SUMMARY.md` | This file | 👈 You are here |

---

## Bottom Line

**June 8 proves the signal CAN work** (4:1 call skew → -58 pt move).

**But it doesn't prove it ALWAYS works.** 

**Your job (Test 1)**: Run on 5 more days. If all 5 show reversals when skew is extreme, move to Test 3. If only 1-2 work, the signal is random noise.

What would you like me to do?

1. Run all tests for you (full validation)
2. Help you run Test 1 manually (learn the process)
3. Something else?

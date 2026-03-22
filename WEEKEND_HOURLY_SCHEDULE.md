# Weekend Hourly Schedule — March 22-23, 2026
## Team Execution Plan for 22-Day Backtest Review & Strategy Refinement

---

## SATURDAY, MARCH 22

### 08:00 ET — Setup & Pre-Game
**Owner**: DevOps / Tech Lead
- [ ] Verify backtest still running: `ps aux | grep replay-full`
- [ ] Check disk space: `df -h`
- [ ] Check database size: `ls -lh data/spxer.db*`
- [ ] Notify team: "Backtest in progress, expected complete 10:30 ET"
- [ ] Open shared doc for results capture

**Deliverable**: Confirmation backtest is running healthy

---

### 09:00 ET — Check Backtest Progress
**Owner**: Data Analyst / QA Lead
- [ ] Monitor log: `tail -50 replay-22day-results.log`
- [ ] Count completed days: `grep "^===" replay-22day-results.log | wc -l`
- [ ] Check for errors: `grep -i "error\|exception" replay-22day-results.log`
- [ ] Capture current time and days processed
- [ ] Report status to team: "X/22 days complete, [Y] minutes elapsed"

**Commands**:
```bash
# Check progress
echo "Backtest Progress:"
DAYS_DONE=$(grep -c "^===" replay-22day-results.log)
echo "$DAYS_DONE/22 days complete"
STARTED=$(head -1 replay-22day-results.log | cut -d' ' -f5-)
echo "Started: $STARTED"
```

**Deliverable**: Status update to Slack/team channel

---

### 10:00 ET — Final Preparations
**Owner**: Strategy Lead
- [ ] Open WEEKEND_PLAN.md and DEPLOYMENT_SUMMARY.md (re-read for context)
- [ ] Create analysis spreadsheet template (Google Sheets or CSV)
- [ ] Prepare column headers: Date, Regime, Trades, Win%, P&L, Notable
- [ ] Set up second monitor for logs
- [ ] Have text editor ready for extracting data

**Deliverable**: Spreadsheet template ready to fill

---

### 10:30 ET — **CRITICAL**: Backtest Completion & Results Extraction
**Owner**: Data Analyst (Primary) + QA (Secondary)
- [ ] **STOP MONITORING** — Let final results finish
- [ ] Extract overall summary: `grep "Total P&L\|Win rate\|Trades:" replay-22day-results.log | tail -20`
- [ ] Create `22day-summary.txt`: `grep -E "^===|Trades:|Win rate:|Total P&L:|CALL|PUT" replay-22day-results.log > 22day-summary.txt`
- [ ] Create `daily-breakdown.txt`: Extract results by date
- [ ] Count total trades: `grep -c "ENTER\|BUY" replay-22day-results.log`
- [ ] Verify all 22 days processed: `grep -c "^===" replay-22day-results.log` (should be 22)

**Critical Commands**:
```bash
# Extract summary
tail -100 replay-22day-results.log | grep -E "SUMMARY|Trades:|Win rate:|Total P&L:"

# Save to file
grep "Total P&L:" replay-22day-results.log > summary-results.txt

# Count trades
grep "ENTER" replay-22day-results.log | wc -l

# Verify completion
if [ $(grep -c "^===" replay-22day-results.log) -eq 22 ]; then
  echo "✅ All 22 days processed"
else
  echo "⚠️ Only $(grep -c '^===' replay-22day-results.log) days done"
fi
```

**Deliverable**:
- `22day-summary.txt` (overall results)
- `daily-breakdown.txt` (by-date results)
- **SLACK MESSAGE**: "✅ Backtest complete! X total trades, Y% win rate, $Z total P&L"

---

### 11:00 ET — Quick Review & Triage
**Owner**: Strategy Lead
- [ ] Read `22day-summary.txt` (5 min)
- [ ] Identify obvious patterns: Any days losing > $500? Any days winning > $5K?
- [ ] Check win rate: Is it > 40% (threshold)?
- [ ] List top 3 best days + worst 3 days
- [ ] Capture in shared doc: "Quick Observations"

**Quick Analysis**:
```bash
# Best days
grep "Total P&L:" replay-22day-results.log | sort -t'$' -k2 -nr | head -3

# Worst days
grep "Total P&L:" replay-22day-results.log | sort -t'$' -k2 -n | head -3

# Win rate
TOTAL=$(grep -c "ENTER" replay-22day-results.log)
WINS=$(grep "CLOSE.*+[0-9]" replay-22day-results.log | wc -l)
echo "Win rate: $(( WINS * 100 / TOTAL ))%"
```

**Deliverable**: "Quick Observations" doc with top/worst days + win rate

---

### 12:00 ET — LUNCH (60 min)
**Owner**: Team
- [ ] Grab lunch
- [ ] Return by 13:00 ET refreshed
- [ ] Background: Logs complete and ready for analysis

---

### 13:00 ET — Begin Analysis Phase (Phase 2a)
**Owner**: Data Analyst (Primary) + Strategy Lead (Secondary)

**Goal**: Build detailed regime breakdown

**Tasks**:
- [ ] Extract results for each regime from logs
  - MORNING_MOMENTUM (09:30-10:15)
  - MEAN_REVERSION (10:15-14:00)
  - TRENDING_UP/DOWN (any time)
  - GAMMA_EXPIRY (14:00-15:30)
  - NO_TRADE (15:30-16:00)

- [ ] For each regime, calculate:
  - Total trades
  - Win rate (%)
  - Average P&L per trade
  - Average P&L per day
  - Best trade
  - Worst trade

**Command Structure**:
```bash
# For each date, grep for regime in logs
# Pattern: "regime=MORNING_MOMENTUM" or similar
grep -o "regime=[A-Z_]*" replay-22day-results.log | sort | uniq -c

# Extract trades per regime
grep "regime=MORNING_MOMENTUM" replay-22day-results.log | wc -l

# Calculate by hand (spreadsheet):
# Paste each regime's trades into columns A-D
# Sum/average in Excel or Google Sheets
```

**Spreadsheet Format**:
```
Regime | Days | Total Trades | Wins | Win% | Total P&L | Avg P&L/Trade | Avg P&L/Day
MORNING | 22 | N | Y | X% | $Z | $A | $B
MEAN_REV | 22 | N | Y | X% | $Z | $A | $B
TRENDING | 22 | N | Y | X% | $Z | $A | $B
GAMMA | 22 | N | Y | X% | $Z | $A | $B
NO_TRADE | 22 | 0 | 0 | — | $0 | — | $0
```

**Deliverable**: Filled spreadsheet (regime breakdown)

---

### 15:00 ET — Continued Analysis (Trade-by-Trade)
**Owner**: Data Analyst (Primary)

**Goal**: Extract winning vs losing trades

**Tasks**:
- [ ] Create CSV of ALL winning trades:
  - Date | Time | Symbol | Entry Price | Exit Price | P&L $ | P&L % | Bars Held
- [ ] Create CSV of ALL losing trades (same columns)
- [ ] Analyze winners:
  - Average entry price
  - Average exit price
  - Average hold time
  - Most common symbols
  - Average P&L % for wins

- [ ] Analyze losers:
  - Average entry price
  - Average exit price
  - Average hold time
  - Most common symbols
  - Average P&L % for losses

**Command Sample**:
```bash
# Extract winning trades (look for CLOSE with +)
grep -E "CLOSE.*\+[0-9]" replay-22day-results.log | awk '{print $2, $3, $NF}' > winning-trades.csv

# Extract losing trades (look for CLOSE with -)
grep -E "CLOSE.*-[0-9]" replay-22day-results.log | awk '{print $2, $3, $NF}' > losing-trades.csv

# Count
echo "Winning trades: $(wc -l < winning-trades.csv)"
echo "Losing trades: $(wc -l < losing-trades.csv)"
```

**Deliverable**:
- `winning-trades.csv`
- `losing-trades.csv`
- Summary statistics for each

---

### 16:30 ET — Pattern Recognition & Insights
**Owner**: Strategy Lead + Data Analyst

**Goal**: Identify actionable patterns

**Analyze & Document**:
- [ ] **High-Win Regimes**: Which regimes > 50% win rate?
- [ ] **Low-Win Regimes**: Which regimes < 30% win rate? Should we skip them?
- [ ] **Time of Day**: Are morning trades better/worse than afternoon?
- [ ] **Strike Patterns**: Do winners have specific delta/gamma characteristics?
- [ ] **Entry Quality**: What's average time-to-profit for winners?
- [ ] **Exit Triggers**: Most common exit (time, profit, stop-loss)?
- [ ] **Duration**: What's the optimal hold time?

**Create "Key Findings" Document**:
```markdown
## Key Findings from 22-Day Backtest

### High-Win Regimes
- MEAN_REVERSION: 60% win rate (best)
- MORNING_MOMENTUM: 45% win rate
- Implication: Focus on MEAN_REVERSION setups

### Low-Win Regimes
- GAMMA_EXPIRY: 25% win rate (skip?)
- NO_TRADE: 0% (by design)
- Implication: Disable trades in last 90 minutes?

### Time of Day
- 09:30-10:30: 40% win rate
- 10:30-14:00: 55% win rate (best)
- 14:00-15:30: 20% win rate (gamma expiry, risky)

### Strike Selection
- Winners: Average $1.50 entry, 22pts OTM
- Losers: Average $0.80 entry, 15pts OTM
- Implication: Entry price correlates with win rate

### Average Hold Time
- Winners: 180 minutes (3 hours)
- Losers: 45 minutes (quick exits to stop-loss)
- Implication: More time = more winners?

### Entry to Profit
- Winners: Average 35 minutes to first 10% gain
- Losers: Average 8 minutes to -10% loss
- Implication: Asymmetric risk/reward working
```

**Deliverable**: "Key Findings" document with actionable insights

---

### 17:30 ET — Standup & Day Review
**Owner**: Strategy Lead (facilitates)
- [ ] Quick team standup (15 min)
- [ ] Summarize key findings
- [ ] Confirm Sunday start time
- [ ] Assign Sunday responsibilities
- [ ] Update project management tool (Jira/Asana)

**Talking Points**:
- "We found X patterns from 22-day backtest"
- "Win rate was Y% (above/below 40% target)"
- "Best regime: Z (focus here Sunday)"
- "Worst regime: W (consider disabling)"
- "Sunday we'll run parameter sweep and validation"

**Deliverable**: Team alignment for Sunday

---

### 18:00 ET — WRAP-UP (END SATURDAY)
**Owner**: All
- [ ] Commit analysis docs: `git add 22day-summary.txt daily-breakdown.txt winning-trades.csv && git commit -m "analysis: backtest results extraction and initial analysis"`
- [ ] Push to repo: `git push origin master`
- [ ] Close all spreadsheets
- [ ] Turn off monitors
- [ ] Celebrate — backtest complete! 🎉

---

---

## SUNDAY, MARCH 23

### 08:00 ET — Morning Setup
**Owner**: DevOps / Tech Lead
- [ ] Verify database intact: `sqlite3 data/spxer.db "SELECT COUNT(*) FROM bars"`
- [ ] Ensure code clean: `git status`
- [ ] Prepare terminals for parameter sweep
- [ ] Check available CPU/memory: `free -h && nproc`

**Deliverable**: System ready for parameter sweep

---

### 09:00 ET — **CRITICAL**: Start Parameter Sweep (Phase 3a)
**Owner**: Engineer (Primary) + Data Analyst (Secondary)

**Goal**: Optimize key parameters based on 22-day backtest

**Test Matrix**:
```bash
# Terminal 1: RSI sensitivity
npx tsx param-sweep.ts --rsi-oversold 15,18,20,22,25

# Terminal 2 (parallel, after 5 min): Stop-loss %
npx tsx param-sweep.ts --stop-loss-pct 40,50,60,70,80

# Terminal 3 (parallel, after 10 min): TP multiplier
npx tsx param-sweep.ts --tp-multiplier 3,4,5,6,8

# Combined test (after singles complete):
npx tsx param-sweep.ts --rsi-oversold 18,20 --stop-loss 50,60 --tp-multiplier 5,6
```

**Expected Duration**: 2-3 hours total
**Output**: CSV with results for each parameter combo
**Monitor**: `tail -20 param-sweep-results.log`

**Deliverable**: `param-sweep-results.csv` with optimization data

---

### 11:30 ET — Sweep In Progress / Interim Analysis
**Owner**: Data Analyst
- [ ] While sweep runs, analyze results so far
- [ ] Extract best parameters from sweep results
- [ ] Rank parameter combinations by P&L
- [ ] Identify sweet spot (best win rate + best P&L)

**Command**:
```bash
# Check current results
tail -50 param-sweep-results.csv | sort -t',' -k3 -nr | head -10

# Identify best combination
awk -F',' 'NR>1 {print $0}' param-sweep-results.csv | \
  sort -t',' -k3 -nr | \
  head -5 > best-params.csv
```

**Deliverable**: `best-params.csv` (top 5 parameter combos)

---

### 13:00 ET — LUNCH (60 min)
**Owner**: Team
- [ ] Grab lunch
- [ ] Parameter sweep likely 40-60% done
- [ ] Return refreshed for validation phase

---

### 14:00 ET — Sweep Completion & Results Analysis
**Owner**: Data Analyst (Primary) + Strategy Lead (Secondary)

**Tasks**:
- [ ] Wait for parameter sweep to complete (if still running)
- [ ] Load full results: `cat param-sweep-results.csv`
- [ ] Create comparison chart:
  - Original 22-day: $X total, Y% win rate
  - Best new param set: $Z total, W% win rate
  - Improvement: $[Z-X], [W-Y]%

- [ ] Decision matrix:
  ```
  Param Set | Total P&L | Win% | Improvement | Confidence
  Original  | $X        | Y%   | —           | Baseline
  RSI 18    | $Y        | Y%   | +[X-Y]%     | High/Med/Low
  Stop 60   | $Z        | Z%   | +[X-Z]%     | High/Med/Low
  TP 6x     | $W        | W%   | +[X-W]%     | High/Med/Low
  Combo     | $V        | V%   | +[X-V]%     | High/Med/Low
  ```

**Deliverable**: Comparison chart + decision matrix

---

### 15:30 ET — Regime Gate Refinement (Phase 3b)
**Owner**: Strategy Lead + Engineer

**Goal**: Adjust which signals fire in which regimes

**Decision Points**:
- [ ] **MORNING_MOMENTUM**: Current = breakout only. Based on 22-day results:
  - [ ] Keep current? (breakout follow only)
  - [ ] Enable fade? (RSI extremes)
  - [ ] Reduce to 09:30-10:00 only?

- [ ] **MEAN_REVERSION**: Current = RSI fade. Results showed > 50% win rate:
  - [ ] Keep current (best performer)
  - [ ] Expand to EMA crosses?
  - [ ] Increase threshold?

- [ ] **TRENDING**: Current = break follow. Results?
  - [ ] Keep current?
  - [ ] Exclude fade signals?
  - [ ] Time restrictions (morning only)?

- [ ] **GAMMA_EXPIRY**: Current = all signals. Results showed < 30% win rate:
  - [ ] Disable entirely (move 14:00 NO_TRADE)?
  - [ ] Keep but raise escalation threshold?
  - [ ] Allow only TRENDING signals?

- [ ] **NO_TRADE**: Current = 15:30-16:00. Correct timing?
  - [ ] Extend to 15:00-16:00?
  - [ ] Keep as-is?

**Update Code**:
```typescript
// In src/agent/regime-classifier.ts
// Update SignalGate based on decisions above

export function getSignalGate(regime: Regime): SignalGate {
  if (regime === 'MORNING_MOMENTUM') {
    return {
      allowOverboughtFade: false,  // ← potentially change
      allowOversoldFade: false,    // ← potentially change
      allowBreakoutFollow: true,
      allowVReversal: true,
      // ...
    };
  }
  // ... other regimes
}
```

**Deliverable**: Updated `src/agent/regime-classifier.ts` with refined gates

---

### 16:30 ET — Single-Day Validation (Phase 4a)
**Owner**: Engineer (Primary) + QA (Secondary)

**Goal**: Test refined strategy on March 20 (known good day)

**Procedure**:
```bash
# Original params (for comparison)
npx tsx replay-full.ts 2026-03-20 > original-mar20.log

# Refined params
npx tsx replay-full.ts 2026-03-20 \
  --rsi-oversold=18 \
  --stop-loss=60 \
  --tp-multiplier=6 \
  > refined-mar20.log

# Compare results
echo "=== ORIGINAL ==="
grep "Total P&L:" original-mar20.log | tail -1

echo "=== REFINED ==="
grep "Total P&L:" refined-mar20.log | tail -1
```

**Decision**:
- [ ] Refined > Original by > 10%? → PROCEED to full validation
- [ ] Refined ≈ Original? → Minor improvements, proceed cautiously
- [ ] Refined < Original? → REVERT, keep original params

**Deliverable**:
- `original-mar20.log` (comparison baseline)
- `refined-mar20.log` (test results)
- **Decision**: Proceed / Caution / Revert

---

### 17:15 ET — Full Validation (if approved)
**Owner**: Engineer (Primary)

**If refined params better**, run full 22-day retest:
```bash
# Save original params
cp src/agent/regime-classifier.ts src/agent/regime-classifier.ts.backup

# Run with refined params
bash run-22day-replay.sh > refined-22day.log

# Monitor progress
tail -f refined-22day.log | grep -E "===|Trades:|P&L"
```

**Expected Duration**: 1-1.5 hours
**Monitor**: Let it run (check periodically, doesn't need constant attention)

**Deliverable**: `refined-22day.log` (ongoing, will complete later)

---

### 18:00 ET — Document Strategy Changes (Phase 4b)
**Owner**: Strategy Lead (Primary) + Engineer (Secondary)

**Create `STRATEGY_REFINEMENTS_2026-03-21.md`**:

```markdown
# Strategy Refinements — March 21-23, 2026

## Changes Made

### Parameter Adjustments
- RSI Oversold threshold: 20 → 18 (more sensitive to reversal)
- RSI Overbought threshold: 80 → 82 (less aggressive on fades)
- Stop-loss percentage: 50% → 60% (wider stops, fewer false exits)
- Take-profit multiplier: 5x → 6x (higher profit targets)
- OTM distance: Increased minimum from 15 to 18 points

### Regime Gate Changes
- MORNING_MOMENTUM: [Keep|Changed] — breakout-only (did not enable fade due to mixed results)
- MEAN_REVERSION: [Keep|Changed] — increased from 10:15-14:00 to 10:00-14:30 (found more value)
- TRENDING: [Keep|Changed] — disabled fade signals, kept break follow only
- GAMMA_EXPIRY: [Disabled|Changed] — moved NO_TRADE to 14:00-16:00 (was 15:30)

### Escalation Threshold
- Changed from 0.5 → 0.55 confidence threshold (fewer false positives)

## Rationale

Based on 22-day backtest analysis:
- MEAN_REVERSION regimes had 60% win rate (best)
- Earlier time windows (10:00-14:00) showed + results
- Wider stops reduced whipsaw, wider TP targets achieved more wins
- Raising escalation threshold reduced judge false alarms

## Validation Results

**March 20 Single-Day Test**:
- Original: [result]
- Refined: [result]
- Improvement: [+/- X%]

**22-Day Retest** (if approved):
- Original: $[X], [Y]% win rate
- Refined: $[Z], [W]% win rate
- Improvement: $[Z-X] (+[W-Y]%)

## Confidence Level
- **High**: > 60% improvement
- **Medium**: 30-60% improvement
- **Low**: < 30% improvement

## Risk Considerations
- Wider stops absorb larger losses if trend reverses
- Higher TP targets may miss exits if market momentum slows
- Earlier NO_TRADE cutoff reduces late-day recovery opportunities

## Next Monitoring Points
- Monday live trading: compare live vs refined backtest P&L
- If live diverges > 20% from refined backtest, investigate
- Keep original params as emergency rollback (saved in backup)

## Decision Approval
- [ ] Strategy Lead: Approved for Monday deployment
- [ ] Risk Officer: Approved for position sizing
- [ ] Tech Lead: Code changes reviewed and tested
```

**Deliverable**: `STRATEGY_REFINEMENTS_2026-03-21.md` (complete)

---

### 19:00 ET — Monday Deployment Prep (Phase 4c)
**Owner**: DevOps / Engineer

**Checklist**:
- [ ] Update .env.local: `echo "AGENT_PAPER=true" >> .env.local`
- [ ] Create `monitor-monday.sh`:
  ```bash
  #!/bin/bash
  # Monitor Monday trading
  npm run agent &
  AGENT_PID=$!
  sleep 30

  # Tail logs in real-time
  tail -f logs/agent-activity.jsonl | jq '.ts, .event, .pnl'
  ```
- [ ] Create kill switch script:
  ```bash
  #!/bin/bash
  pkill -f "npm run agent"
  echo "Agent stopped"
  ```
- [ ] Backup current strategy: `git tag backup-2026-03-23`
- [ ] Review risk limits: `grep "MAX_DAILY_LOSS\|MAX_POSITIONS" .env`
- [ ] Verify monitoring tools: `npm run live-monitor` (test run, then stop)

**Deliverable**:
- `.env.local` with paper mode
- `monitor-monday.sh` (executable)
- Emergency rollback tag created
- All systems green for Monday

---

### 20:00 ET — Final Review & Standup
**Owner**: Strategy Lead (facilitates)
- [ ] 15-min standup
- [ ] Review all deliverables from weekend
- [ ] Confirm Monday responsibilities
  - Who monitors?
  - Who escalates if issues?
  - Who reviews results post-market?
- [ ] Assign Monday driver (primary responder)

**Summary Points**:
- "Backtest complete: X trades, Y% win rate, $Z P&L"
- "Best parameters identified: RSI 18, Stop 60%, TP 6x"
- "Refined strategy ready for deployment"
- "Monday: Paper trading with live monitoring"
- "Kill switch ready, rollback procedure documented"

**Deliverable**: Team alignment + Monday driver assigned

---

### 21:00 ET — **WRAP-UP (END SUNDAY)**
**Owner**: All
- [ ] Final commit:
  ```bash
  git add STRATEGY_REFINEMENTS_2026-03-21.md refined-22day.log .env.local monitor-monday.sh
  git commit -m "refined: strategy parameters tuned for Monday deployment

  - RSI oversold: 20 → 18
  - Stop-loss: 50% → 60%
  - Take-profit: 5x → 6x
  - Regime gates adjusted based on 22-day backtest analysis
  - Validated on March 20: +[X]% improvement
  - Ready for Monday paper trading

  Deployments checked: .env.local AGENT_PAPER=true
  Monitoring: monitor-monday.sh ready
  Rollback: Backup tag created"
  ```
- [ ] Push: `git push origin master`
- [ ] Deploy to VPS5 (if live trading next week): `git pull && npm run build`
- [ ] All systems down except database
- [ ] **TEAM SLEEP** — big day Monday! 🌙

---

---

## MONDAY, MARCH 24 (Deployment Day)

### 08:45 ET — Pre-Market Standup
**Owner**: Strategy Lead (facilitates)
- [ ] All team online (Slack / Zoom)
- [ ] Confirm paper mode: `grep AGENT_PAPER .env.local`
- [ ] Start monitoring: `npm run agent &`
- [ ] Monitor script ready: `bash monitor-monday.sh`

**Talking Points**:
- "We're PAPER trading today (no real money)"
- "Kill switch ready if anything weird"
- "Compare today's results vs refined backtest"
- "Daily standup at 16:00 ET post-market"

---

### 09:30 ET — Market Open
**Owner**: Monitoring Engineer (primary), Strategy Lead (backup)
- [ ] Watch for first signals (~09:50 historically)
- [ ] Confirm signals firing correctly
- [ ] Monitor: P&L, trade count, regime classification
- [ ] Every 30 min: Check for errors: `tail logs/agent-activity.jsonl | grep -i error`

**Commands**:
```bash
# Monitor live P&L
watch -n 10 'tail -3 logs/agent-activity.jsonl | jq ".pnl"'

# Check for errors
tail -20 logs/agent-activity.jsonl | jq 'select(.level=="error")'

# Compare vs backtest
echo "Expected signals at: 09:50, 10:30, 11:45, 14:00"
grep "^\[.*\]" logs/agent-activity.jsonl | head -10
```

---

### 16:00 ET — Market Close + Debrief
**Owner**: Strategy Lead (facilitates)
- [ ] Stop agent: `pkill -f "npm run agent"`
- [ ] Collect final results: `tail -50 logs/agent-activity.jsonl | jq '.pnl'`
- [ ] Compare live vs refined backtest
- [ ] Team debrief (30 min)
- [ ] Assess: Ready for live trading next day?

**Decision Tree**:
- Live P&L within 20% of backtest? → **PROCEED** to live mode Tuesday
- Live P&L outside 20%? → **INVESTIGATE** (debug signal, regime, or market conditions)
- Major error or unexpected behavior? → **REVERT** to original params, investigate further

---

### 17:00 ET — Post-Market Review & Planning
**Owner**: All
- [ ] Document Monday results
- [ ] Plan Tuesday: Paper or live?
- [ ] Adjust if needed
- [ ] Prepare for next week

---

---

## 📋 Daily Deliverables Checklist

### Saturday Deliverables ✅
- [ ] `22day-summary.txt` — Overall backtest results
- [ ] `daily-breakdown.txt` — Results by date
- [ ] `22day-analysis.md` — Pattern analysis by regime
- [ ] Slack update — Team alignment
- [ ] Git commit — Analysis saved to repo

### Sunday Deliverables ✅
- [ ] `param-sweep-results.csv` — Parameter optimization results
- [ ] `best-params.csv` — Top 5 parameter combinations
- [ ] Updated `src/agent/regime-classifier.ts` — Refined regime gates
- [ ] `original-mar20.log` + `refined-mar20.log` — Single-day validation
- [ ] `refined-22day.log` — Full 22-day retest (if approved)
- [ ] `STRATEGY_REFINEMENTS_2026-03-21.md` — Documented changes
- [ ] `.env.local` with `AGENT_PAPER=true` — Paper mode ready
- [ ] `monitor-monday.sh` — Monitoring script ready
- [ ] Git commit + tag — All changes saved, rollback ready

### Monday Deliverables ✅
- [ ] Live trading results
- [ ] Comparison: Live vs refined backtest
- [ ] Team debrief notes
- [ ] Decision: Live mode Tuesday or more refinement?

---

## 🎯 Success Criteria

**Saturday (Backtest)**:
- ✅ 22-day suite completes successfully
- ✅ Win rate > 40%
- ✅ Identify > 2 clear regime patterns

**Sunday (Refinement)**:
- ✅ Parameter sweep shows improvement
- ✅ Single-day validation passes (refined >= original)
- ✅ All documentation complete
- ✅ Code ready for deployment

**Monday (Validation)**:
- ✅ Paper trading executes without errors
- ✅ Live P&L within 20% of backtest
- ✅ Decision made on live deployment timing

---

## 👥 Team Roles & Responsibilities

| Role | Name | Saturday | Sunday | Monday |
|------|------|----------|--------|--------|
| **Strategy Lead** | [Name] | Oversight, pattern analysis | Parameter decisions, gate refinement | Debrief, next-week planning |
| **Data Analyst** | [Name] | Extract & triage results | Param sweep analysis | P&L comparison |
| **Engineer** | [Name] | Code updates, validation | Param sweep execution | Monitoring |
| **QA / DevOps** | [Name] | System health checks | Deployment prep | Live monitoring (backup) |

---

## 🚨 Emergency Contacts & Escalation

**If backtest fails**:
1. Check logs: `tail -100 replay-22day-results.log`
2. Verify DB: `sqlite3 data/spxer.db "SELECT COUNT(*) FROM bars"`
3. Contact Engineer immediately

**If parameter sweep breaks**:
1. Kill process: `pkill -f param-sweep`
2. Revert to `git checkout .`
3. Run with single parameter at a time

**If Monday trading misbehaves**:
1. **Kill switch**: `pkill -f "npm run agent"`
2. Check logs: `tail logs/agent-activity.jsonl`
3. Revert params: `git checkout src/agent/regime-classifier.ts`
4. Restart in paper mode

**Contact escalation**:
- First line: Engineer on-call
- Second line: Strategy Lead
- Third line: Tech Lead / Manager

---

## ✨ Final Notes

- **Stay flexible**: If backtest shows bad results, adjust expectations
- **Document everything**: Notes now save 10x effort later
- **Test conservative first**: Use PAPER mode Monday before going live
- **Team communication**: Daily standups keep everyone aligned
- **Celebrate wins**: 22-day backtest is a big effort! 🎉

---

**Plan Created**: March 21, 2026 18:30 ET
**Weekend Window**: March 22-23, 2026
**Deployment**: March 24, 2026 (Monday)

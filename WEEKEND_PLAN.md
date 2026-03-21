# Weekend Plan: 22-Day Backtest Review & Strategy Refinement

**Objective**: Run complete 22-day backtest, analyze results by regime/day, identify patterns, refine strategy parameters for Monday live trading.

**Timeline**: Saturday-Sunday (48 hours)

---

## Phase 1: Backtest Execution & Collection (Saturday AM)

### Step 1a: Monitor Backtest Progress (09:00 ET)
```bash
# Terminal 1: Monitor live progress
tail -f replay-22day-results.log

# Expected: 22 days × ~2-3 min per day = ~50-70 minutes total
# Will complete ~10:30 AM ET
```

### Step 1b: Wait for Completion
- Backtest runs: Feb 20, 23-27, Mar 2-6, 9-13, 16-20
- Output: `replay-22day-results.log` with individual trade results + P&L per day
- Database: 1.27M bars already backfilled

### Step 1c: Extract Results (10:30 AM ET)
```bash
# Pull summary
grep -E "^===|Trades:|Win rate:|Total P&L:|CALL|PUT" replay-22day-results.log > 22day-summary.txt

# Extract by date for analysis
grep -A 20 "=== [0-9]{4}-" replay-22day-results.log | grep -E "===|Trades:|P&L" > daily-breakdown.txt

# Count winning vs losing days
grep "Total P&L" replay-22day-results.log | awk '{print $NF}' | paste -sd+ | bc
```

---

## Phase 2: Results Analysis (Saturday PM)

### Step 2a: Build Analysis Spreadsheet (13:00 ET)
Create `weekend-analysis.md`:

```markdown
# 22-Day Backtest Analysis

## Overall Summary
- Total trades: [N]
- Win rate: [X]%
- Total P&L: $[Y]
- Best day: [DATE] +$[Z]
- Worst day: [DATE] -$[Z]
- Average P&L/day: $[AVG]

## Results by Regime

### MORNING_MOMENTUM (09:30-10:15)
- Days: [list]
- Avg P&L: $[X]
- Win rate: [Y]%
- Notes: [patterns]

### MEAN_REVERSION (10:15-14:00)
- Days: [list]
- Avg P&L: $[X]
- Win rate: [Y]%
- Notes: [patterns]

### TRENDING_UP/DOWN (any time)
- Days: [list]
- Avg P&L: $[X]
- Win rate: [Y]%
- Notes: [patterns]

### GAMMA_EXPIRY (14:00-15:30)
- Days: [list]
- Avg P&L: $[X]
- Win rate: [Y]%
- Notes: [patterns]

## Trade-by-Trade Analysis

### Winning Trades (extract from logs)
| Date | Time | Symbol | Entry | Exit | P&L | % Gain | Bars Held |
|------|------|--------|-------|------|-----|--------|-----------|
| 2026-03-20 | 09:50 | C06545 | $8.30 | $72.12 | +$6,382 | +769% | 345 min |
| ... | ... | ... | ... | ... | ... | ... | ... |

### Losing Trades (extract from logs)
| Date | Time | Symbol | Entry | Exit | P&L | % Loss | Bars Held |
|------|------|--------|-------|------|-----|--------|-----------|
| ... | ... | ... | ... | ... | ... | ... | ... |

## Pattern Recognition

### High-Win Regimes
- Which regimes produced > 50% win rate?
- Which times of day most profitable?

### Low-Win Regimes
- Which regimes need adjustment?
- Are we trading regimes we should skip?

### Entry Quality
- Average time to profit (minutes)?
- Earliest exit time for winners?
- Common exit triggers?

### Strike Selection
- Optimal OTM distance (pts)?
- Optimal price range ($)?
- Delta/gamma patterns in winners?
```

### Step 2b: Identify Key Patterns (16:00 ET)
- [ ] Regime with best win rate
- [ ] Regime with worst win rate
- [ ] Time windows most/least profitable
- [ ] Contract characteristics (delta, price) of winners
- [ ] Average trade duration for profit vs loss
- [ ] Common exit triggers (time, profit target, stop loss)

---

## Phase 3: Strategy Refinement (Sunday AM-PM)

### Step 3a: Parameter Sweep Analysis (09:00 ET)

Run param-sweep for promising parameters:

```bash
# Test RSI thresholds (currently 20/80 for extremes)
npx tsx param-sweep.ts --rsi-oversold 15,18,20,22,25 --rsi-overbought 75,78,80,82,85

# Test stop-loss percentages (currently 50%)
npx tsx param-sweep.ts --stop-loss-pct 40,50,60,70,80

# Test take-profit multiples (currently 5x)
npx tsx param-sweep.ts --tp-multiplier 3,4,5,6,8

# Test OTM distance (currently 15-25pts)
npx tsx param-sweep.ts --otm-pts-min 10,15,20 --otm-pts-max 20,25,30

# Expected: 2-4 hours for comprehensive sweep
```

### Step 3b: Regime Gate Refinement (14:00 ET)

**Decision**: Should we adjust which signals fire in which regimes?

Based on Step 2b analysis:
- [ ] MORNING_MOMENTUM: Currently only allows breakout follow. Still correct?
- [ ] MEAN_REVERSION: Currently allows RSI fade. Winning trades confirm?
- [ ] TRENDING: Currently allows break follow. Should we exclude fade?
- [ ] GAMMA_EXPIRY: Last 90 min, all signals allowed. Too risky?
- [ ] NO_TRADE: 15:30-16:00, no signals. Correct cutoff?

**Output**: Updated `src/agent/regime-classifier.ts` with refined signal gates

### Step 3c: Narrative & Escalation Threshold Tuning (16:00 ET)

Current: Escalate to judge when scanner confidence >= 0.5

**Test alternatives:**
- Escalate at 0.6 (fewer false positives)
- Escalate at 0.4 (more coverage)
- Escalate only on regime+scanner agreement
- Escalate on consecutive signals (same direction 2+ bars)

**Output**: Updated judgment thresholds in `src/agent/judgment-engine.ts`

---

## Phase 4: Validation & Deployment Prep (Sunday PM)

### Step 4a: Validate Refined Strategy (17:00 ET)

```bash
# Rerun 22-day backtest with NEW parameters
# Use one high-potential date set first for quick validation
npx tsx replay-full.ts 2026-03-20 --rsi-oversold=18 --stop-loss=60 --tp-multiplier=6

# Compare results
echo "Original Mar 20: +769% single trade"
echo "Refined Mar 20: [result]"

# If improved, run full 22-day retest
bash run-22day-replay.sh --rsi-oversold=18 --stop-loss=60 --tp-multiplier=6
```

### Step 4b: Document Strategy Changes (19:00 ET)

Create `STRATEGY_REFINEMENTS_2026-03-21.md`:

```markdown
# Strategy Refinements - March 21, 2026

## Changes Made
1. RSI oversold threshold: 20 → 18 (more sensitive)
2. Stop-loss percentage: 50% → 60% (wider stops)
3. Take-profit multiplier: 5x → 6x (higher targets)
4. Regime gate: [specify changes]
5. Escalation threshold: 0.5 → [new value]

## Rationale
- [Analysis from backtest]
- [Pattern identified]
- [Expected improvement]

## Validation Results
- Original 22-day: $[X] (+Y% total)
- Refined 22-day: $[Z] (+W% total)
- Improvement: +$[Z-X] (+[W-Y]%)

## Confidence Level
- High (> 60% win rate improvement)
- Medium (30-60% improvement)
- Low (< 30% improvement, monitor)

## Risk Considerations
- Wider stops may absorb more losers
- Higher TP targets may get hit less often
- Need to monitor live next week

## Next Monitoring Points
- Monday/Tuesday live results
- Compare live vs backtest performance
- Adjust if live diverges significantly
```

### Step 4c: Prepare for Monday Live (20:00 ET)

```bash
# Set environment for PAPER mode (default safe)
echo "AGENT_PAPER=true" >> .env.local

# Optional: Create monitor script
cat > monitor-monday.sh << 'MONITOR'
#!/bin/bash
# Monitor Monday trading
echo "=== Monday $(date +%Y-%m-%d) ==="
npm run agent &
AGENT_PID=$!
sleep 30

# Check first signal
tail -20 logs/agent-activity.jsonl | jq '.signal'

# Monitor P&L
watch -n 10 "tail -5 logs/agent-activity.jsonl | jq '.pnl'"

# Safety: kill if daily loss > limit
MONITOR

chmod +x monitor-monday.sh
```

---

## Deliverables (Sunday 21:00 ET)

- [ ] `22day-summary.txt` — Overall results
- [ ] `daily-breakdown.txt` — Results by date
- [ ] `weekend-analysis.md` — Pattern analysis + refined strategy
- [ ] `STRATEGY_REFINEMENTS_2026-03-21.md` — Changes documented
- [ ] Updated code: regime-classifier, judgment-engine, strike-selector
- [ ] Validation results: original vs refined backtest
- [ ] Monitor script ready for Monday deployment

---

## Monday Deployment Checklist

- [ ] Paper trading enabled (AGENT_PAPER=true)
- [ ] Live monitor running: `npm run agent`
- [ ] Logs configured: logs/agent-activity.jsonl
- [ ] Risk guard limits in place
- [ ] Slack/email alerts enabled (optional)
- [ ] Manual kill switch ready (Ctrl+C)
- [ ] Backup strategy: if live diverges > 20%, revert to original params

---

## Success Criteria

**Backtest Phase**:
- ✅ Complete 22-day run
- ✅ Identify > 2 clear patterns
- ✅ Win rate > 40% (threshold for profitability in 0DTE)

**Refinement Phase**:
- ✅ Parameter sweep shows improvement
- ✅ Refined strategy passes validation test
- ✅ All changes documented

**Deployment Phase**:
- ✅ Ready to go live Monday
- ✅ Risk management in place
- ✅ Monitoring prepared

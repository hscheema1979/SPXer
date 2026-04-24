# SPXer Daily Operations Checklist
> **"The checklists do not specify how to solve the problem. They simply remind us to do the right things at the right time."**
> — Atul Gawande, *The Checklist Manifesto*

## Architecture Note (v2.0 - Independent Services)

**CRITICAL**: All services are now **100% independent** with direct Tradier API connections.

- ✅ **event-handler**: Independent of spxer — fetches from Tradier REST API directly
- ✅ **position-monitor**: Independent of spxer — fetches from Tradier REST API directly
- ✅ **spxer**: OPTIONAL — only needed for replay viewer, NOT required for live trading

**Live trading continues even if spxer crashes.**

---

## Color Code
- ✅ **PASS** — Green, all systems go
- ⚠️ **WARN** — Yellow, monitor closely
- ❌ **FAIL** — Red, immediate action required
- 🔵 **INFO** — Blue, informational
- ⏸️ **HOLD** — Gray, do not proceed

---

## SECTION A: PRE-MARKET SETUP (06:00-08:00 ET)
> **Goal**: System integrity before market activity

### A1. Environment Verification (06:00 SHARP)
```bash
./scripts/ops/check-environment.sh
```

- [ ] **Date/Time Check**: Current ET time matches expected trading day
  - ✅ Today is a trading day (not weekend/holiday)
  - ✅ System time synchronized with NTP
  - ✅ Timezone set to ET (America/New_York)

- [ ] **Process Status**:
  - 🔵 `spxer` data service: RUNNING or STOPPED (OPTIONAL — only for replay viewer)
  - ✅ `event-handler` trading agent: STOPPED (will start at 09:00)
  - ✅ `position-monitor` exit observer: STOPPED (will start at 09:00)
  - 🔵 `metrics-collector`: RUNNING or STOPPED (optional)

- [ ] **Resource Check**:
  - ✅ Disk space > 10GB free on `/home/ubuntu/SPXer`
  - ✅ Memory usage < 80%
  - ✅ CPU load < 2.0

**PASS** → Proceed to A2
**FAIL** → Run `./scripts/ops/repair-environment.sh` and restart

---

### A2. Database Integrity (06:05)
```bash
./scripts/ops/check-databases.sh
```

- [ ] **Live Database** (`data/spxer.db`):
  - ✅ No corruption (PRAGMA integrity_check returns OK)
  - ✅ WAL file present and < 500MB
  - 🔵 Latest bar timestamp < 60 seconds old (if spxer running)

- [ ] **Account Database** (`data/account.db`):
  - ✅ No OPENING positions orphaned from previous session
  - ✅ All CLOSED positions have exit_reason populated
  - ✅ Config state table has entries for all active configs

- [ ] **Archive Verification**:
  - ✅ Previous day's parquet export completed
  - ✅ Previous day's GDrive upload succeeded (check logs)

**PASS** → Proceed to A3
**WARN** (orphaned positions) → Run reconciliation script before market open
**FAIL** → Immediate investigation, do NOT start handler

---

### A3. Provider Health (06:10)
```bash
./scripts/ops/check-providers.sh
```

- [ ] **Tradier Connection**:
  - ✅ Token valid (not expired)
  - ✅ Account ID accessible: `6YA51425`
  - ✅ Paper trading available (if testing)
  - ✅ REST API responding: `curl -s https://api.tradier.com/v1/markets/quotes?symbols=SPX -H "Authorization: Bearer $TRADIER_TOKEN"`

- [ ] **Optional: Data Service** (if running spxer for replay viewer):
  - 🔵 `GET /health` returns 200 (if spxer running)
  - 🔵 `uptimeSec` > 300 (if spxer running)
  - 🔵 WebSocket connected (if spxer running)

**PASS** → Proceed to A4
**FAIL** → Check Tradier status page, verify token

**NOTE**: event-handler and position-monitor are **independent** — they connect to Tradier directly, NOT through spxer.

---

### A4. Configuration Validation (06:15)
```bash
./scripts/ops/validate-configs.sh
```

- [ ] **Active Configs**:
  - ✅ `AGENT_CONFIG_ID` exists in `replay_configs` table
  - ✅ Config passes validation (no NaN, no null required fields)
  - ✅ HMA pair set: `hmaCrossFast` and `hmaCrossSlow` populated

- [ ] **Execution Mode**:
  - ✅ `AGENT_PAPER` set: `true` or `false`
  - ⚠️ If `false` (LIVE): Confirm manual verification required

- [ ] **Risk Parameters**:
  - ✅ `maxPositionsOpen` ≤ 5
  - ✅ `stopLossPercent` between 10-30
  - ✅ `takeProfitMultiplier` between 1.0-2.0
  - ✅ `maxDailyLoss` set and reasonable

**PASS** → Proceed to A5
**FAIL** → Fix config in DB before starting handler

---

### A5. Position Reconciliation (06:20)
```bash
./scripts/ops/reconcile-positions.sh
```

- [ ] **Broker vs Database**:
  - ✅ No OPEN positions at broker that are CLOSED in DB
  - ✅ No OPEN positions in DB that don't exist at broker
  - ✅ Position quantities match between broker and DB

- [ ] **Orphan Detection**:
  - ✅ No positions in OPENING state > 15 minutes old
  - ✅ No unfilled entry orders from previous session

- [ ] **OCO Protection**:
  - ✅ All OPEN positions have TP/SL legs at broker
  - ✅ No naked positions (server-side protection active)

**PASS** → Proceed to A6
**WARN** (orphan detected) → Run adoption script before market open
**FAIL** → Manual intervention required

---

### A6. Alert System Test (06:25)
```bash
./scripts/ops/test-alerts.sh
```

- [ ] **Notification Channels**:
  - ✅ Slack/Teams webhook delivers test message
  - ✅ Email alerts functional (if enabled)
  - ✅ PM2 bus notifications working

- [ ] **Alert Rules**:
  - ✅ Daily loss limit rule active
  - ✅ Max positions rule active
  - ✅ Cooldown rule active

**PASS** → Pre-market complete ✅
**FAIL** → Fix alert routing before proceeding

---

## SECTION B0: PRE-MARKET WARMUP (08:00-09:30 ET)
> **Goal**: Signal detection warmup with real data (no execution)

### B0.1: Start Warmup Mode (08:00 SHARP)
```bash
export AGENT_PAPER=true
pm2 start ecosystem.config.js --only event-handler
```

- [ ] **Handler Startup in WARMUP Mode**:
  - ✅ PM2 status: `online`
  - ✅ AGENT_PAPER=true (no real orders)
  - ✅ Logs showing: `Event-Driven Trading Handler starting...`
  - ✅ Logs showing: `INDEPENDENT MODE: No spxer dependency - all data from Tradier REST API`
  - ✅ No actual orders placed (paper mode)
  - ✅ Signal detection timer active

- [ ] **Signal Detection Architecture**:
  - ✅ Timer checks at :00 seconds of every minute
  - ✅ Fetching data from Tradier REST API (independent of spxer)
  - ✅ Computing HMA(3)×HMA(12) on 3m bars locally
  - ✅ Cross detection working: checks last 2 bars

- [ ] **Signal Detection Verification**:
  - ✅ Logs showing: `[handler] [config-id] CALL SIGNAL: BULLISH/BEARISH`
  - ✅ Or: `No cross detected - no signal would be sent`
  - ✅ Tradier API connectivity verified
  - ✅ Bars fetched and aggregated correctly

**PASS** → Warmup active, monitor until 09:30
**FAIL** → Check Tradier API, restart handler

---

### B0.2: Monitor Warmup Signals (08:00-09:30)
> **Passive monitoring - track what would have triggered**

Run every 15 minutes:
```bash
pm2 logs event-handler --nostream --lines 100 | grep -E "SIGNAL|Independent"
```

- [ ] **Signal Quality Check**:
  - ✅ Signals firing (not too many, not too few)
  - ✅ Strike band looks correct (centered)
  - ✅ No error spikes in logs
  - ✅ No connection errors to spxer (should not see any)

- [ ] **Independence Verification**:
  - ✅ Logs show `INDEPENDENT MODE: No spxer dependency`
  - ✅ No WebSocket connection errors to `localhost:3600`
  - ✅ Tradier REST API fetches working

- [ ] **Market Context**:
  - ✅ SPX pre-market trend makes sense
  - ✅ No gaps in data feed
  - ✅ Options data flowing (Tradier timesales)

- [ ] **At 09:25**:
  - ✅ Final warmup signal count: _______
  - ✅ Any anomalies noted: ___________
  - ✅ Ready for transition: YES / NO

**PASS** → Proceed to transition at 09:30
**WARN** → Investigate anomalies before transition
**FAIL** → Do NOT transition - run diagnosis

---

### B0.3: Transition to Live (09:30:00 SHARP)
```bash
# If transitioning from paper to live:
export AGENT_PAPER=false
pm2 restart event-handler --update-env

# If staying in paper mode:
# No action needed - already running
```

- [ ] **Handler Restart**:
  - ✅ Handler stopped cleanly
  - ✅ Handler restarted in target mode
  - ✅ Logs confirm new mode
  - ✅ No open positions (warmup doesn't open positions in paper mode)

- [ ] **LIVE Mode Only**:
  - ⚠️ **TWO-PERSON CONFIRMATION REQUIRED**
  - ✅ Warmup looked healthy
  - ✅ No unresolved errors
  - ✅ Emergency halt reviewed

**PASS** → Trading active 🚀
**FAIL** → Roll back to warmup, investigate

---

## SECTION B: MARKET OPEN PREPARATION (09:30-10:00 ET)
> **Goal**: First trades and initial monitoring

### B1. Start Position Monitor (09:30:30 SHARP)
```bash
pm2 start ecosystem.config.js --only position-monitor
```

- [ ] **Position Monitor Startup**:
  - ✅ PM2 status: `online`
  - ✅ Logs showing: `Position Monitor Service starting (OBSERVER MODE - no execution)...`
  - ✅ Logs showing: `INDEPENDENT MODE: Fetching from Tradier REST API (no spxer dependency)`
  - ✅ Observer only — no execution

**PASS** → Proceed to B2
**FAIL** → Check logs, restart position-monitor

---

### B2. First Trades Verification (09:35)
> **Wait 5 minutes for first signals to fire**

```bash
# Check for signals
pm2 logs event-handler --nostream --lines 50 | grep -E "SIGNAL|Position opened"

# Check positions
sqlite3 data/account.db "SELECT * FROM positions WHERE status IN ('OPEN', 'OPENING');"
```

- [ ] **Signal Flow**:
  - ✅ Timer triggers at :00 seconds
  - ✅ Signal detection fetches from Tradier (independent)
  - ✅ HMA cross detection working
  - ✅ Handler processing signals
  - ✅ First trades executed (if signals fired)

- [ ] **Position Tracking**:
  - ✅ Positions appearing in account.db
  - ✅ Bracket IDs populated
  - ✅ TP/SL legs created at broker

- [ ] **Fill Detection**:
  - ✅ Positions transitioning: OPENING → OPEN
  - ✅ No orphans stuck in OPENING

- [ ] **Independence Verification**:
  - ✅ No spxer dependency in logs
  - ✅ All Tradier fetches independent
  - ✅ position-monitor observing correctly

**PASS** → Proceed to ongoing monitoring
**WARN** (no signals yet) → Normal if quiet market
**FAIL** → Immediate investigation

---

### B3. Ongoing Monitoring (09:40-16:00)

- [ ] **Event Handler Independence**:
  - ✅ Logs show `INDEPENDENT MODE: No spxer dependency`
  - ✅ No WebSocket errors to `localhost:3600`
  - ✅ Tradier API fetches working
  - ✅ Signal detection timer firing

- [ ] **Position Monitor Independence**:
  - ✅ Logs show `OBSERVER MODE - no execution`
  - ✅ Fetching from Tradier REST API (independent)
  - ✅ Observing positions every 10 seconds
  - ✅ Logging exit conditions

- [ ] **Optional: Data Service** (if running spxer):
  - 🔵 Health endpoint responding (if running)
  - 🔵 Option stream connected (if running)

**PASS** → Continue monitoring
**WARN** → Escalate to Section D
**FAIL** → Execute halt procedure

---

### B4. Final Go/No-Go (09:25)
> **MANUAL CHECKPOINT — Human verification required**

- [ ] **Manual Review**:
  - ✅ Reviewed overnight news (Fed announcements, earnings)
  - ✅ No scheduled maintenance during market hours
  - ✅ Team alerted to live trading (if LIVE mode)

- [ ] **Independence Confirmation**:
  - ✅ Verified event-handler is independent of spxer
  - ✅ Verified position-monitor is independent of spxer
  - ✅ Live trading does NOT require spxer

- [ ] **Mode Confirmation**:
  - ✅ Paper/LIVE mode verified
  - ⚠️ If LIVE: **TWO-PERSON CONFIRMATION REQUIRED**
  - ✅ Emergency halt procedure reviewed

**GO** → Proceed to Section C
**NO-GO** → Execute emergency halt, investigate

---

## SECTION C: MARKET HOURS (09:30-16:00 ET)
> **Goal**: Monitor, detect anomalies, intervene only when necessary

### C1. First 30 Minutes Monitoring (09:30-10:00)
> **Critical period — highest signal frequency**

Run every 5 minutes:
```bash
./scripts/ops/monitor-active-trading.sh
```

- [ ] **Process Status**:
  - ✅ `event-handler`: RUNNING (signal detection + entries)
  - ✅ `position-monitor`: RUNNING (exit observation)
  - 🔵 `spxer`: RUNNING or STOPPED (optional — replay viewer only)

- [ ] **Signal Detection**:
  - ✅ Timer firing at :00 seconds (check logs)
  - ✅ Tradier API fetches working (independent)
  - ✅ HMA computation successful
  - ✅ Cross detection accurate

- [ ] **Signal Flow**:
  - ✅ Signals being logged: `[handler] [config-id] CALL/PUT SIGNAL`
  - ✅ Handler processing signals (no skips)
  - ✅ No dependency on spxer

- [ ] **Order Execution**:
  - ✅ Entry orders submitting (if signals firing)
  - ✅ Bracket IDs populated in DB
  - ✅ Position count ≤ `maxPositionsOpen`

- [ ] **Fill Detection**:
  - ✅ Account Stream receiving fill events
  - ✅ Positions transitioning: OPENING → OPEN
  - ✅ No orphaned positions stuck in OPENING

**PASS** → Continue monitoring
**WARN** (no signals yet) → Normal if quiet market
**FAIL** → Immediate investigation, check logs

---

### C2. Ongoing Monitoring (10:00-16:00)
> **Run every 15 minutes via cron**

```bash
*/15 10-15 * * 1-5 ./scripts/ops/monitor-active-trading.sh
```

- [ ] **Position Limits**:
  - ✅ Open positions ≤ `maxPositionsOpen`
  - ✅ Daily P&L > `-maxDailyLoss`
  - ✅ Trades completed today ≤ `maxTradesPerDay`

- [ ] **System Health**:
  - ✅ event-handler: online
  - ✅ position-monitor: online
  - 🔵 spxer: online or stopped (optional)
  - ✅ No error spikes in logs

- [ ] **Independence Verification**:
  - ✅ event-handler fetching from Tradier directly
  - ✅ position-monitor fetching from Tradier directly
  - ✅ No spxer dependency errors

**PASS** → All systems normal
**WARN** → Escalate to Section D
**FAIL** → Execute halt procedure

---

### C3. Anomaly Detection (Continuous)
> **Automated alerts via monitoring scripts**

**Alert Triggers**:
- ❌ Daily loss limit hit
- ❌ Position limit exceeded
- ❌ Fill timeout > 5 minutes (stuck in OPENING)
- ❌ Tradier API connection failures

**On Alert**:
1. Check logs: `pm2 logs event-handler --lines 100`
2. Check position-monitor: `pm2 logs position-monitor --lines 100`
3. Verify Tradier status: `curl -s https://api.tradier.com/v1/markets/quotes?symbols=SPX`
4. Manual intervention if automated recovery fails

---

### C4. Intervention Protocol (As Needed)
> **When something goes wrong during market hours**

**Level 1: Automatic Recovery** (script handles)
- Tradier API retry with backoff
- Orphan position adoption on startup
- AccountStream reconnection

**Level 2: Manual Intervention** (human action)
- Restart handler: `pm2 restart event-handler`
- Restart monitor: `pm2 restart position-monitor`
- Force close positions at broker (manual via Tradier UI)

**Level 3: Emergency Halt** (immediate action)
```bash
# IMMEDIATE:
pm2 stop event-handler
pm2 stop position-monitor

# Verify all positions closed at broker
# Manual review required to restart
```

---

## SECTION D: POST-MARKET CLOSE (16:00-16:30 ET)
> **Goal**: Reconciliation, archival, tomorrow's prep

### D1. Position Reconciliation (16:00 SHARP)
```bash
./scripts/ops/post-market-reconcile.sh
```

- [ ] **All Positions Closed**:
  - ✅ No OPEN positions remaining in DB
  - ✅ No OPEN positions at broker
  - ✅ No pending orders

- [ ] **Final P&L**:
  - ✅ Daily P&L fetched from broker
  - ✅ Matches DB calculated P&L (within tolerance)
  - ✅ Recorded in config_state table

- [ ] **Trade Journal**:
  - ✅ All trades logged to journal
  - ✅ Exit reasons populated
  - ✅ Performance metrics calculated

**PASS** → Proceed to D2
**FAIL** → Manual reconciliation required

---

### D2. Data Archival (16:10)
```bash
./scripts/ops/archive-day.sh
```

- [ ] **Parquet Export** (if spxer running):
  - 🔵 Live bars exported to parquet
  - 🔵 File size reasonable (~50-100MB)
  - 🔵 Schema validation passed

- [ ] **GDrive Upload** (if spxer running):
  - 🔵 Parquet uploaded to remote
  - 🔵 Backup verified
  - 🔵 Local cleanup (optional)

- [ ] **Signals Archive**:
  - ✅ Daily journal complete
  - ✅ account.db backed up

**PASS** → Proceed to D3
**WARN** → Retry archival, check storage space

---

### D3. Performance Review (16:20)
> **Automated report + manual review**

```bash
./scripts/ops/daily-report.sh > reports/2026-04-24.md
```

- [ ] **Metrics**:
  - ✅ Number of trades executed
  - ✅ Win rate for the day
  - ✅ Total P&L
  - ✅ Max drawdown

- [ ] **Anomalies**:
  - ✅ No rejected orders (investigate if any)
  - ✅ No stuck positions
  - ✅ No signal latency spikes
  - ✅ No spxer dependency issues

- [ ] **Manual Review** (human):
  - [ ] Review each trade's entry/exit logic
  - [ ] Note any market regime changes
  - [ ] Adjust config for tomorrow if needed

**PASS** → Proceed to D4
**WARN** → Document issues, create action items

---

### D4. Handler Shutdown (16:30)
```bash
pm2 stop event-handler
pm2 stop position-monitor
```

- [ ] **Graceful Shutdown**:
  - ✅ Handler stopped cleanly
  - ✅ Monitor stopped cleanly
  - ✅ No errors in shutdown logs

- [ ] **Process Cleanup**:
  - ✅ All open handles released
  - ✅ Memory freed
  - ✅ No zombie processes

**PASS** → Post-market complete ✅

---

## SECTION E: END-OF-DAY (16:30-17:00 ET)
> **Goal**: Prepare for tomorrow

### E1. Tomorrow's Setup (16:35)
```bash
./scripts/ops/prepare-tomorrow.sh
```

- [ ] **Config Validation**:
  - ✅ Tomorrow's configs loaded in DB
  - ✅ No breaking changes from today
  - ✅ Risk parameters still appropriate

- [ ] **Calendar Check**:
  - ✅ Tomorrow is a trading day
  - ✅ No early closes
  - ✅ No Fed announcements / high-impact events

- [ ] **Pre-Market Queue**:
  - ✅ Handler configured to auto-start at 09:00 (if enabled)
  - ✅ Monitoring scripts scheduled
  - ✅ Alert recipients notified

**PASS** → Ready for tomorrow ✅

---

### E2. Daily Sign-Off (16:50)
> **MANUAL CHECKPOINT — End of day**

- [ ] **Review Checklist**:
  - [ ] All sections completed
  - [ ] All FAIL/WARN items resolved
  - [ ] Tomorrow's prep complete
  - [ ] Independence verified (no spxer dependency issues)

- [ ] **Final Status**:
  - [ ] Overall status: ✅ PASS / ⚠️ WARN / ❌ FAIL
  - [ ] Action items for tomorrow: _____________
  - [ ] Notes / observations: _____________

**Signed**: ____________________
**Date**: ____________________
**Status**: ____________________

---

## EMERGENCY PROCEDURES

### Emergency Halt (Immediate)
```bash
# STOP TRADING:
pm2 stop event-handler
pm2 stop position-monitor

# VERIFY HALT:
pm2 status
# Should show both services stopped

# PROTECT POSITIONS:
# - Check broker for open positions
# - Manual TP/SL if needed
# - Do NOT restart without investigation
```

### Quick Restart (After Issue Resolved)
```bash
# 1. Verify fix applied
./scripts/ops/check-environment.sh

# 2. Restart handler
pm2 restart event-handler

# 3. Restart monitor
pm2 restart position-monitor

# 4. Verify independence
pm2 logs event-handler --lines 20 | grep "INDEPENDENT MODE"

# 5. Monitor first trade carefully
pm2 logs event-handler --lines 0
```

### Escalation Matrix
| Issue Severity | Response Time | Escalation |
|----------------|---------------|------------|
| WARN (yellow) | 15 minutes | Monitor, investigate if persists |
| FAIL (red) | 5 minutes | Immediate fix, consider halt |
| CRITICAL | Immediate | HALT, page on-call, full review |

---

## AUTOMATION SCRIPTS

### Cron Schedule
```bash
# Pre-market checks (06:00-06:30)
0 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/check-environment.sh
5 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/check-databases.sh
10 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/check-providers.sh
15 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/validate-configs.sh
20 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/reconcile-positions.sh
25 6 * * 1-5 /home/ubuntu/SPXer/scripts/ops/test-alerts.sh

# Pre-Market Warmup (08:00)
0 8 * * 1-5 export AGENT_PAPER=true && pm2 start ecosystem.config.js --only event-handler

# Transition to Live (09:30 SHARP)
30 9 * * 1-5 export AGENT_PAPER=false && pm2 restart event-handler --update-env

# Start Position Monitor (09:30:30)
30 9 * * 1-5 sleep 30 && pm2 start ecosystem.config.js --only position-monitor

# Active monitoring (every 15 min during market hours)
*/15 10-15 * * 1-5 /home/ubuntu/SPXer/scripts/ops/monitor-active-trading.sh

# Post-market (16:00-16:30)
0 16 * * 1-5 /home/ubuntu/SPXer/scripts/ops/post-market-reconcile.sh
10 16 * * 1-5 /home/ubuntu/SPXer/scripts/ops/archive-day.sh
20 16 * * 1-5 /home/ubuntu/SPXer/scripts/ops/daily-report.sh
30 16 * * 1-5 pm2 stop event-handler && pm2 stop position-monitor

# Tomorrow's prep (16:35)
35 16 * * 1-5 /home/ubuntu/SPXer/scripts/ops/prepare-tomorrow.sh
```

---

## CHECKLIST PHILOSOPHY

> **"In a complex environment, experts are up against two main difficulties:**
> **1. The fallibility of human memory and attention**
> **2. The possibility of skipped steps even when remembered"**

**This checklist exists to solve both problems.**

### Rules of Engagement:
1. **Never skip a section** — All sections are critical
2. **Document everything** — If you deviate, write why
3. **Two-person verification** for GO/NO-GO decisions in LIVE mode
4. **Emergency halt authority** — Anyone can call halt if CRITICAL issue detected
5. **Post-mortem required** — Any FAIL triggers investigation report
6. **Independence first** — Verify no spxer dependency issues

### Checklist Version: 2.0 (Independent Services)
### Last Updated: 2026-04-24
### Owner: SPXer Operations Team

---

*"The power of checklists is that they instill a discipline of higher performance, they catch mental lapses, and they make clear the minimum necessary steps for any procedure."* — Atul Gawande

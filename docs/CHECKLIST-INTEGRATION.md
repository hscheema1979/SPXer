# Daily Operations Checklist - Implementation Guide

## Overview

The SPXer Daily Operations Checklist is now **live and operational**. This system provides surgical precision for daily trading operations, inspired by aviation checklists and operating room procedures.

## Quick Start

### Run Full Daily Checklist
```bash
# From SPXER root directory
./scripts/ops/daily-checklist-runner.sh all
```

### Run Quick Health Check
```bash
./scripts/ops/daily-checklist-runner.sh quick
```

### Run Specific Section
```bash
# Pre-market only
./scripts/ops/daily-checklist-runner.sh pre

# Market open prep
./scripts/ops/daily-checklist-runner.sh open

# Active trading monitor
./scripts/ops/daily-checklist-runner.sh monitor
```

### Skip to Section
```bash
# Run all checks, but skip to section B3
./scripts/ops/daily-checklist-runner.sh all B3
```

## Automated Schedule

### Cron Configuration
```bash
# Edit crontab
crontab -e

# Add daily schedule:
# Pre-market checks (06:00-06:30)
0 6 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/daily-checklist-runner.sh pre >> logs/daily-pre-$(date +\%Y\%m\%d).log 2>&1

# Handler startup (09:00)
0 9 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/daily-checklist-runner.sh open >> logs/daily-open-$(date +\%Y\%m\%d).log 2>&1

# Active monitoring (every 15 min during market hours)
*/15 10-15 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/monitor-active-trading.sh >> logs/monitor-$(date +\%Y\%m\%d).log 2>&1

# Post-market (16:00)
0 16 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/daily-checklist-runner.sh close >> logs/daily-close-$(date +\%Y\%m\%d).log 2>&1

# End of day (16:35)
35 16 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/daily-checklist-runner.sh eod >> logs/daily-eod-$(date +\%Y\%m\%d).log 2>&1
```

## Manual Checklist Walkthrough

### Phase 1: Pre-Market (06:00-08:00 ET)
**Goal**: System integrity before market activity

1. **06:00** - Environment Check
   ```bash
   ./scripts/ops/check-environment.sh
   ```
   - ✅ Verify it's a weekday
   - ✅ Check disk space, memory, CPU
   - ✅ Confirm data service running

2. **06:05** - Database Integrity
   ```bash
   ./scripts/ops/check-databases.sh
   ```
   - ✅ No corruption in live DB
   - ✅ No orphaned positions
   - ✅ Previous day's archive complete

3. **06:10** - Provider Health
   ```bash
   ./scripts/ops/check-providers.sh
   ```
   - ✅ Data service API healthy
   - ✅ Tradier token valid
   - ✅ ThetaData connected

4. **06:15** - Config Validation
   ```bash
   ./scripts/ops/validate-configs.sh
   ```
   - ✅ Active configs exist in DB
   - ✅ Risk parameters reasonable
   - ✅ Execution mode set correctly

5. **06:20** - Position Reconciliation
   ```bash
   ./scripts/ops/reconcile-positions.sh
   ```
   - ✅ No orphaned positions from previous session
   - ✅ Broker vs DB sync

6. **06:25** - Alert System Test
   ```bash
   ./scripts/ops/test-alerts.sh
   ```
   - ✅ Slack/webhook alerts working
   - ✅ All alert rules active

### Phase 2: Market Open (09:00-09:30 ET)
**Goal**: Signal pipeline ready for first trades

1. **09:00** - Handler Startup
   ```bash
   ./scripts/ops/start-handler.sh
   ```
   - ⚠️ **LIVE MODE**: Requires two-person confirmation
   - ✅ PM2 starts handler
   - ✅ WebSocket connects
   - ✅ Subscriptions active

2. **09:10** - Data Quality Check
   ```bash
   ./scripts/ops/check-data-quality.sh
   ```
   - ✅ SPX data fresh (< 60s old)
   - ✅ Option stream connected
   - ✅ 150-300 contracts tracked

3. **09:15** - Signal Pipeline Test
   ```bash
   ./scripts/ops/test-signal-pipeline.sh
   ```
   - ✅ Signals endpoint working
   - ✅ HMA values computed

4. **09:25** - Final GO/NO-GO
   ```bash
   ./scripts/ops/final-go-check.sh
   ```
   - ✅ Manual review complete
   - ✅ Emergency halt procedure reviewed
   - ✅ **TWO-PERSON CONFIRMATION** (LIVE mode)

### Phase 3: Market Hours (09:30-16:00 ET)
**Goal**: Monitor, detect anomalies, intervene only when necessary

1. **Every 15 minutes** - Active Monitor
   ```bash
   ./scripts/ops/monitor-active-trading.sh
   ```
   - ✅ System health OK
   - ✅ Position limits not exceeded
   - ✅ No errors in recent logs
   - ✅ Daily P&L within limits

2. **On Alert** - Intervention Protocol
   - **Level 1**: Automatic recovery (scripts handle)
   - **Level 2**: Manual intervention (restart handler, toggle configs)
   - **Level 3**: Emergency halt (`pm2 stop event-handler`)

### Phase 4: Post-Market (16:00-16:30 ET)
**Goal**: Reconciliation, archival, tomorrow's prep

1. **16:00** - Position Reconciliation
   ```bash
   ./scripts/ops/post-market-reconcile.sh
   ```
   - ✅ All positions closed
   - ✅ Final P&L fetched
   - ✅ Trade journal complete

2. **16:10** - Data Archival
   ```bash
   ./scripts/ops/archive-day.sh
   ```
   - ✅ Parquet export complete
   - ✅ GDrive upload verified

3. **16:20** - Daily Report
   ```bash
   ./scripts/ops/daily-report.sh
   ```
   - ✅ Performance metrics calculated
   - ✅ Anomalies documented

4. **16:30** - Handler Shutdown
   ```bash
   ./scripts/ops/shutdown-handler.sh
   ```
   - ✅ Handler stopped cleanly
   - ✅ No zombie processes

### Phase 5: End of Day (16:30-17:00 ET)
**Goal**: Prepare for tomorrow

1. **16:35** - Tomorrow's Setup
   ```bash
   ./scripts/ops/prepare-tomorrow.sh
   ```
   - ✅ Configs validated
   - ✅ Calendar checked
   - ✅ Auto-start configured

2. **16:50** - Daily Sign-Off
   ```bash
   ./scripts/ops/daily-signoff.sh
   ```
   - ✅ All sections reviewed
   - ✅ Action items noted
   - ✅ Status: PASS/FAIL documented

## Script Status

### ✅ Fully Implemented
- `check-environment.sh` - Environment verification
- `start-handler.sh` - Handler startup with mode confirmation
- `monitor-active-trading.sh` - Active trading monitor
- `daily-checklist-runner.sh` - Master runner script

### ⚠️ Placeholder (TODO)
- `check-databases.sh` - Database integrity checks
- `check-providers.sh` - Provider health verification
- `validate-configs.sh` - Config validation
- `reconcile-positions.sh` - Position reconciliation
- `test-alerts.sh` - Alert system test
- `check-data-quality.sh` - Data quality verification
- `test-signal-pipeline.sh` - Signal pipeline test
- `final-go-check.sh` - Final GO/NO-GO checkpoint
- `post-market-reconcile.sh` - Post-market reconciliation
- `archive-day.sh` - Data archival
- `daily-report.sh` - Daily performance report
- `shutdown-handler.sh` - Handler shutdown
- `prepare-tomorrow.sh` - Tomorrow's setup
- `daily-signoff.sh` - Daily sign-off

## Integration with Existing Systems

### PM2 Integration
```bash
# Check handler status
pm2 status event-handler

# View logs
pm2 logs event-handler

# Restart handler
pm2 restart event-handler
```

### HTTP API Integration
```bash
# Quick health check
curl -s http://localhost:3600/health | jq .

# Simulation status
curl -s http://localhost:3600/agent/simulation | jq .

# Execution mode
curl -s http://localhost:3600/agent/mode | jq .
```

## Daily Operations Log

All checklist runs are logged:
```
logs/
├── daily-pre-20260424.log    # Pre-market checks
├── daily-open-20260424.log   # Market open prep
├── monitor-20260424.log      # Active monitoring
├── daily-close-20260424.log  # Post-market
└── daily-eod-20260424.log    # End of day
```

## Escalation Matrix

| Status | Action | Timeline |
|--------|--------|----------|
| ✅ PASS | Continue | Immediate |
| ⚠️ WARN | Monitor | 15 min |
| ❌ FAIL (1) | Investigate | 5 min |
| ❌ FAIL (2+) | Halt | Immediate |
| ❌ CRITICAL | Emergency halt | Immediate |

## Next Steps

1. **Implement remaining placeholder scripts**
   - Prioritize: check-databases, check-providers, reconcile-positions
   - Use existing PM2 and HTTP API endpoints

2. **Set up cron schedule**
   - Add automated checks to crontab
   - Configure log rotation

3. **Integrate with alerting**
   - Add Slack webhook integration
   - Configure email alerts for FAIL status

4. **Document runbook**
   - Create troubleshooting guide for common failures
   - Document emergency procedures

5. **Test full cycle**
   - Run complete checklist on next trading day
   - Verify all sections execute correctly
   - Refine timing and dependencies

## Philosophical Notes

> **"Checklists are not recipes. They don't tell you how to solve a problem. They simply remind you to do the right things at the right time."**

This checklist system exists to:
- **Prevent failures** through systematic verification
- **Catch errors** early through redundant checks
- **Standardize operations** across team members
- **Enable automation** of routine procedures
- **Provide discipline** for high-stakes trading

The checklist is **living documentation** — update it as systems evolve and new failure modes are discovered.

---

**Version**: 1.0
**Last Updated**: 2026-04-24
**Status**: ✅ Operational (partial implementation)

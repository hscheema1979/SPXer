# 08:00 AM ET Staged Pre-Market Automation

## Overview

SPXer now supports **staged pre-market verification** — 17 tiers of checks spread across the pre-market window (06:00-08:00 AM ET) to ensure surgical precision before trading begins.

## Philosophy: Two-Tier Verification

Each check follows the "pressure sensor" philosophy:
1. **Tool Functionality** — "Can we measure?"
2. **The Reading** — "What does it say?"

Example:
- ✅ "Is the Tradier API token set?" (Tier 1)
- ✅ "Can we reach Tradier?" (Tier 1)
- ✅ "What's the account balance?" (Tier 12)

## Timeline

```
06:00 AM ET ── Early Infrastructure (Tiers 1-5)
             ── Tool functionality, readings, calculations, signal logic, config
             ── Scripts: check-early-infrastructure.sh
             ── Can run while data service is warming up

07:00 AM ET ── Data Pipeline (Tiers 6-10)
             ── System visibility, E2E pipeline, state reconciliation, freshness, acceptance
             ── Scripts: check-data-pipeline.sh
             ── Requires data service to be actively collecting

07:50 AM ET ── Pre-Market Validation (Tiers 11-17)
             ── Market state, financial, time decay, network, data quality, human, regulatory
             ── Scripts: check-pre-market-validation.sh
             ── Must run right before warmup for current market conditions

08:00 AM ET ── Warmup Phase 1 Starts
             ── All checks passed, signal tracking begins
             ── Scripts: start-warmup-with-checklist.sh
             ── WARMUP mode: tracks signals on backfilled data

09:30 AM ET ── Market Open (still in WARMUP)
             ── Trading begins, but still tracking only

09:42 AM ET ── First Valid HMA(12)
             ── 12 bars after open → HMA(12) becomes valid
             ── First possible HMA(3)×HMA(12) cross on TODAY'S data

09:42-10:00 AM ET ── Warmup Phase 2
                  ── Track REAL signals on today's data
                  ── Verify signal quality, no opening artifacts

10:00 AM ET ── Transition to SIMULATION/LIVE
             ── Switch to SIMULATION/LIVE mode
             ── Scripts: transition-from-warmup.sh
             ── Actual trading begins (on validated signals)
```

## The 17 Tiers

### Phase 1: Early Infrastructure (06:00 AM ET)

**Tier 1: Tool Functionality** — "Can we measure?"
- Data service reachable on port 3600
- Database files exist
- Tradier API token set
- Provider connections (ThetaData/Tradier)

**Tier 2: The Reading** — "What does it say?"
- SPX underlying price
- SPX indicators (HMA, RSI)
- Active contracts count
- Latest signal

**Tier 3: Calculation Verification** — "Are calculations right?"
- HMA values in reasonable range (not NaN, not extreme)
- RSI in valid range (0-100)
- Strike band centered around SPX

**Tier 4: Signal Logic** — "Are signals valid?"
- Signal detection active in data service
- HMA pairs configured (HMA 3×12)

**Tier 5: Configuration** — "Is config right?"
- AGENT_CONFIG_ID set and exists in DB
- Execution mode (WARMUP/SIMULATION/PAPER/LIVE)
- Account ID set

### Phase 2: Data Pipeline (07:00 AM ET)

**Tier 6: System Visibility** — "Can we see everything?"
- HTTP API endpoints responding
- Log files writable

**Tier 7: E2E Pipeline** — "Does it work end-to-end?"
- SPX data flow (bars available)
- Contract bars flow

**Tier 8: State Reconciliation** — "Does state match reality?"
- Database integrity checks
- Position reconciliation (DB vs broker)

**Tier 9: Freshness** — "Is data current?"
- SPX data age (< 2 min = good, < 10 min = acceptable)
- Provider last poll timestamp

**Tier 10: Acceptance** — "Should we trade?"
- No critical errors
- System GO/NO-GO decision

### Phase 3: Pre-Market Validation (07:50 AM ET)

**Tier 11: Market State** — "Is market open?"
- Day of week (weekday confirmed)
- Market time (pre-market window)
- Market holiday check (hardcoded 2026 holidays)

**Tier 12: Financial State** — "Can we trade?"
- Account DB exists
- Daily loss limit configured

**Tier 13: Time Decay** — "Is clock working against us?"
- Days to expiry (0DTE confirmed)
- Time until market close (hours/minutes)

**Tier 14: Network/Connectivity** — "Is link up?"
- Tradier API reachable (ping test)
- DNS resolution working

**Tier 15: Data Quality** — "Is data clean?"
- No stale data (recent bars continuous)
- No anomalous prices (SPX in sane range 4000-8000)

**Tier 16: Human Readiness** — "Is trader ready?"
- No manual trading halt (`.trading-halt` file check)
- Alerting configured (Slack webhook)

**Tier 17: Regulatory/Compliance** — "Are we legal?"
- Account type: Margin (6YA51425)
- Position limits configured

## Quick Start

### 1. Install Automation

```bash
cd /home/ubuntu/SPXer

# Install staged cron jobs (SIMULATION mode by default)
./scripts/ops/setup-8am-automation.sh

# Or specify target mode
./scripts/ops/setup-8am-automation.sh --target-mode LIVE

# Or manual reminders (not automatic)
./scripts/ops/setup-8am-automation.sh --manual
```

### 2. Verify Installation

```bash
# Check crontab
crontab -l | grep SPXer

# Verify scripts are executable
ls -l scripts/ops/check-*.sh
ls -l scripts/ops/start-warmup-with-checklist.sh
```

### 3. Test Manually

```bash
# Test each phase
./scripts/ops/check-early-infrastructure.sh    # 06:00 AM ET
./scripts/ops/check-data-pipeline.sh          # 07:00 AM ET
./scripts/ops/check-pre-market-validation.sh  # 07:50 AM ET
./scripts/ops/start-warmup-with-checklist.sh  # 08:00 AM ET
```

### 4. Monitor Logs

```bash
# Real-time monitoring
tail -f logs/cron-0600-$(date +%Y%m%d).log  # 06:00 checks
tail -f logs/cron-0700-$(date +%Y%m%d).log  # 07:00 checks
tail -f logs/cron-0750-$(date +%Y%m%d).log  # 07:50 checks
tail -f logs/cron-0800-$(date +%Y%m%d).log  # 08:00 warmup
tail -f logs/cron-0930-$(date +%Y%m%d).log  # 09:30 transition
```

## Manual Operation

If you prefer manual control, run the scripts yourself:

```bash
# 06:00 AM ET - Early checks
./scripts/ops/check-early-infrastructure.sh

# 07:00 AM ET - Data pipeline
./scripts/ops/check-data-pipeline.sh

# 07:50 AM ET - Pre-market validation
./scripts/ops/check-pre-market-validation.sh

# 08:00 AM ET - Start warmup (runs final validation first)
./scripts/ops/start-warmup-with-checklist.sh

# 09:30 AM ET - Transition to live
./scripts/ops/transition-from-warmup.sh
```

## Troubleshooting

### Checklist Fails at 06:00 AM ET

**Common causes:**
- Data service not running
- Database files missing
- API tokens not set

**Fix:**
```bash
pm2 start spxer
pm2 logs spxer --lines 50
```

### Checklist Fails at 07:00 AM ET

**Common causes:**
- Data service not collecting data
- Database corruption
- Stale data

**Fix:**
```bash
# Check data freshness
curl -s http://localhost:3600/health | jq .

# Check database integrity
sqlite3 data/spxer.db "PRAGMA integrity_check"
```

### Checklist Fails at 07:50 AM ET

**Common causes:**
- Network connectivity issues
- Market holiday
- Manual trading halt file

**Fix:**
```bash
# Check network
ping api.tradier.com

# Remove trading halt if present
rm -f .trading-halt
```

### Warmup Fails at 08:00 AM ET

**Common causes:**
- Previous checks failed
- Handler won't start
- WebSocket connection issues

**Fix:**
```bash
# Check PM2 status
pm2 status

# Check handler logs
pm2 logs event-handler --lines 50

# Manual restart
export AGENT_EXECUTION_MODE=WARMUP
pm2 start event-handler --update-env
```

### Transition Fails at 09:30 AM ET

**Common causes:**
- Handler not running
- Mode switch fails
- WebSocket reconnect issues

**Fix:**
```bash
# Manual transition
export WARMUP_TARGET_MODE=SIMULATION
./scripts/ops/transition-from-warmup.sh

# Or manual mode switch
pm2 stop event-handler
export AGENT_EXECUTION_MODE=SIMULATION
pm2 start event-handler --update-env
```

## Removing Automation

### Remove Cron Jobs

```bash
# Edit crontab
crontab -e

# Delete SPXer entries (lines with "SPXer Staged Pre-Market Automation")

# Save and exit
```

### Restore Old Crontab

```bash
# Find backup file
ls -lt ~/spxer-crontab-backup-*

# Restore
crontab ~/spxer-crontab-backup-YYYYMMDD-HHMMSS
```

## Customization

### Change Target Mode

```bash
# Re-run setup with different mode
./scripts/ops/setup-8am-automation.sh --target-mode LIVE

# Or edit crontab directly
crontab -e
# Change WARMUP_TARGET_MODE=SIMULATION to WARMUP_TARGET_MODE=LIVE
```

### Adjust Timing

```bash
# Edit crontab
crontab -e

# Example: Run 06:00 checks at 05:30 instead
# Change: 0 6 * * 1-5 ...
# To: 30 5 * * 1-5 ...
```

### Add Custom Checks

Create custom scripts and add them to the timeline:

```bash
# Create custom check
cat > scripts/ops/check-custom.sh << 'EOF'
#!/bin/bash
# Your custom verification logic
EOF

chmod +x scripts/ops/check-custom.sh

# Add to crontab
crontab -e
# Add: 15 7 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/check-custom.sh >> logs/cron-custom-$(date +\%Y\%m\%d).log 2>&1
```

## Related Documentation

- [Pre-Market Warmup](./PRE-MARKET-WARMUP.md) — Warmup architecture and usage
- [Daily Operations Checklist](../DAILY-OPS-CHECKLIST.md) — Full procedures
- [Event-Driven Handler](../docs/EVENT_HANDLER_ARCHITECTURE.md) — Handler architecture

---

**Version**: 1.0
**Last Updated**: 2026-04-24
**Status**: ✅ Operational

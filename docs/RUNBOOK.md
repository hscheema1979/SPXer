# SPXer Operations Runbook

Last updated: 2026-04-17

---

## 1. Quick Reference Card

### Emergency Stops

```bash
# STOP all trading immediately (agents only, data pipeline keeps running)
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop both

# STOP everything including data pipeline
pm2 stop all

# Nuclear option: kill PM2 daemon entirely
pm2 kill
```

### Safe Restarts

```bash
# Restart SPX agent (pauses monitor, stops, starts, verifies, unpauses)
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# Restart data pipeline (agents depend on it -- restart agents after)
pm2 restart spxer

# Restart dashboard / replay viewer
pm2 restart spxer-dashboard
pm2 restart replay-viewer
```

### Quick Diagnostics

```bash
# Full system overview (processes, pipeline, agents, DB, alerts — one screen)
./scripts/spxer-ctl status

# Pipeline deep dive: providers, bars, indicators, circuit breakers
./scripts/spxer-ctl pipeline

# Agent detail: positions, P&L, heartbeats, recent activity
./scripts/spxer-ctl agents

# Health check (exit 0/1 — use in scripts)
./scripts/spxer-ctl check

# Recent errors across all processes
./scripts/spxer-ctl errors

# Database stats
./scripts/spxer-ctl db

# Tail logs for a specific process
./scripts/spxer-ctl logs agent    # spxer|agent|monitor|dashboard|viewer|all

# Check data service directly
curl -s http://localhost:3600/health | python3 -m json.tool

# Check open positions at broker
curl -s http://localhost:3600/agent/status | python3 -m json.tool

# Pause/resume trading (sets maintenance mode)
bash /home/ubuntu/SPXer/scripts/ops.sh pause "reason here"
bash /home/ubuntu/SPXer/scripts/ops.sh resume
```

### Key URLs

| Service | URL |
|---------|-----|
| Data API (local) | http://localhost:3600 |
| Health endpoint | http://localhost:3600/health |
| Dashboard (local) | http://localhost:3602 |
| Replay viewer (local) | http://localhost:3601 |
| Dashboard (public) | https://bitloom.cloud/spxer/dashboard/ |
| Replay viewer (public) | https://bitloom.cloud/replay/ |
| WebSocket | ws://localhost:3600/ws |

---

## 2. System Architecture

### Component Map

```
                     Internet
                        |
              VPS5 (51.81.34.78)
              nginx reverse proxy
                   |
        Tailscale tunnel (100.72.152.122)
                   |
          VPS3 (137.74.117.1) -- this machine
                   |
    +--------------+--------------+
    |              |              |
 :3600         :3601          :3602
 spxer      replay-viewer   dashboard
 (data)       (backtest)     (live UI)
    |
    +----> SQLite (data/spxer.db, WAL mode, 39GB)
    |
    +----> ThetaData local terminal (OPRA options WS, primary)
    |          ws://127.0.0.1:25520/v1/events
    |
    +----> Tradier API (SPX timesales + options WS standby + order execution)
    |
    +----> TradingView screener (context: ES, NQ, VX, sectors)
```

### Live Data Sources (roles + failure modes)

| Source | Role | Failure mode |
|--------|------|--------------|
| ThetaData WS | Options live (primary) | Tradier WS takes over instantly — no agent impact |
| Tradier WS | Options live (cold standby) | Theta keeps flowing — no impact |
| Tradier REST timesales | SPX underlying (only source) | Health-gate halts agent entries — safe stop |
| Tradier orders | Execution (only source) | Agent halts on submission failure |
| Polygon | SPX historical backfill only | Zero live impact; can't seed new replay dates |

Theta/Tradier switch is pure connection-state (`thetaIsPrimary()` in `src/index.ts` returns `thetaStream.isConnected()`). No hysteresis. Option stream wakes once at 09:22 ET with the ±100 band centered on pre-market SPX price — single subscribe event, no 9:30 re-lock.

### PM2 Processes

| Process | Port | autorestart | Role |
|---------|------|-------------|------|
| `spxer` | 3600 | true | Data pipeline, REST API, WebSocket |
| `spxer-agent` | -- | **false** | SPX 0DTE trading (margin account 6YA51425) |
| `spxer-dashboard` | 3602 | true | Live dashboard UI |
| `replay-viewer` | 3601 | true | Replay/backtest viewer UI |
| `schwaber` | -- | false | Schwab ETF agent (separate system) |

**Current state**: SPX agent is active.

### Process Dependencies

```
spxer (data pipeline) <-- MUST be running first
  |
  +-- spxer-agent (polls data service each cycle)
  +-- spxer-dashboard (proxies to data service)
```

If `spxer` goes down, agents cannot get market data. They will log errors but existing broker-side OCO bracket orders remain active.

### Data Flow

```
ThetaData WS (primary) ┐
Tradier WS (standby)   ├─> spxer pipeline --> SQLite bars table
Tradier REST (SPX)     │                  --> REST API --> agents poll each cycle
TradingView screener   ┘                  --> WebSocket --> dashboard/monitors

Agent cycle: poll snapshot --> detectSignals() --> evaluateEntry/Exit --> Tradier orders
```

---

## 3. Daily Operations Checklist

### Pre-Market (9:00 AM ET)

```bash
# 1. Check all processes are online
bash /home/ubuntu/SPXer/scripts/ops.sh status

# 2. Verify data pipeline is healthy and receiving data
curl -s http://localhost:3600/health | python3 -c "
import sys, json; h=json.load(sys.stdin)
print(f'Status: {h[\"status\"]}  Mode: {h[\"mode\"]}  SPX: {h.get(\"lastSpxPrice\",\"none\")}')
for n,p in h.get('providers',{}).items():
    print(f'  {n}: healthy={p[\"healthy\"]} stale={p.get(\"staleSec\",0)}s')
"

# 3. Check no leftover maintenance mode
cat /home/ubuntu/SPXer/logs/agent-maintenance.json 2>/dev/null || echo "No maintenance file"

# 4. Verify agent config is correct
bash /home/ubuntu/SPXer/scripts/ops.sh config show hma3x15-itm5-tp125x-sl25-3m-v3

# 5. Check disk space (DB is 39GB and growing)
df -h / | tail -1

# 6. Check for overnight errors
bash /home/ubuntu/SPXer/scripts/ops.sh errors
```

If today is a **market holiday** (see `src/config.ts` MARKET_HOLIDAYS):
```bash
# Stop agents -- they should not trade
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop both
```

### During RTH (9:30 AM - 4:00 PM ET) -- Spot Checks

```bash
# Quick health check (run every 30-60 min or when alerted)
bash /home/ubuntu/SPXer/scripts/ops.sh agents

# Check pipeline counters for anomalies
bash /home/ubuntu/SPXer/scripts/ops.sh pipeline

# If something looks wrong, check recent logs
bash /home/ubuntu/SPXer/scripts/ops.sh logs agent
```

**Do not restart agents during RTH unless there is a confirmed problem.** Restarts cause the agent to re-reconcile positions from the broker, which takes ~10 seconds. During volatile markets this gap matters.

### Post-Market (4:30 PM ET)

```bash
# 1. Check final P&L and positions
bash /home/ubuntu/SPXer/scripts/ops.sh agents

# 2. Verify no orphaned positions at broker
# (Check Tradier dashboard or agent status files)
cat /home/ubuntu/SPXer/logs/agent-status-spx.json | python3 -m json.tool

# 3. Review any errors from the session
bash /home/ubuntu/SPXer/scripts/ops.sh errors

# 4. Check DB size / WAL growth
bash /home/ubuntu/SPXer/scripts/ops.sh db
```

### Weekend

```bash
# Agents are idle (no 0DTE contracts on weekends)
# Good time for maintenance:

# 1. Check disk usage
du -sh /home/ubuntu/SPXer/data/spxer.db
df -h /

# 2. WAL checkpoint (if WAL is large)
sqlite3 /home/ubuntu/SPXer/data/spxer.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 3. Review PM2 restart counts -- high counts indicate instability
pm2 list

# 4. Run any pending code deploys (see section 5)
```

---

## 4. Incident Playbooks

---

### 4.1 Agent Crash Mid-Position

**Detection**: PM2 shows agent as `stopped` or `errored`. NTFY notification.

**Assessment**:
```bash
# What state is the agent in?
pm2 show spxer-agent
bash /home/ubuntu/SPXer/scripts/ops.sh agents

# Check last agent logs for crash cause
pm2 logs spxer-agent --lines 100 2>&1 | tail -100

# Check if positions exist at broker (agent status file may be stale)
cat /home/ubuntu/SPXer/logs/agent-status-spx.json | python3 -m json.tool
```

**Response**:

The broker-side OCO bracket orders (TP + SL) are still active even if the agent crashes. Positions are protected. Do NOT panic.

```bash
# If during RTH and you want the agent running:
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# The agent will:
# 1. Reconcile open positions from broker
# 2. Submit missing OCO protection for any orphaned positions
# 3. Resume normal trading cycle
```

If the crash was caused by a bug, do NOT restart blindly. Fix the bug first or stop the agent until after hours.

```bash
# If you want to leave positions to broker OCO protection:
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop spx
# Positions will hit TP or SL at broker. Monitor in Tradier dashboard.
```

**Recovery**: Agent auto-reconciles on startup. No manual intervention needed for position state.

**Post-mortem**: Check `~/.pm2/logs/spxer-agent-error.log` for the stack trace. Common causes: OOM (check `max_memory_restart: 512M`), unhandled promise rejection, Tradier API timeout.

---

### 4.2 Data Pipeline Down/Degraded

**Detection**: `curl -s http://localhost:3600/health` returns error or `status: degraded`. Agents log data fetch failures.

**Assessment**:
```bash
bash /home/ubuntu/SPXer/scripts/ops.sh health
pm2 show spxer
pm2 logs spxer --lines 50 2>&1 | tail -50
```

**Response**:
```bash
# If the process crashed, it auto-restarts (autorestart: true)
# Check if it's in a restart loop:
pm2 show spxer | grep restarts

# If stuck, manual restart:
pm2 restart spxer

# If degraded (one provider down but others working):
# Usually self-healing. Tradier has circuit breakers.
# Monitor for 5 minutes before intervening.
```

**Impact on agents**: Agents poll the data service each cycle. If the data service is unreachable, agents cannot detect signals. Existing positions are protected by broker OCO orders. No new trades will be entered.

**Recovery**: Data pipeline re-seeds indicators on restart (~2-3 minutes of warmup before indicators are valid). Agents will resume once data is flowing.

---

### 4.3 Orphaned Positions (No Agent Running, Positions Open)

**Detection**: Agent status shows stopped, but Tradier account has open positions.

**Assessment**:
```bash
# Check what's open at broker
cat /home/ubuntu/SPXer/logs/agent-status-spx.json | python3 -m json.tool

# If status file is stale, check Tradier directly via data service
curl -s http://localhost:3600/agent/status | python3 -m json.tool
```

**Response**:

Option 1 -- Restart the agent (it will adopt the positions):
```bash
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx
# Agent calls positions.reconcileFromBroker() on startup
# Submits missing OCO brackets if needed
```

Option 2 -- Let broker OCO handle it (positions have TP/SL):
```bash
# Do nothing. Broker will execute TP or SL.
# Monitor via Tradier dashboard.
```

Option 3 -- Manual close (if no OCO protection exists):
```bash
# Use Tradier dashboard to manually close the position
# This is the nuclear option -- only if bracket orders are missing
```

---

### 4.4 Orphaned OCO Orders (Agent Stopped, Bracket Orders Still Active)

**Detection**: After stopping an agent, Tradier shows pending OCO orders but the position was already closed or the agent was stopped intentionally.

**Assessment**:
```bash
# Check Tradier for open orders via the API or Tradier dashboard
# The data service proxies this:
curl -s http://localhost:3600/agent/status
```

**Response**: Orphaned OCO orders are **not dangerous** -- they are attached to a position. If the position is closed, the OCO orders are automatically cancelled by Tradier. If the position is still open, the OCO orders provide protection.

**DO NOT** manually cancel OCO orders unless you are certain the associated position is closed. The watchdog was disabled precisely because it was cancelling OCO orders and leaving positions unprotected.

---

### 4.5 SQLite Locked / WAL Bloat

**Detection**: Agent or data service logs show `SQLITE_BUSY` or `database is locked`. WAL file grows beyond 200MB.

**Assessment**:
```bash
# Check WAL size
ls -lh /home/ubuntu/SPXer/data/spxer.db-wal

# Check DB stats
bash /home/ubuntu/SPXer/scripts/ops.sh db

# Check for long-running queries
# (SQLite WAL auto-checkpoints at 1000 pages, configured in code)
```

**Response**:
```bash
# Force WAL checkpoint (safe while running -- WAL mode allows concurrent reads)
sqlite3 /home/ubuntu/SPXer/data/spxer.db "PRAGMA wal_checkpoint(TRUNCATE);"

# If locked: identify competing writers
# Only one process should write to spxer.db (the data pipeline)
# Agents read via the REST API, not directly
fuser /home/ubuntu/SPXer/data/spxer.db 2>/dev/null
```

If WAL bloat is chronic:
```bash
# The wal_autocheckpoint is set to 1000 pages in code
# If it's not working, restart the data pipeline:
pm2 restart spxer
```

---

### 4.6 Tradier API Outage

**Detection**: Health endpoint shows Tradier provider as unhealthy. Agent logs show order submission failures.

**Assessment**:
```bash
bash /home/ubuntu/SPXer/scripts/ops.sh health
# Check Tradier status: https://status.tradier.com
```

**Response**:

For data outage (no quotes):
- Yahoo provides ES=F overnight data as fallback
- During RTH, SPX timesales come from Tradier only -- no fallback
- Agents cannot trade without price data. Existing positions are protected by broker OCO.
- **Do not restart agents** -- they will just fail faster

For order execution outage:
- **Stop agents immediately** to prevent order submission errors
```bash
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop both
```
- Existing bracket orders at Tradier still execute (they are server-side)
- Wait for Tradier to recover, then restart agents

**Recovery**: Restart agents after Tradier confirms resolution. Agents will reconcile positions on startup.

---

### 4.7 Position Without Bracket Protection

**Detection**: Manual inspection reveals a position missing OCO orders.

**Assessment**:
```bash
# Check agent status for position details
cat /home/ubuntu/SPXer/logs/agent-status-spx.json | python3 -m json.tool
```

**Response**:
```bash
# Fastest fix: restart the agent -- it reconciles and submits missing OCO
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# If agent cannot be restarted: manually set TP/SL in Tradier dashboard
# Or manually close the position in Tradier dashboard
```

This is a **high-urgency** incident during RTH. An unprotected position has unlimited downside on 0DTE options.

---

### 4.8 Disk Full

**Detection**: Processes crash with write errors. `df -h /` shows >95% usage.

**Assessment**:
```bash
df -h /
du -sh /home/ubuntu/SPXer/data/*
du -sh ~/.pm2/logs/*
du -sh /home/ubuntu/SPXer/logs/*
```

**Response**:
```bash
# 1. Clear PM2 logs (biggest quick win)
pm2 flush

# 2. Truncate old application logs
> /home/ubuntu/SPXer/logs/claude-monitor.log

# 3. If DB is the problem, archive old data
# (see Database Maintenance in section 5)

# 4. Check for core dumps or tmp files
find /tmp -maxdepth 1 -user ubuntu -size +10M -ls 2>/dev/null
```

**Prevention**: The DB is 39GB and growing. Set up periodic archival of expired contract data to parquet/GDrive.

---

### 4.9 OOM / Memory Leak

**Detection**: PM2 shows `max_memory_restart` triggered (check restart count). Process restarts frequently.

**Assessment**:
```bash
pm2 show spxer | grep -E "restarts|memory|status"
pm2 show spxer-agent | grep -E "restarts|memory|status"

# Check current memory usage
pm2 list
```

**Response**:
```bash
# For data pipeline (max 1GB):
pm2 restart spxer
# Indicator state is rebuilt from DB on restart (~2-3 min warmup)

# For agents (max 512MB):
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx
# Agent reconciles from broker on restart

```

**Known causes**: 
- Replay processes loading too many bars into memory (use the in-memory cache, never SQL-per-tick)
- Data pipeline tracking too many contracts (sticky band model holds ~250-480 contracts)

---

### 4.10 Config Change Needed During RTH

**Do NOT change agent config during RTH unless it is an emergency.** Config changes require an agent restart, which causes a ~10s gap in monitoring.

**If you must**:
```bash
# 1. Pause trading first
bash /home/ubuntu/SPXer/scripts/ops.sh pause "config change"

# 2. Stop the agent
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop spx

# 3. Change the config in the database
# (via replay viewer UI at http://localhost:3601/replay, or directly)

# 4. Update AGENT_CONFIG_ID in ecosystem.config.js if needed
nano /home/ubuntu/SPXer/ecosystem.config.js

# 5. Restart the agent
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# 6. Resume trading
bash /home/ubuntu/SPXer/scripts/ops.sh resume
```

**Preferred approach**: Test config in replay after hours, deploy before next session.

---

### 4.11 Agent Enters Wrong Trade / Runaway Trading

**Detection**: Agent is taking more trades than expected, or trading in the wrong direction.

**Response**:
```bash
# IMMEDIATE: Stop the agent
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop spx

# Check what happened
pm2 logs spxer-agent --lines 200 2>&1 | tail -200
cat /home/ubuntu/SPXer/logs/agent-audit.jsonl | tail -20

# Check positions at broker
cat /home/ubuntu/SPXer/logs/agent-status-spx.json | python3 -m json.tool
```

**Assessment**: Check the audit log (`logs/agent-audit.jsonl`) for the sequence of decisions. The risk guard (`src/core/risk-guard.ts`) should enforce daily trade limits and daily loss limits. If it did not, there is a bug.

**Recovery**: Manually close unwanted positions via Tradier dashboard. Fix the root cause before restarting.

---

### 4.12 Market Holiday (Agent Starts But Should Not Trade)

**Detection**: Agent is running on a day in `MARKET_HOLIDAYS` set in `src/config.ts`.

**Response**:
```bash
# Stop agents
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh stop both

# Data pipeline can stay running -- it will have no data to collect
```

**Prevention**: Check `src/config.ts` MARKET_HOLIDAYS before each year. Holidays are hardcoded.

Early close days (`EARLY_CLOSE_DAYS`) have shortened hours (1:00 PM ET close). Agents should handle this via `activeEnd` config, but verify.

---

### 4.13 VPS Reboot / Power Loss

**Detection**: SSH connection lost. All processes down.

**Response** (after VPS comes back):
```bash
# PM2 should auto-start if saved with pm2 save + pm2 startup
# Verify:
pm2 list

# If PM2 did not auto-start:
cd /home/ubuntu/SPXer
pm2 start ecosystem.config.js
pm2 save

# NOTE: Agents have autorestart: false, so they won't auto-start on reboot
# Manually start them:
pm2 start ecosystem.config.js --only spxer-agent --update-env

# If there were open positions before reboot, agent will reconcile on startup
```

**Prevention**:
```bash
# Ensure PM2 startup hook is installed
pm2 startup
pm2 save
```

---

### 4.14 Network Partition (Tailscale Down)

**Detection**: Cannot SSH to VPS3 via Tailscale IP. Public dashboard unreachable.

**Assessment**: This only affects remote access and the nginx proxy on VPS5. The trading system on VPS3 continues to operate normally -- it connects directly to Tradier API via public internet, not through Tailscale.

**Response**:
```bash
# SSH via public IP instead of Tailscale
ssh ubuntu@137.74.117.1

# Restart Tailscale if needed
sudo systemctl restart tailscaled

# Check Tailscale status
tailscale status
```

**Impact**: Dashboard and replay viewer are unreachable from outside. Trading is unaffected.

---

## 5. Maintenance Procedures

### 5.1 Deploying Code Changes During RTH

**Only for critical hotfixes.** Prefer after-hours deploys.

```bash
# 1. Pause trading
bash /home/ubuntu/SPXer/scripts/ops.sh pause "deploying hotfix"

# 2. Pull changes
cd /home/ubuntu/SPXer && git pull

# 3. If agent code changed, restart agent
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# 4. If data pipeline code changed, restart it (agents will reconnect)
pm2 restart spxer
# Wait 2-3 minutes for indicator warmup, then restart agents
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# 5. Resume trading
bash /home/ubuntu/SPXer/scripts/ops.sh resume
```

### 5.2 Deploying Code Changes After Hours

```bash
cd /home/ubuntu/SPXer
git pull
npm run build   # optional, only if checking for compile errors

# Restart everything
pm2 restart spxer
pm2 restart spxer-dashboard
pm2 restart replay-viewer

# Agent will be started manually before next session
# or auto-started by PM2 if it was running
```

### 5.3 Database Maintenance

```bash
# Check current size
du -sh /home/ubuntu/SPXer/data/spxer.db*

# WAL checkpoint (compact WAL into main DB)
sqlite3 /home/ubuntu/SPXer/data/spxer.db "PRAGMA wal_checkpoint(TRUNCATE);"

# Integrity check (run after hours -- can be slow on 39GB)
sqlite3 /home/ubuntu/SPXer/data/spxer.db "PRAGMA integrity_check;" 

# VACUUM (reclaims space -- VERY slow on 39GB, requires 2x disk space temporarily)
# Only run on weekends with plenty of disk:
pm2 stop spxer spxer-agent  # must stop all writers
sqlite3 /home/ubuntu/SPXer/data/spxer.db "VACUUM;"
pm2 start ecosystem.config.js --only spxer

# Backup
cp /home/ubuntu/SPXer/data/spxer.db /home/ubuntu/SPXer/data/spxer.db.backup

# Archive expired contracts to parquet (reclaim space)
# Uses DuckDB + rclone to GDrive
npx tsx src/storage/archiver.ts
```

### 5.4 Config Changes (Test in Replay, Deploy to Live)

```bash
# 1. Create or modify config via replay viewer UI
#    http://localhost:3601/replay -> Configs tab

# 2. Run replay with new config
npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge

# 3. Run multi-day backtest
npx tsx src/replay/cli.ts backtest --no-scanners --no-judge

# 4. Check results
npx tsx src/replay/cli.ts results --config=my-new-config

# 5. If good, update ecosystem.config.js with new config ID
#    Edit AGENT_CONFIG_ID in the spxer-agent env block

# 6. Deploy (after hours)
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx
```

### 5.5 Adding a New Trading Day to Replay Library

```bash
# Historical data comes from Polygon (requires POLYGON_API_KEY)
# The replay system reads bars from spxer.db

# Check available dates
npx tsx src/replay/cli.ts days

# Run a replay for a new date (if bars exist in DB)
npx tsx src/replay/cli.ts run 2026-04-15 --no-scanners --no-judge
```

### 5.6 Upgrading Node.js / System Packages

```bash
# After hours only. Stop all processes first.
pm2 stop all

# Upgrade Node.js (via nvm or system package manager)
nvm install 22  # or whatever version
nvm use 22

# Reinstall dependencies
cd /home/ubuntu/SPXer
rm -rf node_modules
npm install

# Rebuild PM2
npm install -g pm2
pm2 update

# Restart everything
pm2 start ecosystem.config.js
pm2 save
```

### 5.7 PM2 Ecosystem Changes

```bash
# Edit the ecosystem file
nano /home/ubuntu/SPXer/ecosystem.config.js

# Apply changes to a specific process
pm2 start ecosystem.config.js --only spxer-agent --update-env

# Or reload all (graceful restart)
pm2 reload ecosystem.config.js

# Save the process list for reboot persistence
pm2 save
```

---

## 6. Monitoring & Alerts

### Checking Alert History

```bash
# Agent activity log (trades, signals, exits)
tail -50 /home/ubuntu/SPXer/logs/agent-activity.jsonl

# Audit log (full decision trace)
tail -20 /home/ubuntu/SPXer/logs/agent-audit.jsonl
```

### Silencing Alerts

```bash
# Activate maintenance mode (monitor skips remediation)
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh pause "maintenance window"

# Clear when done
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh unpause
```

Note: Maintenance mode prevents the monitor from taking **remediation actions**. It still observes and logs.

### Dashboard Interpretation

The dashboard at port 3602 shows:
- **SPX price**: Current underlying price (ES overnight, SPX during RTH)
- **Agent status**: Mode, position count, daily P&L
- **Signal indicators**: Current HMA cross direction on underlying
- **Contract bars**: Live 1m bars for tracked option contracts

Key things to watch:
- **Stale data**: If the SPX price timestamp is >2 minutes old, data pipeline may be degraded
- **Position count**: Should be 0 or 1 for the agent. Multiple positions suggest a bug.
- **Daily P&L**: If hitting `maxDailyLoss` config value, risk guard will block further trades

---

## 7. Recovery Procedures

### 7.1 Full System Restart From Scratch

```bash
# Kill everything
pm2 kill

# Verify nothing is running
ps aux | grep -E "tsx|node" | grep -v grep

# Start PM2 with ecosystem
cd /home/ubuntu/SPXer
pm2 start ecosystem.config.js

# Wait for data pipeline to warm up indicators (~2-3 min)
sleep 180

# Verify health
bash /home/ubuntu/SPXer/scripts/ops.sh health

# Start agent manually (it has autorestart: false)
pm2 start ecosystem.config.js --only spxer-agent --update-env

# Save for reboot persistence
pm2 save
```

### 7.2 Recovering From Corrupted Database

**Symptoms**: SQLite errors like `database disk image is malformed`, `SQLITE_CORRUPT`.

```bash
# 1. Stop all processes that access the DB
pm2 stop spxer spxer-agent

# 2. Try integrity check
sqlite3 /home/ubuntu/SPXer/data/spxer.db "PRAGMA integrity_check;"

# 3. If corrupt, try recovery via dump/reload
sqlite3 /home/ubuntu/SPXer/data/spxer.db ".dump" > /tmp/spxer-dump.sql
sqlite3 /home/ubuntu/SPXer/data/spxer-recovered.db < /tmp/spxer-dump.sql

# 4. Replace the old DB
mv /home/ubuntu/SPXer/data/spxer.db /home/ubuntu/SPXer/data/spxer.db.corrupt
mv /home/ubuntu/SPXer/data/spxer-recovered.db /home/ubuntu/SPXer/data/spxer.db

# 5. Restart
pm2 start ecosystem.config.js --only spxer
```

### 7.3 Restoring From Backup

```bash
# 1. Stop writers
pm2 stop spxer spxer-agent

# 2. Restore
cp /home/ubuntu/SPXer/data/spxer.db.backup /home/ubuntu/SPXer/data/spxer.db

# 3. Remove stale WAL/SHM
rm -f /home/ubuntu/SPXer/data/spxer.db-wal /home/ubuntu/SPXer/data/spxer.db-shm

# 4. Restart
pm2 start ecosystem.config.js --only spxer
```

### 7.4 Reconciling Positions After Extended Outage

If agents were down for an extended period and positions may have been filled/expired:

```bash
# 1. Start data pipeline first
pm2 start ecosystem.config.js --only spxer
sleep 120  # wait for warmup

# 2. Start agent -- it will reconcile from broker automatically
bash /home/ubuntu/SPXer/scripts/agent-ctl.sh restart spx

# 3. Watch the logs for reconciliation
pm2 logs spxer-agent --lines 50 2>&1 | grep -i "reconcil"

# The agent:
# - Queries Tradier for open positions
# - Adopts orphaned positions
# - Submits missing OCO bracket protection
# - Resumes normal cycle
```

If positions expired while the agent was down (0DTE options expire at 4:00 PM ET), there is nothing to reconcile. Check P&L in Tradier dashboard.

---

## 8. Key File Locations

### Application

| Path | Description |
|------|-------------|
| `/home/ubuntu/SPXer/` | Project root |
| `/home/ubuntu/SPXer/ecosystem.config.js` | PM2 process definitions |
| `/home/ubuntu/SPXer/.env` | Environment variables (API keys) |
| `/home/ubuntu/SPXer/src/config.ts` | Holidays, polling intervals, constants |
| `/home/ubuntu/SPXer/src/config/defaults.ts` | Default trading config |
| `/home/ubuntu/SPXer/spx_agent.ts` | SPX agent entry point |
| `/home/ubuntu/SPXer/account-monitor.ts` | Account monitor (DISABLED — kept for reference) |

### Data

| Path | Description |
|------|-------------|
| `/home/ubuntu/SPXer/data/spxer.db` | Main SQLite database (~39GB) |
| `/home/ubuntu/SPXer/data/spxer.db-wal` | WAL file (should be <200MB) |
| `/home/ubuntu/SPXer/data/spxer.db.backup` | Last manual backup |
| `/home/ubuntu/SPXer/data/cache/` | Temporary cache files |

### Logs

| Path | Description |
|------|-------------|
| `/home/ubuntu/SPXer/logs/agent-status-spx.json` | SPX agent current state |
| `/home/ubuntu/SPXer/logs/agent-status.json` | Legacy combined status file |
| `/home/ubuntu/SPXer/logs/agent-activity.jsonl` | Agent trade/signal activity |
| `/home/ubuntu/SPXer/logs/agent-audit.jsonl` | Full decision audit trail |
| `/home/ubuntu/SPXer/logs/agent-maintenance.json` | Maintenance mode flag file |
| `/home/ubuntu/SPXer/logs/watchdog-status.json` | Watchdog state (DISABLED) |
| `~/.pm2/logs/spxer-out.log` | Data pipeline stdout |
| `~/.pm2/logs/spxer-error.log` | Data pipeline stderr |
| `~/.pm2/logs/spxer-agent-out.log` | SPX agent stdout |
| `~/.pm2/logs/spxer-agent-error.log` | SPX agent stderr |
| `~/.pm2/logs/dashboard-out.log` | Dashboard stdout |
| `~/.pm2/logs/dashboard-error.log` | Dashboard stderr |

### Scripts

| Path | Description |
|------|-------------|
| `/home/ubuntu/SPXer/scripts/ops.sh` | Unified ops CLI (status, health, restart, etc.) |
| `/home/ubuntu/SPXer/scripts/agent-ctl.sh` | Safe agent restart/stop with monitor coordination |
| `/home/ubuntu/SPXer/scripts/claude-monitor.sh` | Monitoring loop (24 checks, 5min intervals) |
| `/home/ubuntu/SPXer/scripts/setup-crons.sh` | Cron job installer |

---

## 9. Contacts & Escalation

| Resource | Contact |
|----------|---------|
| Tradier Support | support@tradier.com / https://status.tradier.com |
| Tradier API Status | https://status.tradier.com |
| VPS3 Hosting (OVH) | 137.74.117.1 / OVH control panel |
| VPS5 Hosting (OVH) | 51.81.34.78 / OVH control panel |

### Tradier Account IDs

| Account | ID | Type |
|---------|----|------|
| SPX (margin) | 6YA51425 | Options margin |

---

## Appendix: Things That Will Bite You

1. **DO NOT re-enable the watchdog or account-monitor.** Watchdog caused $12K in losses by cancelling OCO bracket orders. Account-monitor was interfering with successful trades. Both removed from PM2.

2. **Agents have `autorestart: false`.** If an agent crashes at 10 AM, it stays down until you manually restart it. Positions are protected by broker-side OCO orders, but no new trades or flip exits will happen.

3. **The DB is 39GB and growing.** Monitor disk space. A VACUUM requires 2x the DB size in free space temporarily.

4. **Config changes require agent restart.** The agent loads config once on startup from the `replay_configs` table by ID. Changing the DB row does nothing until restart.

5. **Data pipeline warmup takes 2-3 minutes.** After restarting `spxer`, indicators need time to seed. Restarting agents before warmup completes will produce bad signals.

6. **0DTE options expire at 4:00 PM ET.** If an agent is down at expiry, positions settle automatically. Check P&L after.

7. **The `new Date(date.toLocaleString(...))` timezone pattern is broken.** All ET conversions must use `src/utils/et-time.ts`. If you see this pattern in new code, it is a bug.

8. **Never run multiple writers against spxer.db.** Only the data pipeline (`spxer` process) writes to the database. Agents interact via the REST API. Running ad-hoc SQLite writes while the pipeline is running risks WAL corruption.

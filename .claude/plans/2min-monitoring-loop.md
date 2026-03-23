# SPXer 2-Minute Monitoring Loop

## Purpose

Continuous monitoring loop that runs every 2 minutes to track:
- SPX price and RSI from database
- Agent processes and status file
- Recent error logs
- Scanner activity (Kimi, GLM, Haiku, MiniMax)
- SPXer service health via API

## Pre-Flight Checks

Before starting the loop, verify:

1. SPXer service is running:
   ```bash
   curl -s http://localhost:3600/health | jq '.status'
   # Should return: "ok"
   ```

2. Database is accessible:
   ```bash
   ls -lh data/spxer.db
   # Should show file size > 0
   ```

3. Agent can be started:
   ```bash
   npm run agent -- --dry-run
   # Test that agent binary runs
   ```

## Starting the Loop

### Option 1: Interactive Terminal (Recommended for testing)

```bash
cd /home/ubuntu/SPXer
bash /tmp/spxer-status-2min.sh | tee -a /tmp/spxer-monitor.log
```

To run in an infinite loop:
```bash
cd /home/ubuntu/SPXer
while true; do
  bash /tmp/spxer-status-2min.sh | tee -a /tmp/spxer-monitor.log
  sleep 120
done
```

### Option 2: Background with nohup

```bash
cd /home/ubuntu/SPXer
nohup bash -c 'while true; do bash /tmp/spxer-status-2min.sh | tee -a /tmp/spxer-monitor.log; sleep 120; done' > /tmp/spxer-monitor.out 2>&1 &
```

Save the PID:
```bash
echo $! > /tmp/spxer-monitor.pid
```

### Option 3: PM2 Process (Recommended for production)

```bash
cd /home/ubuntu/SPXer
pm2 start /tmp/spxer-status-2min.sh --name "spxer-monitor" --cron "*/2 * * * *"
```

Or create a dedicated loop script:
```bash
cat > /tmp/spxer-monitor-loop.sh << 'SCRIPT'
#!/bin/bash
cd /home/ubuntu/SPXer
while true; do
  bash /tmp/spxer-status-2min.sh | tee -a /tmp/spxer-monitor.log
  sleep 120
done
SCRIPT

chmod +x /tmp/spxer-monitor-loop.sh
pm2 start /tmp/spxer-monitor-loop.sh --name "spxer-monitor"
```

## Monitoring the Loop

### Check if loop is running:

```bash
# If using PM2
pm2 list | grep spxer-monitor

# If using nohup
ps aux | grep spxer-status-2min.sh | grep -v grep

# If running in terminal
# Check the terminal window
```

### View recent output:

```bash
# Last 5 assessments
tail -200 /tmp/spxer-monitor.log | grep "=== SPXer"

# Last error count
tail -200 /tmp/spxer-monitor.log | grep "Recent Errors"

# Scanner activity
tail -200 /tmp/spxer-monitor.log | grep "Kimi\|GLM\|Haiku\|MiniMax"
```

### Stop the loop:

```bash
# If using PM2
pm2 stop spxer-monitor
pm2 delete spxer-monitor

# If using nohup
kill $(cat /tmp/spxer-monitor.pid)
rm /tmp/spxer-monitor.pid

# If in terminal
# Press Ctrl+C
```

## Understanding the Output

Each assessment shows:

### SPX Price and RSI
- Price: Latest SPX close from database
- RSI: 14-period RSI value
- Alert if price = 0 or RSI is null

### Open Positions
- Count of open positions
- Symbol, entry price, current price, and P&L for each

### Agent Processes
- Count of running agent processes
- Alert if 0 (agent not running)

### Status File
- Whether status.json was updated in last 2 minutes
- Alert if missing or stale

### Recent Errors
- Count of ERROR messages in last 50 lines of error log
- Shows "No Recent Errors" if count = 0

### Scanner Reads (Kimi, GLM, Haiku, MiniMax)
- Active: Last read within 2 minutes
- Inactive: No read in last 2 minutes (shows timestamp)

### SPXer Service
- Health check from /health endpoint
- Shows uptime and mode if healthy
- Alert if unhealthy or down

## Troubleshooting

### Database locked errors
- Cause: SPXer service has write lock
- Fix: Use API endpoints instead of direct SQLite queries
- Status: Script already uses API for health, but direct DB for RSI

### Scanner "No recent reads"
- Cause: Agent not running or scanner not reading
- Check: Agent processes count > 0?
- Action: Restart agent if needed

### SPXer Service unhealthy
- Check: pm2 list | grep spxer
- Restart: pm2 restart spxer
- Logs: pm2 logs spxer --lines 50

### Loop stopped running
- Check PM2: pm2 list (should show spxer-monitor)
- Check process: ps aux | grep spxer-status-2min
- Restart: Follow "Starting the Loop" section above

## Log Rotation

Monitor log file size:
```bash
ls -lh /tmp/spxer-monitor.log
```

If > 100MB, rotate:
```bash
mv /tmp/spxer-monitor.log /tmp/spxer-monitor.log.old
# New log will be created automatically
```

Or set up logrotate:
```bash
cat > /etc/logrotate.d/spxer-monitor << 'EOF'
/tmp/spxer-monitor.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
}

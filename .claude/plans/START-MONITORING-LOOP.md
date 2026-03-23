# Start SPXer 2-Minute Monitoring Loop

## Quick Start (Recommended)

Start the monitoring loop in background with nohup:

```bash
cd /home/ubuntu/SPXer
nohup bash -c 'while true; do bash /tmp/spxer-status-2min-v2.sh | tee -a /tmp/spxer-monitor.log; sleep 120; done' > /tmp/spxer-monitor.out 2>&1 & echo $! > /tmp/spxer-monitor.pid && echo "Monitoring loop started with PID: $(cat /tmp/spxer-monitor.pid)"
```

## Verify It's Running

```bash
# Check the process
ps aux | grep spxer-status-2min-v2 | grep -v grep

# Check the PID file
cat /tmp/spxer-monitor.pid

# View live output
tail -f /tmp/spxer-monitor.log

# Or check the nohup output
tail -f /tmp/spxer-monitor.out
```

## Example Output

```
=== SPXer 2-Minute Status Assessment Mon Mar 23 17:37:34 UTC 2026 ===
✅ SPX Price: 6606.77
✅ SPX RSI: 91.37323943661923
📊 No Open Positions
🤖 Agent Processes: 2
❌ Status File: Not found
✅ No Recent Errors
📊 Scanner Reads Log: Not found (agent may not be running)
🌐 SPXer Service: ✅ Healthy
   Uptime: 303s
   Mode: rth
   Last SPX: 6606.77
=== End Assessment ===
```

## Stop the Loop

```bash
kill $(cat /tmp/spxer-monitor.pid)
rm /tmp/spxer-monitor.pid
```

## What's Being Monitored

1. **SPX Price & RSI** - Fetched from API every 2 minutes
2. **Open Positions** - Tracked from positions API endpoint
3. **Agent Processes** - Count of running agent processes
4. **Status File** - Checks if status.json was updated recently
5. **Recent Errors** - Counts ERROR messages in agent error log
6. **Scanner Activity** - Tracks last read time for Kimi, GLM, Haiku, MiniMax
7. **SPXer Service Health** - API health check with uptime, mode, and price

## Log Files

- `/tmp/spxer-monitor.log` - Main monitoring log (append-only)
- `/tmp/spxer-monitor.out` - nohup output file
- `/tmp/spxer-monitor.pid` - Process ID file

## Pre-Conditions Verified

✅ SPXer service is running (port 3600)
✅ Database is accessible (1.4GB spxer.db)
✅ API endpoints are responding
✅ SPX price: 6606.77, RSI: 91.37
✅ Agent processes: 2 running

## Safety Features

- Uses read-only API calls (no database locks)
- Append-only logging (no file modification)
- Can be stopped safely with kill command
- No trading execution (monitoring only)
- Runs in unprivileged user context

## Troubleshooting

### Loop stops running
```bash
# Check if process exists
ps -p $(cat /tmp/spxer-monitor.pid)

# If not found, restart with Quick Start command above
```

### No output in log
```bash
# Check nohup output for errors
cat /tmp/spxer-monitor.out

# Test script manually
bash /tmp/spxer-status-2min-v2.sh
```

### API errors
```bash
# Verify SPXer service is running
curl http://localhost:3600/health | jq '.'

# Restart spxer if needed
pm2 restart spxer
```

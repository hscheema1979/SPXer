# SPXer 2-Minute Status Monitoring Loop

## Overview
Infinite loop that monitors SPXer trading agent status and scanner analysis every 2 minutes.

## Loop Pattern
**Type**: `infinite`
**Mode**: `safe`
**Interval**: 120 seconds (2 minutes)

## Stop Condition
User manual termination via Ctrl+C or `/loop-status --stop`

## Loop Body
The loop executes `/tmp/spxer-monitor.sh` which provides:

1. **TIMESTAMP** - Current time in ET format
2. **Server Status**:
   - SPX price and RSI from database
   - SPXer data service health (port 3600)
   - PM2 process status
   - Trading agent status (cycle, positions, P&L)

3. **Scanner Status**:
   - Latest scanner reads (Kimi, GLM, Haiku, MiniMax)
   - Scanner setup detection with confidence levels
   - Time since last scan

4. **Safety Checks**:
   - Database availability
   - Service health endpoint
   - Log file freshness
   - Error detection

## Pre-Flight Checklist
- ✅ SPXer data service running (port 3600)
- ✅ Database accessible (`/home/ubuntu/SPXer/data/spxer.db`)
- ✅ Agent status file exists (`/home/ubuntu/SPXer/logs/agent-status.json`)
- ✅ No destructive operations (read-only monitoring)

## Run Commands

**Start the loop:**
```bash
cd /home/ubuntu/SPXer
while true; do bash /tmp/spxer-monitor.sh; sleep 120; done
```

**Monitor loop status:**
```bash
ps aux | grep "spxer-monitor"
```

**Stop the loop:**
```bash
pkill -f "spxer-monitor"
```

## Output Format
The loop produces colorized terminal output with:
- Header with timestamp
- Market data section (SPX price, RSI)
- Service status section (health checks)
- Trading agent section (cycle, positions, reasoning)
- Scanner analysis section (latest reads, setups)
- Timing section (last scan age)
- 2-minute countdown to next update

## Safety Considerations
- Read-only operations (no writes to database or logs)
- No trading execution (monitoring only)
- Graceful error handling for missing data
- Runs in unprivileged user context
- Can be stopped safely without data corruption
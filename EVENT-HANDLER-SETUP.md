# Event Handler Pipeline Setup

## Overview

The event handler uses an independent signal detection system that fetches data directly from Tradier REST API (no dependency on spxer for signals).

## Architecture

```
Event Handler (event_handler_mvp.ts)
  ├─ Timer: fires at :00 seconds every minute
  ├─ Signal Detection:
  │   ├─ Fetch SPX price from Tradier
  │   ├─ Calculate strikes (ITM5 call/put)
  │   ├─ Fetch timesales from Tradier
  │   ├─ Aggregate to 3m bars
  │   ├─ Compute HMA(3) and HMA(12)
  │   └─ Detect cross (last 2 bars)
  └─ If cross detected:
      ├─ Create signal object
      ├─ Call handleContractSignal()
      ├─ PositionOrderManager.evaluate()
      └─ Execute trade via trade-executor
```

## E2E Testing Status

### What's Already Tested ✅

1. **Event Handler → Position Execution** (from earlier testing)
   - WebSocket signal reception
   - PositionOrderManager evaluation
   - Trade execution via trade-executor
   - Account Stream fill detection
   - account.db state persistence

2. **Signal Detection Function** (just tested)
   - `detectHmaCross()` fetches from Tradier ✅
   - HMA computation works correctly ✅
   - Cross detection accurate ✅
   - Event handler can import and call it ✅

### What Needs Validation ⚠️

**Quick E2E smoke test** to verify signal → execution flow:

```typescript
// Simulate signal detection result
const mockSignal = {
  symbol: 'SPXW260424C07150000',
  strike: 7150,
  side: 'call',
  direction: 'bullish',
  hmaFast: 3,
  hmaSlow: 12,
  price: 7157.15,
  timeframe: '3m',
  timestamp: Date.now(),
};

// This should flow through:
// 1. handleContractSignal(mockSignal)
// 2. PositionOrderManager.evaluate()
// 3. Gate checks (risk, time, cooldown)
// 4. Strike selection
// 5. Order submission (paper mode)
```

**Recommendation**: Run the handler in paper mode during market hours and verify:
- Logs show "checkForSignals" at :00 seconds
- Signals are logged when crosses occur
- No crashes or errors in signal flow

The existing interactions should work since we didn't change:
- handleContractSignal()
- PositionOrderManager.evaluate()
- trade-executor.ts
- AccountStream
- account.db persistence

We only changed **HOW signals are detected**, not **WHAT HAPPENS AFTER**.

## PM2 Setup

### Start All Services

```bash
# Start data service (spxer)
pm2 start ecosystem.config.js --only spxer

# Start event handler
pm2 start ecosystem.config.js --only event-handler

# Verify both are running
pm2 status

# Save configuration
pm2 save
```

### Start Only Event Handler

```bash
# Paper mode
AGENT_PAPER=true AGENT_CONFIG_ID=your-config-id pm2 start ecosystem.config.js --only event-handler

# Live mode
AGENT_PAPER=false AGENT_CONFIG_ID=your-config-id pm2 start ecosystem.config.js --only event-handler
```

### Restart Event Handler

```bash
# Soft restart (graceful shutdown)
pm2 restart event-handler

# Hard restart (kill and start)
pm2 delete event-handler
pm2 start ecosystem.config.js --only event-handler
```

## Environment Variables

### Required

```bash
# Tradier API (for signal detection and execution)
TRADIER_TOKEN=your_token_here

# Tradier Account (for order execution)
TRADIER_ACCOUNT_ID=6YA51425

# Config Selection
AGENT_CONFIG_ID=spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000
# OR multiple configs:
AGENT_CONFIG_IDS=config1,config2,config3

# Execution Mode
AGENT_PAPER=true  # true = paper, false = live
```

### Optional

```bash
# WebSocket URL (for SPX price updates from spxer)
WS_URL=ws://localhost:3600/ws

# Database paths
DB_PATH=/home/ubuntu/SPXer/data/spxer.db

# Agent tag for tracking
AGENT_TAG=event-handler-mvp
```

## Monitoring

### Real-time Logs

```bash
# Follow event handler logs
pm2 logs event-handler

# Show last 100 lines
pm2 logs event-handler --lines 100

# Show errors only
pm2 logs event-handler --err

# Grep for signals
pm2 logs event-handler --nostream | grep SIGNAL
```

### Monitoring Scripts

```bash
# Signal detection monitoring
./scripts/ops/monitor-signal-detection.sh

# Active trading monitoring
./scripts/ops/monitor-active-trading.sh

# Operational monitoring
./scripts/ops/monitor-operational.sh
```

### Health Checks

```bash
# Data service health
curl -s http://localhost:3600/health | jq .

# Account database state
sqlite3 data/account.db "SELECT * FROM positions WHERE status='OPEN';"

# Config state
sqlite3 data/account.db "SELECT * FROM config_state;"
```

## Startup Sequence

### Daily Startup (Pre-Market)

1. **06:00 ET** - Environment check
   ```bash
   ./scripts/ops/check-environment.sh
   ```

2. **06:05 ET** - Start data service
   ```bash
   pm2 start ecosystem.config.js --only spxer
   ```

3. **08:00 ET** - Start event handler in warmup mode
   ```bash
   export AGENT_PAPER=true
   export AGENT_CONFIG_ID=your-config-id
   pm2 start ecosystem.config.js --only event-handler
   ```

4. **09:30 ET** - Transition to live mode (if ready)
   ```bash
   # Stop handler
   pm2 stop event-handler

   # Update mode
   export AGENT_PAPER=false  # if going live

   # Restart handler
   pm2 start ecosystem.config.js --only event-handler
   ```

### Shutdown Sequence

1. **16:00 ET** - Stop event handler
   ```bash
   pm2 stop event-handler
   ```

2. **16:10 ET** - Verify positions closed
   ```bash
   sqlite3 data/account.db "SELECT * FROM positions WHERE status='OPEN';"
   ```

3. **16:30 ET** - Stop data service (optional)
   ```bash
   pm2 stop spxer
   ```

## Troubleshooting

### Signal Detection Not Working

```bash
# Check event handler logs
pm2 logs event-handler --lines 100 | grep -i "signal\|error"

# Verify Tradier API
curl -H "Authorization: Bearer $TRADIER_TOKEN" \
  "https://api.tradier.com/v1/markets/quotes?symbols=SPX"

# Check signal detection timer
pm2 logs event-handler --nostream | grep "checkForSignals"

# Run signal detection monitoring
./scripts/ops/monitor-signal-detection.sh
```

### No Positions Opening

```bash
# Check if signals are firing
pm2 logs event-handler --nostream | grep SIGNAL

# Check gate rejections
pm2 logs event-handler --nostream | grep -i "gate\|block\|reject"

# Check risk limits
sqlite3 data/account.db "SELECT * FROM config_state;"

# Check open positions
sqlite3 data/account.db "SELECT * FROM positions WHERE status IN ('OPEN', 'OPENING');"
```

### Handler Crashing

```bash
# Check error logs
pm2 logs event-handler --err

# Check restart count
pm2 describe event-handler

# Check memory usage
pm2 status

# Restart handler
pm2 restart event-handler
```

## Validation Checklist

- [ ] Event handler starts without errors
- [ ] WebSocket connects to spxer
- [ ] Signal detection timer fires at :00 seconds
- [ ] Tradier API fetches working (check logs)
- [ ] HMA computation working (check logs for HMA values)
- [ ] Signals being logged when crosses occur
- [ ] Position execution working (paper mode test)
- [ ] Account Stream receiving fills
- [ ] account.db state persisting correctly
- [ ] Monitoring scripts passing

## Quick Start

```bash
# 1. Start data service
pm2 start ecosystem.config.js --only spxer

# 2. Start event handler (paper mode)
export AGENT_PAPER=true
export AGENT_CONFIG_ID=spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000
pm2 start ecosystem.config.js --only event-handler

# 3. Verify both are running
pm2 status

# 4. Check logs
pm2 logs event-handler --lines 50

# 5. Monitor signal detection
./scripts/ops/monitor-signal-detection.sh

# 6. Save PM2 configuration
pm2 save
```

## Next Steps

1. Run signal detection monitoring script to verify setup
2. Monitor logs during market hours to confirm signal flow
3. If paper testing successful, transition to live mode with proper approvals
4. Update checklists and runbooks based on operational experience

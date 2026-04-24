# Pre-Market Warmup Feature

## Overview

SPXer now supports **pre-market warmup** from 08:00-09:30 ET — a "green flag lap" where all systems run with real data but no actual trades are executed. This is possible because **Tradier now supports SPX pre-market trading**.

## Benefits

✅ **Early Signal Validation** — Detect signal quality issues before market open
✅ **Strike Band Calibration** — Center the option band around pre-market SPX levels
✅ **System Warmup** — WebSocket connections, indicators, pipelines all active early
✅ **Zero Risk** — No positions opened during warmup (all signals are "green")
✅ **Seamless Transition** — One script switches from warmup to live at 09:30:00 ET

## How It Works

### Warmup Mode (08:00-09:30 ET)

```bash
export AGENT_EXECUTION_MODE=WARMUP
npm run handler
```

**What happens:**
- ✅ Connects to data service WebSocket
- ✅ Subscribes to `contract_signal` channels
- ✅ Receives SPX pre-market data (Tradier now supports this)
- ✅ Detects HMA crosses on option contracts
- ✅ Logs all signals: `[execution] WARMUP: Would open SPXW260425C07100000 @ $10.00`
- ❌ **No positions opened**
- ❌ **No orders sent to broker**

**What you see in logs:**
```
[handler] Event-Driven Trading Handler starting...
[execution] WARMUP MODE - Pre-market signal tracking (NO EXECUTION)
[execution] All signals will be logged but no orders placed
[handler] Subscribed to channels: contract_signal:3_12
[execution] WARMUP: Would open buy_to_open 1x SPXW260425C07100000 @ $10.50
[execution]         TP: $13.12 | SL: $7.87
[execution]         (Signal tracked - NO EXECUTION in warmup mode)
```

### Transition to Live (10:00:00 ET)

```bash
./scripts/ops/transition-from-warmup.sh
```

**What happens:**
1. Stops handler (WARMUP mode)
2. Updates `AGENT_EXECUTION_MODE` to target mode (SIMULATION or LIVE)
3. Restarts handler
4. WebSocket reconnects
5. **Real trading begins**

## Daily Timeline

```
06:00 AM ── Pre-market environment checks
           ── Database integrity, provider health, etc.

08:00 AM ── PRE-MARKET WARMUP STARTS
           ── Handler starts in WARMUP mode
           ── Tradier SPX pre-market data flows in
           ── Strike band initialized (wider: ±$150)
           ── Signal detection active
           ── All signals tracked as "green"

08:00-09:30 AM ── Warmup Phase 1 (backfilled data)
               ── Signals detected on warmed-up indicators
               ── Mostly from CopyWarmupBars (previous day's data)
               ── Verify systems working

09:30 AM ── MARKET OPEN
          ── Trading begins, but still in WARMUP mode

09:42 AM ── First valid HMA(12) appears
          ── 12 bars after market open (12 × 1m = 12min)
          ── HMA(3)×HMA(12) crosses now possible on TODAY'S data

09:42-10:00 AM ── Warmup Phase 2 (REAL signals)
               ── Track actual signals on today's market data
               ── Verify signal quality, no opening artifacts
               ── Confirm strike band centered correctly

10:00:00 AM ── Transition to SIMULATION/LIVE
            ── Now trading on validated signals from today's data
            ── 18-minute buffer after first possible cross

10:05 AM ── Verify first trades
          ── Check position tracking
          ── Confirm TP/SL fills

10:00 AM - 4:00 PM ── Active trading
                   ── Normal monitoring
```

## Quick Start

### 1. Start Warmup at 08:00 ET

```bash
# Set target mode (what to switch to at 09:30)
export WARMUP_TARGET_MODE=SIMULATION  # or LIVE

# Start warmup
./scripts/ops/start-warmup.sh
```

**Output:**
```
╔════════════════════════════════════════╗
║   SPXer Pre-Market Warmup Phase      ║
║   Green Flag Lap - No Trading Yet    ║
╚════════════════════════════════════════╝

Started: 2026-04-25 08:00:00 EDT

═══ Starting Handler in WARMUP MODE ═══
✅ Handler started in WARMUP mode
✅ Handler status: ONLINE
✅ Warmup mode confirmed in logs
✅ WebSocket connected

═══ Pre-Market Warmup Active ═══

✅ Warmup phase will track all signals from 08:00-09:30 ET

What happens during warmup:
  ✅ Signal detection runs with real SPX data
  ✅ HMA crosses detected and logged
  ✅ Strike band initialized (wider than usual)
  ✅ All signals marked as 'green' (tracked, not executed)
  ❌ No positions opened (WARMUP mode)
  ❌ No orders sent to broker

At 09:30:00 ET:
  🔄 Switch to SIMULATION mode
  🚀 Begin actual trading

Monitor warmup signals:
  pm2 logs event-handler | grep WARMUP

Transition to live trading:
  ./scripts/ops/transition-from-warmup.sh

⏱️  Warmup active - switch to live at 09:30 ET
```

### 2. Monitor Warmup (08:00-09:25 ET)

```bash
# Watch warmup signals in real-time
pm2 logs event-handler | grep WARMUP

# Count warmup signals
pm2 logs event-handler --nostream --lines 1000 | grep -c WARMUP

# Check for errors
pm2 logs event-handler --nostream --lines 100 | grep ERROR
```

**What to look for:**
- ✅ Signals firing (not zero, not hundreds)
- ✅ Strike band centered around SPX
- ✅ No errors or failures
- ✅ Signal timestamps increasing (real-time)

### 3. Transition to Live at 09:30:00 ET

```bash
# Set target mode
export WARMUP_TARGET_MODE=SIMULATION  # or LIVE

# Execute transition
./scripts/ops/transition-from-warmup.sh
```

**Output:**
```
╔════════════════════════════════════════╗
║   WARMUP → LIVE TRANSITION            ║
║   Market Open: 09:30 ET               ║
╚════════════════════════════════════════╝

Time: 2026-04-25 09:30:00 EDT

Target execution mode: SIMULATION

═══ Warmup Summary ═══
Signals tracked during warmup: 12
✅ No errors in warmup logs

═══ Step 1: Stop Handler (WARMUP mode) ═══
✅ Handler stopped
✅ Handler confirmed stopped

═══ Step 2: Update Execution Mode ═══
AGENT_EXECUTION_MODE=SIMULATION
✅ Updated ecosystem.config.js

═══ Step 3: Start Handler (SIMULATION mode) ═══
✅ Handler started

═══ Step 4: Verify Transition ═══
✅ Execution mode confirmed: SIMULATION
✅ WebSocket connected
✅ HTTP API confirms mode: SIMULATION

═══ Transition Complete ═══

🚀 Handler now running in SIMULATION mode

What happens now:
  ✅ Live signals from data service
  ✅ FakeBroker simulates orders locally
  ✅ TP/SL fills based on real price feeds
  ❌ No real orders to Tradier

Monitor trading activity:
  pm2 logs event-handler
  curl -s http://localhost:3600/agent/simulation | jq .

📈 Market is OPEN - Good luck!
```

## Automation

### Cron Schedule

Add to crontab (`crontab -e`):

```bash
# Pre-Market Warmup (08:00 ET)
0 8 * * 1-5 export WARMUP_TARGET_MODE=SIMULATION && /home/ubuntu/SPXer/scripts/ops/start-warmup.sh >> logs/warmup-$(date +\%Y\%m\%d).log 2>&1

# Transition to Live (09:30 ET SHARP)
30 9 * * 1-5 export WARMUP_TARGET_MODE=SIMULATION && /home/ubuntu/SPXer/scripts/ops/transition-from-warmup.sh >> logs/transition-$(date +\%Y\%m\%d).log 2>&1
```

### Manual Override

If you need to skip warmup and go straight to live:

```bash
# Start directly in target mode at 09:30
export AGENT_EXECUTION_MODE=SIMULATION
pm2 start event-handler --update-env
```

## Signal Comparison

### Warmup Mode
```
[execution] WARMUP: Would open buy_to_open 1x SPXW260425C07100000 @ $10.50
[execution]         TP: $13.12 | SL: $7.87
[execution]         (Signal tracked - NO EXECUTION in warmup mode)
```
→ **Signal detected, logged, NOT executed**

### Simulation Mode
```
[executor] SIMULATION: OTOCO buy_to_open 1x SPXW260425C07100000 @ $10.50
[executor]             TP: $13.12 | SL: $7.87
[executor]             Bracket: #1000 | Entry: #1001 | TP: #1002 | SL: #1003
[manager] FILL MATCHED BY SYMBOL: SPXW260425C07100000 @ $10.75 — OPENING→OPEN
```
→ **Signal detected, FakeBroker simulates order**

### Live Mode
```
[executor] LIVE OTOCO [SPX→6YA51425] 1x SPXW260425C07100000 @ MARKET
[executor] ✅ Filled @ $10.50 (expected $10.50)
```
→ **Signal detected, real order to Tradier**

## Configuration

### Strike Band During Warmup

The option stream uses a **wider strike band** during warmup to capture early pre-market moves:

| Phase | Strike Band | Contracts | Reason |
|-------|-------------|----------|--------|
| Warmup (08:00-09:30) | ±$150 | ~300 | Capture pre-market moves |
| Trading (09:30+) | ±$100 | ~200 | Normal operation |

This is handled automatically by the option stream scheduler.

### Target Mode Selection

Set `WARMUP_TARGET_MODE` to control what happens after warmup:

```bash
# Simulation mode (default)
export WARMUP_TARGET_MODE=SIMULATION

# Live mode (requires 2-person confirmation)
export WARMUP_TARGET_MODE=LIVE

# Paper mode (not recommended)
export WARMUP_TARGET_MODE=PAPER
```

## Troubleshooting

### Warmup Not Starting

**Error**: `Failed to start handler in WARMUP mode`

**Solution**:
1. Check `AGENT_EXECUTION_MODE` env var
2. Verify execution router supports WARMUP mode
3. Check logs: `pm2 logs event-handler --lines 50`

### Transition Fails

**Error**: `Failed to stop handler` or `Failed to start handler`

**Solution**:
1. Manual stop: `pm2 stop event-handler`
2. Manual start: `AGENT_EXECUTION_MODE=SIMULATION pm2 start event-handler --update-env`
3. Verify mode: `curl -s http://localhost:3600/agent/mode | jq .`

### No Signals During Warmup

**Error**: Zero warmup signals tracked

**Possible causes**:
1. SPX pre-market data not flowing (check Tradier status)
2. HMA crosses not occurring (normal in quiet market)
3. Strike band too narrow (unlikely with ±$150)

**Action**: Verify data flow, check logs for `contract_signal` events

## Comparison: With vs Without Warmup

### Without Warmup (Old Way)
```
09:00 AM ── Start handler cold
09:25 AM ── Hope everything works
09:30 AM ── Market opens, first signals fire
          ── First time seeing live data
          ── No validation until real money at risk
```

### With Warmup (New Way)
```
08:00 AM ── Start warmup
08:00-09:25 AM ── Validate signal quality
               ── Verify strike band
               ── Check for errors
09:30 AM ── Transition to live (validated)
          ── First signals fire with confidence
          ── System already proven working
```

## Future Enhancements

- [ ] Warmup signal analysis (compare warmup vs actual performance)
- [ ] Automatic strike band optimization based on warmup
- [ ] Warmup quality score (pass/fail criteria for transition)
- [ ] Multi-config warmup (test multiple configs simultaneously)
- [ ] Warmup replay (compare against historical warmup data)

## Related Documentation

- [Daily Operations Checklist](../DAILY-OPS-CHECKLIST.md) — Full procedures
- [Simulation Mode](./SIMULATION-MODE.md) — Simulation vs Live details
- [Event-Driven Handler](../docs/EVENT_HANDLER_ARCHITECTURE.md) — Handler architecture

---

**Version**: 1.0
**Last Updated**: 2026-04-24
**Status**: ✅ Operational

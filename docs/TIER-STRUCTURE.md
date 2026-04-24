# SPXer Tier Structure

## Philosophy: Two-Tier Verification

Each tier follows the "pressure sensor" philosophy:
1. **Tier 0**: "Can the machine run?"
2. **Tier 1**: "Is the software configured and working?"

## Tier 0: Machine Fundamentals (06:00 AM ET)

**Purpose**: Verify the machine itself is capable of running the trading system.

**Checks**:
- RAM available (need at least 2GB free)
- Disk space (need at least 10GB free)
- CPU load (< 2.0 acceptable)
- Network connectivity (can reach internet?)
- DNS working (can resolve domains?)
- Timezone ET (critical for market times)
- Clock sync (accurate time critical for trading)

**Failure Impact**: If Tier 0 fails → STOP everything. Machine cannot trade.

**Script**: `check-environment.sh`

## Tier 1: Service Setup & Runtime (06:15 AM ET)

**Purpose**: Verify the trading software is configured and running.

**Checks**:
For each service (SignalPoller/spxer, event-handler, position handler):

1. **Setup Check**: Is service configured in PM2?
   - Run: `pm2 describe <service>`
   - If not configured → FAIL with instructions

2. **Runtime Check**: Is service currently running?
   - Check: `status == "online"`
   - If running → PASS

3. **Recovery**: If not running, can we fix it?
   - If `stopped` → Try `pm2 start <service>`
   - If `errored` → Try `pm2 delete` + `pm2 start <service>`
   - If fails → FAIL with diagnosis (logs, error details)

**Failure Impact**: If Tier 1 fails → Try to recover, then abort if unrecoverable.

**Script**: `check-services-setup.sh`

## Why This Separation Matters

### Tier 0 First (Machine)
```
Before we even check if the software is running:
  ✅ Does the machine have RAM?
  ✅ Does the machine have disk space?
  ✅ Is the CPU overloaded?
  ✅ Is the network up?
  ✅ Is the time correct?

If any of these fail → STOP. The machine cannot trade.
```

### Tier 1 Second (Software)
```
Only AFTER machine passes do we check software:
  ✅ Is SignalPoller configured in PM2?
  ✅ Is event-handler configured in PM2?
  ✅ Are they running?
  ✅ Can we start them if stopped?

If any of these fail → Try to recover, then abort.
```

## Example Scenarios

### Scenario 1: Machine Out of Memory
```
06:00 AM ET → Tier 0: RAM only 500MB free
             → FAIL: Machine cannot run software
             → STOP (don't even check services)
```

### Scenario 2: Service Crashed
```
06:00 AM ET → Tier 0: Machine has 4GB RAM free ✅
06:15 AM ET → Tier 1: SignalPoller stopped ❌
             → Try: pm2 start spxer
             → SUCCESS: Service restarted ✅
             → CONTINUE to trading
```

### Scenario 3: Service Errored and Won't Start
```
06:00 AM ET → Tier 0: Machine healthy ✅
06:15 AM ET → Tier 1: event-handler errored ❌
             → Try: pm2 delete event-handler
             → Try: pm2 start event-handler
             → FAIL: Command failed
             → Diagnosis: Port 3600 already in use
             → FAIL: Cannot trade (manual intervention needed)
```

## Daily Timeline

```
00 06:00 AM ET → Tier 0: Machine Fundamentals
                └─ FAIL HERE → STOP (machine can't run)

15 06:15 AM ET → Tier 1: Service Setup & Runtime
                └─ FAIL HERE → Try recovery, then abort

00 07:00 AM ET → Tiers 2-5: Early Infrastructure
50 07:50 AM ET → Tiers 6-10: Data Pipeline
30 08:30 AM ET → Start SPXer/SignalPoller
00 09:00 AM ET → Start Event Handler
XX 10:00 AM ET → Transition to Trading
```

## Installation

```bash
cd /home/ubuntu/SPXer
export AGENT_CONFIG_ID=your-config-id
./scripts/ops/setup-complete-automation.sh
```

This installs:
- Tier 0 check at 06:00 AM ET
- Tier 1 check at 06:15 AM ET
- Service startup at 08:30/09:00 AM ET
- All other tiers and transitions

---

**Key Principle**: Never check if the software is running until you've verified the machine can run it.

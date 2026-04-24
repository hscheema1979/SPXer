# Warmup Transition Time Calculator

## Quick Reference

For **HMA(3)×HMA(12)** crossover strategy, the transition time depends on your timeframe:

| Timeframe | Bars Needed | Minutes to Warmup | First HMA(12) Valid | Transition Time | Total Warmup |
|-----------|-------------|-------------------|---------------------|-----------------|--------------|
| **1m** | 12 | 12 min | 09:42 AM ET | 10:00 AM ET | 2 hours |
| **3m** | 12 | 36 min | 10:06 AM ET | 10:15 AM ET | 2h 15min |
| **5m** | 12 | 60 min | 10:30 AM ET | 10:45 AM ET | 2h 45min |
| **15m** | 12 | 180 min | 12:30 PM ET | 12:45 PM ET | 4h 45min |

## Calculation

```
Minutes to Warmup = HMA(slow) × Timeframe(minutes)
First Valid Time = Market Open (09:30) + Minutes to Warmup
Transition Time = First Valid Time + Buffer (9-15 minutes)
```

### For Your Config: 3m Timeframe

```
Minutes to Warmup = 12 × 3 = 36 minutes
First Valid Time = 09:30 + 36 = 10:06 AM ET
Transition Time = 10:06 + 9 = 10:15 AM ET
```

## Why Wait?

**Trading on backfilled indicators is dangerous:**

1. **CopyWarmupBars** seeds indicators with yesterday's data
2. HMA(12) needs 12 bars of **today's** data to be valid
3. Before that, you're trading on stale crossed signals
4. Waiting for first valid cross on today's data ensures:
   - Real market conditions
   - Valid signal on current price action
   - No opening-volatility artifacts

## Automated Calculation

Use the calculator script:

```bash
# For 3m timeframe with 15-min buffer
./scripts/ops/calculate-warmup-end.sh 12 3 15

# For 1m timeframe with 15-min buffer
./scripts/ops/calculate-warmup-end.sh 12 1 15

# For 5m timeframe with 15-min buffer
./scripts/ops/calculate-warmup-end.sh 12 5 15
```

Output:
```
Configuration:
  HMA Slow Period: 12
  Timeframe: 3m
  Buffer: 15 minutes

Calculation:
  Bars needed: 12
  Minutes per bar: 3m
  Total minutes: 36

Market opens: 09:30 AM ET
HMA(12) valid at: 10:06 AM ET

With 15m buffer: 10:21 AM ET

Recommended cron entry:
0 10 * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/transition-from-warmup.sh
```

## Setup for Different Timeframes

### 3m Timeframe (Your Config)

```bash
./scripts/ops/setup-8am-automation.sh
# Cron: 15 10 * * 1-5 ... (10:15 AM ET)
```

### 1m Timeframe

Edit the cron entry after setup:

```bash
crontab -e
# Change: 15 10 * * 1-5 ...
# To: 0 10 * * 1-5 ... (10:00 AM ET)
```

Or recalculate and install manually:

```bash
./scripts/ops/calculate-warmup-end.sh 12 1 15
# Use the recommended cron entry from output
```

## Timeline: 3m Timeframe

```
06:00 AM ET ── Early Infrastructure (Tiers 1-5)
             ── Tool functionality, readings, calculations, signal logic, config

07:00 AM ET ── Data Pipeline (Tiers 6-10)
             ── System visibility, E2E pipeline, state reconciliation, freshness

07:50 AM ET ── Pre-Market Validation (Tiers 11-17)
             ── Market state, financial, time decay, network, data quality, human, regulatory

08:00 AM ET ── Warmup Phase 1 Starts
             ── All checks passed, signal tracking begins
             ── Tracking on backfilled data (CopyWarmupBars)

09:30 AM ET ── Market Opens (still in WARMUP)

10:06 AM ET ── First Valid HMA(12) on 3m Timeframe
             ── 12th 3-minute bar closes
             ── HMA(12) now valid on today's data
             ── First possible HMA(3)×HMA(12) cross

10:06-10:15 AM ET ── Warmup Phase 2
                  ── Track REAL signals on today's market data
                  ── Verify signal quality
                  ── Check for opening volatility artifacts

10:15 AM ET ── Transition to SIMULATION/LIVE
             ── 9-minute buffer after first valid cross
             ── Now trading on validated signals from today's data
             ── Real orders to FakeBroker (SIMULATION) or Tradier (LIVE)
```

## Installation

```bash
cd /home/ubuntu/SPXer

# Install automation for 3m timeframe (default)
./scripts/ops/setup-8am-automation.sh

# Verify installation
crontab -l | grep SPXer

# Test warmup
./scripts/ops/start-warmup-with-checklist.sh

# Test transition at 10:15 AM ET
./scripts/ops/transition-from-warmup.sh
```

## Manual Transition

If you need to transition earlier or later:

```bash
# Manual transition (any time)
export WARMUP_TARGET_MODE=SIMULATION  # or LIVE
./scripts/ops/transition-from-warmup.sh
```

---

**Your Config**: HMA(3)×HMA(12) on **3m timeframe** → Transition at **10:15 AM ET**

**Version**: 1.0
**Last Updated**: 2026-04-24
**Status**: ✅ Operational

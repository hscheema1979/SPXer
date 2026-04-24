# Testing Checklist: Independent Services Architecture

## Architecture Note (v2.0)

**CRITICAL**: All services are now **100% independent** with direct Tradier API connections.

- ✅ **event-handler**: Independent of spxer — fetches from Tradier REST API directly
- ✅ **position-monitor**: Independent of spxer — fetches from Tradier REST API directly
- ✅ **spxer**: OPTIONAL — only needed for replay viewer, NOT required for live trading

**Testing must verify independence at every level.**

---

## Pre-Deployment Testing

### Phase 1: Unit Tests (Fast)

```bash
# Run all unit tests
npm run test

# Expected: All tests pass
# If any fail: Fix before proceeding
```

**Expected Results**:
- ✅ All core module tests pass
- ✅ All pipeline tests pass
- ✅ All storage tests pass
- ✅ No TypeScript compilation errors

---

### Phase 2: Independence Validation (Fast)

#### Test 1: Verify Event Handler Independence
```bash
# Stop spxer to prove independence
pm2 stop spxer

# Start event handler
export AGENT_PAPER=true
pm2 start ecosystem.config.js --only event-handler

# Wait 30 seconds for signal detection
sleep 30

# Check logs for independence
pm2 logs event-handler --lines 50 | grep -E "INDEPENDENT MODE|SIGNAL"

# Verify:
# - Logs show "INDEPENDENT MODE: No spxer dependency"
# - Signals detected (if market active)
# - NO WebSocket errors to localhost:3600
# - NO connection refused errors
```

**Expected Results**:
- ✅ Logs show `INDEPENDENT MODE: No spxer dependency - all data from Tradier REST API`
- ✅ Signals detected successfully (if market active)
- ✅ No `ECONNREFUSED 127.0.0.1:3600` errors
- ✅ No WebSocket connection attempts to spxer

**PASS** → Proceed to Test 2
**FAIL** → Event handler still depends on spxer — fix before proceeding

---

#### Test 2: Verify Position Monitor Independence
```bash
# Ensure spxer is still stopped
pm2 stop spxer

# Start position monitor
pm2 start ecosystem.config.js --only position-monitor

# Wait 30 seconds for polling cycle
sleep 30

# Check logs for independence
pm2 logs position-monitor --lines 50 | grep -E "INDEPENDENT|OBSERVER MODE"

# Verify:
# - Logs show "OBSERVER MODE - no execution"
# - Logs show "INDEPENDENT MODE: Fetching from Tradier REST API"
# - No errors fetching prices
# - NO dependency on spxer
```

**Expected Results**:
- ✅ Logs show `OBSERVER MODE - no execution`
- ✅ Logs show `INDEPENDENT MODE: Fetching from Tradier REST API (no spxer dependency)`
- ✅ No errors fetching option prices from Tradier
- ✅ No dependency on spxer REST API

**PASS** → Proceed to Test 3
**FAIL** → Position monitor still depends on spxer — fix before proceeding

---

#### Test 3: Verify Fault Isolation
```bash
# Start all three services
pm2 start ecosystem.config.js

# Verify all online
pm2 status

# Crash event-handler
pm2 stop event-handler

# Wait 30 seconds
sleep 30

# Verify position-monitor still running
pm2 status position-monitor

# Verify spxer still running (if started)
pm2 status spxer

# Restart event-handler
pm2 start event-handler

# Verify startup reconciliation works
pm2 logs event-handler --lines 30 | grep -E "startup reconciliation|regime validation"
```

**Expected Results**:
- ✅ position-monitor continues running when event-handler stops
- ✅ spxer continues running when event-handler stops
- ✅ Event handler restarts cleanly
- ✅ Startup reconciliation executes
- ✅ Regime validation executes

**PASS** → Proceed to Test 4
**FAIL** → Fault isolation broken — fix before proceeding

---

### Phase 3: Replay Testing (Medium)

#### Test 4: Multi-Day Expiry Validation
```bash
# Run replay across week with multiple expiries
npx tsx src/replay/cli.ts backtest \
  --config spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000 \
  --dates 2026-04-14,2026-04-15,2026-04-16,2026-04-17,2026-04-18

# Verify:
# - 4/14: Only 0DTE (Monday)
# - 4/15: Only 0DTE (Tuesday)
# - 4/16: Only 0DTE (Wednesday)
# - 4/17: Only 0DTE (Thursday)
# - 4/18: Only 0DTE (Friday)
# - No 1DTE or 2DTE orders
```

**Expected Results**:
- ✅ All trades use 0DTE contracts
- ✅ No overnight positions
- ✅ Expiry matches trading day

**PASS** → Proceed to Test 5
**FAIL** → Expiry validation broken — fix before proceeding

---

#### Test 5: Strike Selection Accuracy
```bash
# Test ITM5 config
npx tsx src/replay/cli.ts run \
  --config spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000 \
  --date 2026-04-22

# Extract all trades from results
sqlite3 data/spxer.db "
  SELECT entry_ts, symbol, strike, expiry, entry_price,
         strike - (SELECT AVG(close) FROM replay_bars WHERE symbol='SPX' AND ts < entry_ts ORDER BY ts DESC LIMIT 1) as distance_from_spx
  FROM replay_results
  WHERE config_id = 'spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000'
  AND date = '2026-04-22'
  ORDER BY entry_ts;
"
```

**Expected Results**:
- ✅ All strikes are ITM (distance_from_spx should be negative)
- ✅ Most strikes are around -$5 (ITM5)
- ✅ No outliers at -$15, -$20, etc.

**PASS** → Proceed to Phase 4
**FAIL** → Strike selection broken — fix before proceeding

---

### Phase 4: E2E Integration Testing (Slow)

#### Test 6: Full E2E Test Suite
```bash
# Run comprehensive E2E tests
npx vitest run tests/e2e/microservices-integration.test.ts
```

**Expected Results**:
- ✅ 14/14 tests passing
- ✅ Signal detection validated
- ✅ Database operations validated
- ✅ Service integration confirmed
- ✅ Fault isolation verified

**Test Coverage**:
1. Signal detection function (Tradier + HMA crosses)
2. account.db state management (shared)
3. Data service integration (optional)
4. Full pipeline integration
5. Fault isolation (event-handler crash)
6. Fault isolation (position-monitor crash)

**PASS** → Proceed to Phase 5
**FAIL** → E2E tests failing — fix before proceeding

---

### Phase 5: Paper Mode Testing (Slow)

#### Prerequisites
```bash
# Ensure services are running
pm2 status

# Ensure event handler is in paper mode
pm2 env event-handler | grep AGENT_PAPER
# Should show: AGENT_PAPER=true

# If not, set paper mode:
pm2 restart event-handler --update-env AGENT_PAPER=true
```

---

#### Test 7: Live Market Paper Trading
```bash
# Monitor event handler logs in real-time
pm2 logs event-handler --lines 100

# Wait for HMA cross signal (could be minutes to hours)

# When signal fires, verify logs show:
# [handler] [config-id] CALL SIGNAL: BULLISH/BEARISH at time
#   → Verify Tradier fetch successful
# [handler] [config-id] Selected strike: 7XXX (+/- X) | ITM/OTM selection...
#   → Verify strike distance matches config
# [handler] Position opened: SPXW... xX @ $XX.XX
#   → Verify symbol matches selected strike
#   → Verify expiry is TODAY's date
```

**Expected Results**:
- ✅ Signal detection works with live Tradier data
- ✅ Strike selection matches config
- ✅ Order executes in paper mode
- ✅ No spxer dependency errors

**PASS** → Proceed to Test 8
**FAIL** → Paper trading broken — fix before proceeding

---

#### Test 8: Multi-Config Paper Trading
```bash
# Test with multiple configs to ensure no cross-config interference
AGENT_CONFIG_IDS="spx-hma3x12-itm5-tp30x-sl20-3m-50c-$5000,spx-hma3x12-otm5-tp30x-sl20-3m-50c-$5000" \
  AGENT_PAPER=true \
  pm2 restart event-handler --update-env

# Monitor logs for both configs
# Verify:
# - ITM5 config places ITM orders
# - OTM5 config places OTM orders
# - No cross-contamination between configs
# - No spxer dependency
```

**Expected Results**:
- ✅ Both configs run independently
- ✅ Strike selection correct per config
- ✅ No cross-config interference
- ✅ No spxer dependency

**PASS** → Proceed to Test 9
**FAIL** → Multi-config broken — fix before proceeding

---

### Phase 6: Broker Verification

#### Test 9: Paper Orders at Tradier
```bash
# Check Tradier account for open positions
npx tsx scripts/show-basket-positions.ts

# Verify:
# - All open positions have TODAY's expiry
# - Strike distances match config expectations
# - No positions with wrong expiry or wrong strike
# - OCO brackets in place (TP + SL legs)
```

**Expected Results**:
- ✅ All positions have 0DTE expiry
- ✅ Strike distances match config
- ✅ OCO brackets protecting all positions
- ✅ No naked positions

**PASS** → Proceed to deployment
**FAIL** → Broker state incorrect — fix before proceeding

---

## Deployment Checklist

### Before Deploying to Production

- [ ] All unit tests pass
- [ ] Independence validation passes (Test 1-3)
- [ ] Replay tests pass (Test 4-5)
- [ ] E2E tests pass (14/14)
- [ ] Paper mode test on live market passes
- [ ] Multi-config paper test passes
- [ ] Broker verification confirms paper orders are correct
- [ ] Code reviewed by second person (if available)
- [ ] Independence verified (no spxer dependency)

### Production Deployment Steps

```bash
# 1. Verify code compiles
npx tsc --noEmit

# 2. Run E2E tests
npx vitest run tests/e2e/microservices-integration.test.ts

# 3. Stop all services
pm2 stop event-handler position-monitor

# 4. Pull latest code
git pull origin master

# 5. Restart event handler (INDEPENDENT)
pm2 start event-handler

# 6. Restart position monitor (INDEPENDENT)
pm2 start position-monitor

# 7. Verify logs show independence
pm2 logs event-handler --lines 20 | grep "INDEPENDENT MODE"
pm2 logs position-monitor --lines 20 | grep "INDEPENDENT"

# 8. Monitor for first trade
pm2 logs event-handler --lines 0
# Wait for signal, verify:
# - No spxer dependency
# - Tradier fetches working
# - Order executes correctly

# 9. Check broker after first trade
npx tsx scripts/show-basket-positions.ts

# 10. Save PM2 configuration
pm2 save
```

### Rollback Plan

If issues detected:

```bash
# Revert changes
git revert HEAD
git push

# Restart services
pm2 restart event-handler
pm2 restart position-monitor

# Or revert to previous working commit
git checkout <previous-working-commit>
pm2 restart event-handler
pm2 restart position-monitor
```

---

## Post-Deployment Monitoring

### First 24 Hours

- [ ] Monitor logs for any spxer dependency errors (should not appear)
- [ ] Verify independence in logs (should see "INDEPENDENT MODE")
- [ ] Verify all trades use 0DTE contracts
- [ ] Verify all trades use configured strike distance
- [ ] Check broker positions match expectations

### First Week

- [ ] Review P&L vs expected
- [ ] Check win rate vs historical
- [ ] Verify no positions left overnight (all 0DTE)
- [ ] Compare trade frequency vs previous versions
- [ ] Verify no spxer crashes affect live trading

### Ongoing

- [ ] Weekly review of all trades for expiry/strike accuracy
- [ ] Monthly replay validation against live results
- [ ] Quarterly config optimization
- [ ] Continuous independence verification

---

## Success Criteria

### Independence Validation
- ✅ event-handler runs without spxer
- ✅ position-monitor runs without spxer
- ✅ No WebSocket connection attempts to spxer
- ✅ All services use direct Tradier connections
- ✅ Fault isolation verified (crashes don't cascade)

### Expiry Validation
- ✅ 100% of trades use 0DTE contracts
- ✅ Zero trades using 1DTE or 2DTE contracts
- ✅ No orders placed after market close (4:15 PM ET)

### Strike Selection
- ✅ ITM configs: 95%+ of strikes within $3-$7 ITM
- ✅ OTM configs: 95%+ of strikes within $3-$7 OTM
- ✅ Zero outliers >$15 from configured distance

### System Stability
- ✅ No crashes or errors in logs
- ✅ No spxer dependency errors
- ✅ Orders execute within 2 seconds of signal
- ✅ P&L tracked accurately from broker

---

## Known Limitations

1. **Replay Viewer**: Requires spxer to be running for historical data access. This is by design — spxer is optional for live trading but required for replay.

2. **Independent Connections**: Each service maintains its own Tradier connection. This provides fault isolation but means 3x API connections. Monitor rate limits.

3. **Position Monitor**: Observer-only — does not execute trades. Event handler handles all actions (entries, exits, reversals).

4. **Backward Compatibility**: These changes improve fault isolation and independence. No config changes needed.

---

## Independence Verification Commands

### Quick Independence Check
```bash
# Stop spxer
pm2 stop spxer

# Verify event-handler still works
pm2 logs event-handler --lines 30 | grep -E "INDEPENDENT MODE|SIGNAL"

# Verify position-monitor still works
pm2 logs position-monitor --lines 30 | grep -E "INDEPENDENT|OBSERVER"

# Result: ✅ Both services work without spxer
```

### Comprehensive Independence Check
```bash
# Stop spxer
pm2 stop spxer

# Wait 1 minute
sleep 60

# Check for any spxer dependency errors
pm2 logs --err --lines 100 | grep -E "localhost:3600|ECONNREFUSED|WebSocket.*spxer"

# Should return: (empty - no errors)

# Verify signals detected
pm2 logs event-handler --lines 50 | grep "SIGNAL"

# Verify position-monitor observing
pm2 logs position-monitor --lines 50 | grep "position"

# Result: ✅ Full independence confirmed
```

---

## Contact

For questions or issues:
- Check logs: `pm2 logs event-handler --lines 1000`
- Check position-monitor: `pm2 logs position-monitor --lines 1000`
- Review trade history: `npx tsx scripts/show-basket-positions.ts`
- Run replay: `npx tsx src/replay/cli.ts run --config <id> --date <YYYY-MM-DD>`
- Run E2E tests: `npx vitest run tests/e2e/microservices-integration.test.ts`

---

## Testing Checklist Version

**Version**: 2.0 (Independent Services)
**Last Updated**: 2026-04-24
**Owner**: SPXer Operations Team

# Event Handler R&R — Quick Start Guide

**Created**: 2026-04-23
**Status**: Ready for implementation
**Time Estimate**: 3-5 days focused work

---

## 📋 Summary of Documents

1. **R&R Plan** (`docs/EVENT_HANDLER_RR_PLAN.md`)
   - Full migration plan with phases
   - Edge case analysis
   - Success criteria

2. **Implementation Guide** (`docs/EVENT_HANDLER_IMPLEMENTATION.md`)
   - Code-level fixes for critical issues
   - Step-by-step implementation
   - Testing checklist

3. **Architecture Reference** (`docs/EVENT_HANDLER_ARCHITECTURE.md`)
   - System diagrams
   - Data flow examples
   - Monitoring setup

---

## 🚨 Critical Issues (Fix First)

### 1. Exit Polling Robustness
**Risk**: Position state drift → missed exits or double-close attempts

**Fix Location**: `event_handler_mvp.ts` → `checkExits()`

**Action Items**:
- [ ] Add `fetchBrokerPositions()` to `src/agent/broker-pnl.ts`
- [ ] Add `safeClosePosition()` wrapper with broker state check
- [ ] Update exit loop to handle broker-confirmed closes

**Time**: 2-3 hours

**Test**: Mock close failure, verify broker state check works

---

### 2. State Persistence
**Risk**: Handler crash → lost positions, no recovery

**Fix Location**: New file `src/agent/handler-persistence.ts`

**Action Items**:
- [ ] Create persistence module (snapshot save/load)
- [ ] Add snapshot timer (30s interval)
- [ ] Load snapshot on startup before reconciliation
- [ ] Add snapshot to graceful shutdown

**Time**: 3-4 hours

**Test**: Kill handler during open position, restart → position restored

---

### 3. OCO Protection Retry
**Risk**: OCO submission fails → position unprotected → catastrophic loss

**Fix Location**: `event_handler_mvp.ts` → `submitOcoProtection()`

**Action Items**:
- [ ] Add retry with exponential backoff (4 attempts)
- [ ] Add critical alert log on final failure
- [ ] Add safety close if OCO fails completely
- [ ] Add `checkExistingOco()` to skip duplicates

**Time**: 2-3 hours

**Test**: Mock Tradier errors, verify retry + critical alert

---

### 4. Signal Deduplication
**Risk**: Same signal processed twice → double entry

**Fix Location**: `event_handler_mvp.ts` → `handleContractSignal()`

**Action Items**:
- [ ] Add `signalHash()` function
- [ ] Add `seenSignals` Map with 5-second window
- [ ] Add hash cleanup (10-second timeout)
- [ ] Check dedup before processing

**Time**: 1-2 hours

**Test**: Send same signal twice → second one skipped

---

### 5. Entry Lock per Config
**Risk**: Multiple signals before entry completes → over-entry

**Fix Location**: `event_handler_mvp.ts` → `handleContractSignal()`

**Action Items**:
- [ ] Add `entryLocks` Map<configId, Promise>
- [ ] Check lock before entry
- [ ] Release lock in finally block
- [ ] Add 60-second timeout force-release

**Time**: 2-3 hours

**Test**: Send two signals rapidly → second one waits

---

## 📊 Priority Matrix

```
                │ Low Impact │ High Impact │
────────────────┼────────────┼─────────────│
Quick Fix (1-2h)│            │ Signal Dedup│
Medium Fix (3-4h)│            │ Entry Lock  │
Long Fix (5-8h)  │            │ Exit Polling│
                │            │ State Persist│
                │            │ OCO Retry   │
                │            │             │
                └────────────┴─────────────┘
```

**Recommended Order**:
1. OCO Retry (highest risk, catastrophic loss)
2. Exit Polling (high risk, P&L impact)
3. State Persistence (high risk, data loss)
4. Signal Deduplication (medium risk, double entry)
5. Entry Lock (medium risk, over-entry)

---

## 🛠️ Implementation Workflow

### Day 1: Critical Fixes (OCO + Exit)

```bash
# Morning: OCO Retry
git checkout -b feature/oco-retry
# Implement OCO retry (2-3 hours)
# Test locally
npm test

# Afternoon: Exit Polling
# Implement safeClosePosition (2-3 hours)
# Test locally
npm test

# Evening: Deploy to staging
git push origin feature/oco-retry
pm2 restart event-handler --update-env

# Monitor overnight
tail -f logs/critical-alerts.jsonl  # Should be empty
```

### Day 2: State Persistence

```bash
# Morning: Persistence module
# Implement handler-persistence.ts (3-4 hours)
# Test: kill handler, restart, verify restore
npm test

# Afternoon: Deploy to staging
git commit -am "Add state persistence"
git push

# Monitor: check snapshot file exists
ls -lh logs/handler-snapshot.json
```

### Day 3: Deduplication + Entry Lock

```bash
# Morning: Signal deduplication (1-2 hours)
# Implement signal hash + dedup check
npm test

# Afternoon: Entry lock (2-3 hours)
# Implement entry locks + timeout
npm test

# Evening: Deploy to staging
git commit -am "Add signal deduplication and entry locks"
git push

# Monitor: check logs for duplicate skips
grep "Duplicate signal" logs/handler-out.log | wc -l
```

### Day 4: Integration Testing

```bash
# Full-day paper test
AGENT_CONFIG_ID="spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000" AGENT_PAPER=true npx tsx event_handler_mvp.ts

# Monitor checklist:
- [ ] Zero crashes
- [ ] Zero critical alerts
- [ ] All signals routed correctly
- [ ] Exits execute on TP/SL
- [ ] P&L matches broker
```

### Day 5: Production Deployment

```bash
# Morning: Deploy to production
git checkout main
git merge feature/oco-retry
pm2 restart event-handler

# Monitor closely for 3 hours
tail -f logs/event-handler-out.log

# Afternoon: If all good, archive old agent
mkdir -p archive/removed-2026-04-23
mv spx_agent.ts archive/removed-2026-04-23/

# Evening: Update docs
vi CLAUDE.md  # Update architecture section
pm2 save
```

---

## ✅ Pre-Deployment Checklist

### Code Readiness
- [ ] All 5 critical fixes implemented
- [ ] Unit tests pass (`npm test`)
- [ ] Integration tests pass
- [ ] Code reviewed
- [ ] Documentation updated

### Monitoring Setup
- [ ] `logs/critical-alerts.jsonl` monitored (alert if any entry)
- [ ] `logs/handler-snapshot.json` exists and <60s old
- [ ] `logs/handler-dlq.jsonl` size <100
- [ ] Admin panel shows real-time state

### Rollback Plan
- [ ] Old `spx_agent.ts` in `archive/` (not deleted)
- [ ] Can revert in <5 minutes
- [ ] Broker positions survive restart

### Testing Complete
- [ ] Full trading day paper test passed
- [ ] Chaos tests passed (crash during entry/exit)
- [ ] WebSocket reconnect test passed
- [ ] Tradier API rate limit test passed

---

## 🔧 Troubleshooting

### Issue: "Snapshot too old" warning

**Cause**: Snapshot file is >24 hours old

**Fix**:
```bash
# Remove old snapshot
rm logs/handler-snapshot.json
# Handler will start fresh
pm2 restart event-handler
```

---

### Issue: "Position already closed at broker" log spam

**Cause**: TP/SL filled at broker, handler hasn't detected yet

**Fix**: This is normal! Handler reconciliation will pick it up within 60s

---

### Issue: "Entry already in progress" skips legitimate signals

**Cause**: Entry lock held too long (>60s)

**Fix**:
```bash
# Check for hung locks
grep "Entry timeout" logs/event-handler-error.log
# If found, handler should auto-release locks
# If not, restart handler
pm2 restart event-handler
```

---

### Issue: "Critical alert: OCO protection failed"

**Cause**: Tradier API down or rate limited

**Fix**:
1. **Immediate**: Check Tradier status page
2. **If Tradier down**: Wait for recovery, handler will retry
3. **If rate limited**: Reduce signal frequency (adjust config)
4. **After recovery**: Check `logs/critical-alerts.jsonl` for affected positions
5. **Manual check**: Verify positions at broker have OCO protection

---

## 📈 Success Metrics

### Technical
- **Zero crashes** during full trading day
- **Zero critical alerts** (unprotected positions)
- **DLQ size** <10 entries per day
- **Exit success rate** >99.5%
- **Snapshot age** <60s
- **Signal-to-entry latency** <2 seconds

### Business
- **P&L matches broker** within 0.1%
- **No missed entries** due to edge cases
- **No double entries** due to race conditions
- **All positions** have OCO protection

### Operational
- **WebSocket reconnect** works automatically
- **Handler crash** recovery works (snapshot restore)
- **Network partition** doesn't lose state
- **Tradier API errors** handled gracefully

---

## 📞 Escalation Path

### Level 1: Automated Recovery
- **Issue**: Handler crash
- **Action**: PM2 auto-restart, snapshot restore

### Level 2: Ops Monitoring
- **Issue**: Critical alert logged
- **Action**: Page on-call, check broker manually

### Level 3: Manual Intervention
- **Issue**: Handler can't recover automatically
- **Action**: Stop handler, reconcile broker manually, restart

### Level 4: Rollback
- **Issue**: New bugs in event handler
- **Action**: Revert to polling agent (`spx_agent.ts`)

---

## 📚 Related Documentation

- `CLAUDE.md` — Full system architecture
- `EVENT_HANDLER_E2E_SUCCESS.md` — Original validation
- `docs/EVENT_HANDLER_RR_PLAN.md` — Full migration plan
- `docs/EVENT_HANDLER_IMPLEMENTATION.md` — Code fixes
- `docs/EVENT_HANDLER_ARCHITECTURE.md` — System diagrams

---

## 🎯 Next Steps

1. **Read** the full R&R plan (`docs/EVENT_HANDLER_RR_PLAN.md`)
2. **Review** the implementation guide (`docs/EVENT_HANDLER_IMPLEMENTATION.md`)
3. **Create** the dev branch: `git checkout -b feature/event-handler-edge-cases`
4. **Start** with OCO retry (highest priority)
5. **Test** each fix before moving to the next
6. **Deploy** to staging after each fix
7. **Monitor** closely for 1 full trading day
8. **Deploy** to production when confident

---

**Questions?**
- Check the architecture diagrams (`docs/EVENT_HANDLER_ARCHITECTURE.md`)
- Review the full implementation guide (`docs/EVENT_HANDLER_IMPLEMENTATION.md`)
- Refer to the troubleshooting section above

**Good luck! 🚀**

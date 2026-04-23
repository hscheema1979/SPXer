# Event-Driven Architecture — R&R (Remove & Replace) Plan

**Date**: 2026-04-23
**Status**: CLEAN SLATE PLAN
**Goal**: Fix all edge cases, ensure production readiness, eliminate polling agent completely

---

## Phase 0: Current State Audit

### What's Working
- ✅ Data service emits `contract_signal` events (`src/index.ts:586-665`)
- ✅ WebSocket channel routing (`contract_signal:hma_3_12`, etc.)
- ✅ Event handler receives signals and executes trades
- ✅ Basic position tracking (Map<configId, Map<posId, Position>>)
- ✅ Basket member tracking (strike offsets)
- ✅ Risk gates (max positions, time window, cooldown, etc.)
- ✅ Startup reconciliation (adopt orphaned positions)
- ✅ Admin panel integration (handler-state files)
- ✅ E2E validated (live paper trade executed 2026-04-22)

### What's Broken / Missing

#### Critical Issues
1. **Exit polling has edge cases**
   - Price fetch failures not handled gracefully
   - Position state can drift from broker state
   - No retry logic for failed exits
   - Race condition: broker closes position (TP/SL fill) → handler doesn't know → tries to close again

2. **Strike selection has edge cases**
   - No validation that signal strike exists in active contracts
   - No fallback if selected strike has 0 volume
   - Signal strike ≠ selected strike logic is confusing (see handler:413-417)

3. **State persistence issues**
   - All state is in-memory (process crash = lost positions)
   - No recovery plan for handler restart during trading day
   - `pendingEntries` Map not persisted (lost on crash)

4. **Error handling gaps**
   - OCO submission failures are logged but position stays open
   - Network errors during entry: position half-open (broker has it, handler doesn't)
   - No exponential backoff for API rate limits
   - No dead letter queue for failed signals

5. **Race conditions**
   - Multiple signals arrive for same config before entry completes
   - Reconciliation runs while signals are processing
   - WebSocket disconnect/reconnect mid-signal

6. **Multi-config edge cases**
   - Two configs with same HMA pair: both see the same signal
   - Basket configs: 3 strikes enter simultaneously → partial fills → what then?
   - Config reload mid-signal: old config or new config logic?

#### Medium Issues
7. **Monitoring gaps**
   - No alerting on exit polling failures
   - No metrics on signal-to-entry latency
   - No audit trail for position lifecycle changes

8. **Testing gaps**
   - No integration tests for WebSocket reconnect
   - No chaos testing (kill handler during trade)
   - No tests for OCO edge cases (partial fills, rejection)

---

## Phase 1: Remove Polling Agent (Safe Cleanup)

### Goal: Eliminate `spx_agent.ts` after event handler is proven

#### Tasks
1. **Verify event handler parity with polling agent**
   - [ ] Test event handler with same config for 1 full trading day (paper mode)
   - [ ] Compare signal detection count (should be identical)
   - [ ] Compare P&L (should be similar, slight differences expected due to latency)
   - [ ] Verify all risk gates work identically

2. **Document differences (if any)**
   - [ ] Latency: ~1 second vs 10-30 seconds (event handler faster)
   - [ ] Signal filtering: event handler filters at HMA pair level, polling agent fetches all
   - [ ] Position tracking: identical (both use Map)

3. **Final validation checklist**
   - [ ] Replay system still uses `detectSignals()` (no changes to core)
   - [ ] Event handler doesn't modify `src/core/` modules
   - [ ] All configs tested in replay work in event handler
   - [ ] Admin panel shows real-time state correctly

4. **Remove `spx_agent.ts` and references**
   ```bash
   # Archive, don't delete (for reference if needed)
   mkdir -p archive/removed-2026-04-23
   mv spx_agent.ts archive/removed-2026-04-23/
   ```

5. **Update `ecosystem.config.js`**
   - Remove commented-out `spxer-agent` block (lines 73-97)
   - Clean up comments

---

## Phase 2: Fix Critical Edge Cases

### 2.1 Exit Polling Robustness

**Problem**: Position state can drift from broker, causing double-close attempts or missed exits.

**Solution**: Three-layer reconciliation

```typescript
// Layer 1: Poll exits every 10s (current implementation)
// Layer 2: Broker state sync every 60s (current implementation)
// Layer 3: On exit failure, query broker for position state
async function safeClosePosition(
  position: OpenPosition,
  reason: string,
  price: number,
  paper: boolean,
  execution: Execution
): Promise<boolean> {
  // Attempt close
  try {
    await closePosition(position, reason, price, paper, execution);
    return true;
  } catch (e: any) {
    // Close failed — check if broker already closed it
    const brokerPositions = await fetchBrokerPositions(TRADIER_ACCOUNT_ID);
    const stillOpen = brokerPositions.some(p => p.symbol === position.symbol);

    if (!stillOpen) {
      // Broker closed it (TP/SL fill), update local state
      console.log(`[handler] Position ${position.symbol} already closed at broker (likely TP/SL fill)`);
      return true;
    } else {
      // Still open — this is a real error
      console.error(`[handler] Failed to close ${position.symbol} and still open at broker:`, e.message);
      return false;
    }
  }
}
```

**Implementation**:
- [ ] Add `fetchBrokerPositions()` to `src/agent/broker-pnl.ts`
- [ ] Update `checkExits()` to use `safeClosePosition()`
- [ ] Add retry logic: if close fails, retry once after 5 seconds
- [ ] Log all exit failures to dedicated `logs/exit-failures.jsonl`

### 2.2 Strike Selection Validation

**Problem**: Signal strike might not exist in active contracts (e.g., signal delayed, contract expired).

**Solution**: Graceful degradation with fallback

```typescript
// In handleContractSignal()
const candidates = activeContracts
  .filter((c: any) => {
    const expiryMatch = c.symbol.includes(signal.expiry);
    const sideMatch = signal.side === 'call' ? c.symbol.includes('C') : c.symbol.includes('P');
    return expiryMatch && sideMatch && c.last > 0 && c.volume > 0; // Add volume filter
  })
  .map((c: any) => ({ ... }));

if (candidates.length === 0) {
  routingDecisions.push({ configId, action: 'skipped', reason: 'no_candidates', details: 'No active contracts for signal expiry/side' });
  continue;
}

const strikeResult = selectStrike(candidates, signal.direction, spxPrice, cfg);

// NEW: Validate selected strike is within acceptable range
const signalStrikeDistance = Math.abs(signal.strike - spxPrice);
const selectedStrikeDistance = Math.abs(strikeResult.candidate.strike - spxPrice);

if (Math.abs(signalStrikeDistance - selectedStrikeDistance) > 15) {
  // Selected strike is >$15 away from signal strike — suspicious
  console.warn(`[handler] [${configId}] Strike selection suspicious: signal=${signal.strike} (Δ${signalStrikeDistance}) vs selected=${strikeResult.candidate.strike} (Δ${selectedStrikeDistance})`);
  routingDecisions.push({ configId, action: 'skipped', reason: 'strike_mismatch_too_large', details: `Signal Δ${signalStrikeDistance} vs selected Δ${selectedStrikeDistance}` });
  continue;
}
```

**Implementation**:
- [ ] Add volume filter to candidates
- [ ] Add strike distance validation
- [ ] Log suspicious skips to routing log

### 2.3 State Persistence

**Problem**: Handler crash = lost positions, pending entries, P&L state.

**Solution**: Periodic state snapshots to disk

```typescript
// New file: src/agent/handler-persistence.ts
interface HandlerSnapshot {
  version: 1;
  ts: number;
  configs: Record<string, {
    positions: Array<OpenPosition>;
    lastEntryTs: number;
    dailyPnl: number;
    tradesCompleted: number;
    sessionSignalCount: number;
    basketMembers: Array<{ posId: string; memberId: string }>;
  }>;
  pendingEntries: Array<{ configId: string; symbol: string }>;
}

export function saveSnapshot(state: Map<string, ConfigState>): void {
  const snapshot: HandlerSnapshot = {
    version: 1,
    ts: Date.now(),
    configs: {},
    pendingEntries: [],
  };

  for (const [configId, cfgState] of state) {
    snapshot.configs[configId] = {
      positions: Array.from(cfgState.positions.values()),
      lastEntryTs: cfgState.lastEntryTs,
      dailyPnl: cfgState.dailyPnl,
      tradesCompleted: cfgState.tradesCompleted,
      sessionSignalCount: cfgState.sessionSignalCount,
      basketMembers: Array.from(cfgState.basketMembers.entries()).map(([posId, memberId]) => ({ posId, memberId })),
    };
  }

  // Write to logs/handler-snapshot.json (atomic write via temp file)
  const tmpPath = 'logs/handler-snapshot.json.tmp';
  const finalPath = 'logs/handler-snapshot.json';
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

export function loadSnapshot(): Map<string, ConfigState> | null {
  try {
    const raw = fs.readFileSync('logs/handler-snapshot.json', 'utf-8');
    const snapshot = JSON.parse(raw) as HandlerSnapshot;

    // Check age — reject if >24 hours old
    if (Date.now() - snapshot.ts > 24 * 60 * 60 * 1000) {
      console.warn('[handler] Snapshot too old (>24h), ignoring');
      return null;
    }

    // Reconstruct ConfigState Map
    const state = new Map<string, ConfigState>();
    for (const [configId, cfg] of Object.entries(snapshot.configs)) {
      const positions = new Map<string, OpenPosition>();
      for (const pos of cfg.positions) {
        positions.set(pos.id, pos);
      }

      const basketMembers = new Map<string, string>();
      for (const { posId, memberId } of cfg.basketMembers) {
        basketMembers.set(posId, memberId);
      }

      state.set(configId, {
        config: /* load from DB */,
        positions,
        lastEntryTs: cfg.lastEntryTs,
        dailyPnl: cfg.dailyPnl,
        tradesCompleted: cfg.tradesCompleted,
        sessionSignalCount: cfg.sessionSignalCount,
        basketMembers,
      });
    }

    console.log(`[handler] Loaded snapshot from ${new Date(snapshot.ts).toISOString()} (${state.size} configs)`);
    return state;
  } catch (e) {
    console.log('[handler] No snapshot found (clean start)');
    return null;
  }
}

// In event_handler_mvp.ts main():
const restored = loadSnapshot();
if (restored) {
  // Merge with loaded configs
  for (const [configId, snapshotState] of restored) {
    const configState = configs.get(configId);
    if (configState) {
      configState.positions = snapshotState.positions;
      configState.lastEntryTs = snapshotState.lastEntryTs;
      configState.dailyPnl = snapshotState.dailyPnl;
      configState.tradesCompleted = snapshotState.tradesCompleted;
      configState.sessionSignalCount = snapshotState.sessionSignalCount;
      configState.basketMembers = snapshotState.basketMembers;
      console.log(`[handler] Restored state for ${configId}: ${configState.positions.size} positions`);
    }
  }
}

// Save snapshot every 30 seconds
setInterval(() => {
  saveSnapshot(configs);
}, 30_000);
```

**Implementation**:
- [ ] Create `src/agent/handler-persistence.ts`
- [ ] Add snapshot save every 30s
- [ ] Add snapshot load on startup
- [ ] Add snapshot age check (<24h)
- [ ] Test: start handler, open position, kill handler, restart → position restored

### 2.4 Error Handling & Dead Letter Queue

**Problem**: Failed entries/signal processing are lost forever.

**Solution**: Dead letter queue with retry

```typescript
// New file: src/agent/dead-letter-queue.ts
interface FailedSignal {
  signal: any;
  configId: string;
  error: string;
  ts: number;
  retryCount: number;
}

const DLQ_FILE = 'logs/handler-dlq.jsonl';
const MAX_RETRIES = 3;

export function enqueueFailedSignal(signal: any, configId: string, error: string): void {
  const entry: FailedSignal = {
    signal,
    configId,
    error,
    ts: Date.now(),
    retryCount: 0,
  };
  fs.appendFileSync(DLQ_FILE, JSON.stringify(entry) + '\n');
}

export function retryFailedSignals(): FailedSignal[] {
  try {
    const content = fs.readFileSync(DLQ_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) return [];

    const entries: FailedSignal[] = lines.map(l => JSON.parse(l));

    // Filter for retryable entries (transient errors only)
    const retryable = entries.filter(e =>
      e.retryCount < MAX_RETRIES &&
      (e.error.includes('timeout') ||
       e.error.includes('ECONNRESET') ||
       e.error.includes('rate limit'))
    );

    if (retryable.length === 0) return [];

    // Clear file and rewrite with updated retry counts
    fs.writeFileSync(DLQ_FILE, '');
    for (const entry of entries) {
      if (retryable.includes(entry)) {
        entry.retryCount++;
      }
      if (entry.retryCount < MAX_RETRIES) {
        fs.appendFileSync(DLQ_FILE, JSON.stringify(entry) + '\n');
      }
    }

    return retryable;
  } catch (e) {
    return [];
  }
}

// In event_handler_mvp.ts:
setInterval(() => {
  const retryEntries = retryFailedSignals();
  for (const entry of retryEntries) {
    console.log(`[handler] Retrying signal for ${entry.signal.symbol} (attempt ${entry.retryCount})`);
    handleContractSignal(entry.signal).catch(e => {
      console.error(`[handler] Retry failed:`, e.message);
      enqueueFailedSignal(entry.signal, entry.configId, e.message);
    });
  }
}, 60_000);

// Wrap handleContractSignal to catch and enqueue
async function safeHandleSignal(signal: any): Promise<void> {
  try {
    await handleContractSignal(signal);
  } catch (e: any) {
    if (e.message.includes('timeout') || e.message.includes('ECONNRESET') || e.message.includes('rate limit')) {
      // Transient error — enqueue for retry
      for (const [configId] of configs) {
        enqueueFailedSignal(signal, configId, e.message);
      }
    } else {
      // Fatal error — just log
      console.error('[handler] Fatal signal handling error:', e.message);
    }
  }
}
```

**Implementation**:
- [ ] Create `src/agent/dead-letter-queue.ts`
- [ ] Add DLQ retry every 60s
- [ ] Wrap `handleContractSignal()` in error handler
- [ ] Monitor DLQ size (alert if >100 entries)

### 2.5 Race Condition Prevention

**Problem**: Multiple signals for same config arrive before entry completes → over-entry.

**Solution**: Signal deduplication + entry lock per config

```typescript
// In event_handler_mvp.ts:
const entryLocks = new Map<string, Promise<void>>(); // configId → entry promise

async function handleContractSignal(signal: any): Promise<void> {
  // ... existing code ...

  for (const [configId, state] of configStatesArray) {
    // Check if entry is in progress
    const existingLock = entryLocks.get(configId);
    if (existingLock) {
      console.log(`[handler] [${configId}] Entry already in progress, skipping signal`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'entry_in_progress' });
      continue;
    }

    // Create entry lock
    const entryPromise = (async () => {
      try {
        // ... existing entry logic ...
      } finally {
        entryLocks.delete(configId);
      }
    })();

    entryLocks.set(configId, entryPromise);
    await entryPromise;
  }
}
```

**Implementation**:
- [ ] Add `entryLocks` Map to handler
- [ ] Check lock before entry
- [ ] Release lock in finally block
- [ ] Add timeout: if lock held >60s, force release

### 2.6 Multi-Config Signal Deduplication

**Problem**: Two configs with same HMA pair both see the same signal → double entry for same trade.

**Solution**: Signal hash deduplication (time window: 5 seconds)

```typescript
const seenSignals = new Map<string, number>(); // hash → timestamp

function signalHash(signal: any): string {
  return `${signal.symbol}:${signal.hmaFastPeriod}x${signal.hmaSlowPeriod}:${signal.direction}:${Math.floor(signal.timestamp / 5000)}`;
}

async function handleContractSignal(signal: any): Promise<void> {
  const hash = signalHash(signal);
  const now = Date.now();

  if (seenSignals.has(hash)) {
    const lastSeen = seenSignals.get(hash)!;
    if (now - lastSeen < 5000) {
      console.log(`[handler] Duplicate signal ${hash}, skipping`);
      return;
    }
  }

  seenSignals.set(hash, now);

  // Clean old hashes (>10s)
  for (const [h, ts] of seenSignals) {
    if (now - ts > 10000) {
      seenSignals.delete(h);
    }
  }

  // ... existing logic ...
}
```

**Implementation**:
- [ ] Add signal hash function
- [ ] Add deduplication check
- [ ] Add hash cleanup
- [ ] Test: send same signal twice → second one skipped

### 2.7 OCO Protection Edge Cases

**Problem**: OCO submission fails → position is open but unprotected → catastrophic loss possible.

**Solution**: Retry with escalation + manual intervention flag

```typescript
// In submitOcoProtection():
async function submitOcoProtectionWithRetry(pos: OpenPosition, accountId: string): Promise<boolean> {
  const backoffs = [500, 2000, 5000, 10_000];
  let lastErr: string | undefined;

  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    try {
      await submitOcoProtection(pos, accountId);
      return true;
    } catch (e: any) {
      lastErr = e?.response?.data?.errors?.error || e.message;
      console.warn(`[handler] OCO attempt ${attempt + 1}/${backoffs.length} failed: ${lastErr}`);

      if (attempt < backoffs.length - 1) {
        await new Promise(r => setTimeout(r, backoffs[attempt]));
      }
    }
  }

  // All retries failed — this is critical
  console.error(`[handler] 🚨 CRITICAL: Failed to submit OCO for ${pos.symbol} after ${backoffs.length} attempts: ${lastErr}`);
  console.error(`[handler] Position is UNPROTECTED at broker. MANUAL INTERVENTION REQUIRED.`);

  // Write to alert file for monitoring system
  fs.appendFileSync('logs/critical-alerts.jsonl', JSON.stringify({
    ts: Date.now(),
    level: 'CRITICAL',
    message: `OCO protection failed for ${pos.symbol}`,
    position: pos,
    error: lastErr,
  }) + '\n');

  return false;
}

// In handleContractSignal(), after openPosition():
const ocoSuccess = await submitOcoProtectionWithRetry(result.position, TRADIER_ACCOUNT_ID);
if (!ocoSuccess) {
  // Consider closing the position immediately if unprotected
  console.warn(`[handler] Closing unprotected position ${result.position.symbol}`);
  await closePosition(result.position, 'oco_failed', result.execution.fillPrice || result.position.entryPrice, configPaper, EXECUTION);
  state.positions.delete(result.position.id);
}
```

**Implementation**:
- [ ] Add OCO retry with backoff
- [ ] Add critical alert log
- [ ] Add auto-close for unprotected positions (configurable)
- [ ] Set up monitoring for `logs/critical-alerts.jsonl`

---

## Phase 3: Testing & Validation

### 3.1 Unit Tests

```bash
# Create tests/agent/event-handler.test.ts
describe('Event Handler Edge Cases', () => {
  test('Exit polling handles missing price data', async () => {
    // Mock price fetch failure
    // Verify exit check doesn't crash
  });

  test('Strike selection falls back if signal strike missing', async () => {
    // Mock active contracts without signal strike
    // Verify graceful skip
  });

  test('State snapshot saves and restores', async () => {
    // Create position, save snapshot
    // Clear state, restore snapshot
    // Verify positions restored
  });

  test('Signal deduplication works', async () => {
    // Send same signal twice
    // Verify second one skipped
  });

  test('Entry lock prevents double entry', async () => {
    // Send two signals for same config
    // Verify second one waits or skips
  });
});
```

### 3.2 Integration Tests

```bash
# Test WebSocket reconnect
test('WebSocket reconnect resumes subscription', async () => {
  // Start handler, verify connected
  // Kill data service, verify reconnect
  // Verify subscriptions restored
});

# Test partial fill scenario
test('Partial fill on OCO submission', async () => {
  // Mock Tradier partial fill response
  // Verify handler handles correctly
});

# Test broker state drift
test('Broker closes position, handler detects', async () => {
  // Open position in handler
  // Mock broker closing it
  // Verify handler reconciliation picks it up
});
```

### 3.3 Chaos Testing

```bash
# Test: Kill handler during entry
test('Handler crash during entry', async () => {
  // Send signal, handler starts entry
  // Kill handler mid-entry
  // Restart handler
  // Verify: position either fully entered OR not entered at all (no half-state)
});

# Test: Network partition
test('Network partition during exit', async () => {
  // Mock network timeout on close
  // Verify retry logic works
});

# Test: OCO failure
test('OCO submission fails repeatedly', async () => {
  // Mock Tradier error responses
  // Verify critical alert logged
  // Verify position closed if unprotected
});
```

### 3.4 Full-Day Paper Test

**Run for 1 full trading day (9:30 AM - 4:00 PM ET) in paper mode:**

```bash
# Terminal 1: Data service
pm2 logs spxer --lines 0

# Terminal 2: Event handler (paper mode)
AGENT_CONFIG_ID="spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000" AGENT_PAPER=true npx tsx event_handler_mvp.ts

# Terminal 3: Monitor
tail -f logs/handler-routing.jsonl | jq '{timeET: .timeET, symbol: .signal.symbol, decisions: [.decisions[] | {config: .configId, action: .action, reason: .reason}]}'
```

**Success criteria:**
- [ ] Zero crashes
- [ ] All signals routed correctly (check routing log)
- [ ] All risk gates working
- [ ] Exits execute on TP/SL/reversal
- [ ] P&L tracked correctly (matches broker)
- [ ] Zero critical alerts in `logs/critical-alerts.jsonl`

---

## Phase 4: Production Deployment

### 4.1 Pre-Flight Checklist

**Code readiness:**
- [ ] All Phase 2 edge cases implemented
- [ ] All Phase 3 tests passing
- [ ] Code reviewed
- [ ] Documentation updated (`CLAUDE.md`, `EVENT_HANDLER_E2E_SUCCESS.md`)

**Monitoring setup:**
- [ ] Logs rotated (`logs/handler-*.log` → daily archive)
- [ ] Critical alert monitoring (`logs/critical-alerts.jsonl` → alerting system)
- [ ] Dead letter queue monitoring (size >100 → page)
- [ ] State snapshot backup (copy to GDrive hourly)

**Rollback plan:**
- [ ] Old `spx_agent.ts` archived but not deleted
- [ ] Can revert in <5 minutes if needed
- [ ] Broker positions survive handler restart (reconciliation)

### 4.2 Gradual Rollout

**Week 1: Paper mode validation**
```bash
# Run event handler in paper mode alongside data service
pm2 start ecosystem.config.js --only event-handler
# Verify stable for 5 trading days
```

**Week 2: Small live test**
```bash
# Switch event-handler to live mode with small config
# Edit ecosystem.config.js line 64:
env: {
  AGENT_PAPER: 'false',
  AGENT_CONFIG_ID: 'spx-hma3x12-itm5-tp10x-sl25-3m-15c-$1000',  // Small size
}
pm2 restart event-handler
# Monitor closely for 3 days
```

**Week 3: Full deployment**
```bash
# Switch to normal config size
env: {
  AGENT_PAPER: 'false',
  AGENT_CONFIG_ID: 'spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000',  // Normal size
}
pm2 restart event-handler
# Monitor for 1 week
```

**Week 4: Cleanup**
```bash
# If all good, archive spx_agent.ts permanently
mkdir -p archive/removed-2026-04-23
mv spx_agent.ts archive/removed-2026-04-23/
# Update ecosystem.config.js (remove commented block)
pm2 save
```

---

## Phase 5: Long-Term Maintenance

### 5.1 Daily Checks

**Automated (cron job):**
- [ ] Check DLQ size (`wc -l logs/handler-dlq.jsonl`)
- [ ] Check critical alerts (`wc -l logs/critical-alerts.jsonl`)
- [ ] Check state snapshot age (`stat logs/handler-snapshot.json`)
- [ ] Check routing log volume (should be >0 on trading days)

**Manual (trading day start):**
- [ ] Verify handler connected (WebSocket status)
- [ ] Verify config loaded correctly
- [ ] Check for overnight orphans (reconciliation log)

### 5.2 Weekly Tasks

- [ ] Review routing decisions (`jq -s '.' logs/handler-routing.jsonl | jq 'group_by(.decisions[0].reason) | map({reason: .[0].decisions[0].reason, count: length})'`)
- [ ] Check for repeated error patterns
- [ ] Backtest any new configs in replay before adding to handler

### 5.3 Monthly Tasks

- [ ] Full log archive to GDrive
- [ ] Review P&L vs broker statements
- [ ] Update config parameters based on market conditions

---

## Summary

### What's Being Removed
1. **Polling agent** (`spx_agent.ts`) — 1585 lines, replaced by 350-line event handler

### What's Being Replaced
1. **Exit logic** — Add broker state sync, retry logic, dead letter queue
2. **Strike selection** — Add validation, fallback, suspicious skip logging
3. **State management** — Add persistence, crash recovery, snapshotting
4. **Error handling** — Add DLQ, critical alerts, exponential backoff
5. **Race condition prevention** — Add entry locks, signal deduplication

### Timeline
- **Phase 0 (Current state audit)**: 1 day
- **Phase 1 (Remove polling agent)**: 2 days (includes 1-day paper test)
- **Phase 2 (Fix edge cases)**: 5-7 days
- **Phase 3 (Testing)**: 3-5 days
- **Phase 4 (Production rollout)**: 4 weeks (gradual)
- **Phase 5 (Long-term maintenance)**: Ongoing

**Total: ~3-4 weeks to full production readiness**

---

## Success Metrics

### Technical
- Zero crashes during full trading day (paper mode)
- Zero critical alerts (unprotected positions)
- DLQ size <10 entries per day
- Exit polling success rate >99.5%
- State snapshot restores correctly after crash

### Business
- Signal-to-entry latency <2 seconds (vs 10-30 seconds polling)
- P&L matches broker within 0.1%
- No missed entries due to edge cases
- No double entries due to race conditions

### Operational
- Handler survives WebSocket disconnect/reconnect
- Handler survives Tradier API rate limits
- Handler survives brief network partitions
- Handler state recoverable after crash

---

## Appendix: File Changes

### New Files
- `src/agent/handler-persistence.ts` — State snapshot save/load
- `src/agent/dead-letter-queue.ts` — Failed signal retry
- `tests/agent/event-handler.test.ts` — Unit tests

### Modified Files
- `event_handler_mvp.ts` — Add all edge case fixes
- `src/agent/broker-pnl.ts` — Add `fetchBrokerPositions()`
- `ecosystem.config.js` — Remove old agent, finalize event handler config
- `CLAUDE.md` — Update architecture section

### Archived Files
- `spx_agent.ts` → `archive/removed-2026-04-23/` (backup, delete after 1 month)

---

## Open Questions

1. **Basket config partial fills**: If 3-strike basket enters but only 2 fills, what happens to the 3rd?
   - A: Cancel the 3rd, log as partial fill, don't retry

2. **Config reload during signal**: If config is reloaded while signal is processing, which config applies?
   - A: Signal uses config that was loaded at signal arrival time (lock config version during processing)

3. **Multiple configs with same HMA pair**: Do they compete for the same signal?
   - A: Yes, each config evaluates independently. If both want to enter, both do (assume user knows what they're doing).

4. **Handler crash during OCO submission**: Position is open but OCO not submitted → unprotected.
   - A: Startup reconciliation checks for open positions without OCO, resubmits protection.

5. **Network partition during exit**: Handler tries to close, fails due to network, position stays open.
   - A: Exit retry logic with backoff (3 attempts). If all fail, log to DLQ and raise critical alert.

---

**END OF R&R PLAN**

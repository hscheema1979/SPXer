# Event Handler Edge Cases — Implementation Guide

**Priority**: Critical fixes in implementation order
**Estimate**: 3-5 days of focused work

---

## Fix 1: Exit Polling Robustness (HIGHEST PRIORITY)

**Problem**: Position state drift → double-close attempts or missed exits.

### Implementation

#### Step 1: Add broker position fetch to `src/agent/broker-pnl.ts`

```typescript
// Add to src/agent/broker-pnl.ts
export interface BrokerPosition {
  symbol: string;
  quantity: number;
  avg_cost: number;
  side: 'long' | 'short';
}

/**
 * Fetch current open positions from Tradier.
 * Used for reconciliation and exit validation.
 */
export async function fetchBrokerPositions(accountId: string): Promise<BrokerPosition[]> {
  const hdrs = {
    Authorization: `Bearer ${config.tradierToken}`,
    Accept: 'application/json',
  };

  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: hdrs, timeout: 10_000 }
    );

    const rawPositions = data?.positions?.position;
    const positions = Array.isArray(rawPositions) ? rawPositions : rawPositions ? [rawPositions] : [];

    return positions
      .filter((p: any) => p.quantity !== 0 && p.quantity !== '0')
      .map((p: any) => ({
        symbol: p.symbol,
        quantity: Math.abs(parseInt(p.quantity, 10)),
        avg_cost: parseFloat(p.cost_basis) / Math.abs(parseInt(p.quantity, 10)),
        side: parseInt(p.quantity, 10) > 0 ? 'long' : 'short',
      }));
  } catch (e: any) {
    console.error('[broker-pnl] Failed to fetch positions:', e.message);
    return [];
  }
}
```

#### Step 2: Add safe close wrapper to `event_handler_mvp.ts`

```typescript
// Add to event_handler_mvp.ts
interface CloseResult {
  success: boolean;
  reason: string;
  brokerClosed?: boolean;
}

async function safeClosePosition(
  position: OpenPosition,
  reason: string,
  price: number,
  paper: boolean,
  execution: Execution
): Promise<CloseResult> {
  try {
    await closePosition(position, reason, price, paper, execution);
    return { success: true, reason: 'closed_successfully' };
  } catch (e: any) {
    const errorMsg = e.message.toLowerCase();

    // Check if error indicates position already closed
    if (
      errorMsg.includes('position not found') ||
      errorMsg.includes('no position') ||
      errorMsg.includes('invalid symbol') ||
      e?.response?.data?.errors?.error?.includes('not found')
    ) {
      console.log(`[handler] Position ${position.symbol} already closed at broker (error confirms)`);
      return { success: true, reason: 'already_closed_at_broker', brokerClosed: true };
    }

    // Unknown error — check broker state directly
    console.warn(`[handler] Close failed for ${position.symbol}: ${e.message}, checking broker state...`);
    const brokerPositions = await fetchBrokerPositions(TRADIER_ACCOUNT_ID);
    const stillOpen = brokerPositions.some(p => p.symbol === position.symbol);

    if (!stillOpen) {
      console.log(`[handler] Position ${position.symbol} not found at broker (likely TP/SL fill)`);
      return { success: true, reason: 'closed_at_broker_tpsl', brokerClosed: true };
    }

    // Still open — this is a real error
    console.error(`[handler] 🚨 CRITICAL: Failed to close ${position.symbol} and still open at broker`);
    return { success: false, reason: e.message };
  }
}
```

#### Step 3: Update `checkExits()` to use safe close

```typescript
// In checkExits(), replace the close loop:
for (const { posId, position, reason, closePrice } of positionsToClose) {
  try {
    const basketMemberId = state.basketMembers.get(posId) || 'default';

    const result = await safeClosePosition(
      position,
      reason,
      closePrice,
      perConfigPaper.get(configId) ?? AGENT_PAPER,
      EXECUTION
    );

    if (result.success) {
      state.positions.delete(posId);
      state.basketMembers.delete(posId);
      state.tradesCompleted++;
      console.log(`[handler] [${configId}] [${basketMemberId}] Closed ${position.symbol} x${position.quantity} (${reason}${result.brokerClosed ? ', confirmed at broker' : ''})`);
    } else {
      console.error(`[handler] [${configId}] Failed to close ${posId}: ${result.reason}`);
      // Don't delete from local state — still open at broker
    }

    syncConfigPositions(configId, state);
  } catch (e: any) {
    console.error(`[handler] [${configId}] Unexpected error closing ${posId}:`, e.message);
  }
}
```

**Testing**:
- Unit test: Mock close failure + broker position check
- Integration: Close position, verify broker state matches
- Chaos: Kill handler during exit, restart, verify reconciliation picks up closed position

---

## Fix 2: State Persistence (HIGH PRIORITY)

**Problem**: Handler crash = lost positions.

### Implementation

#### Step 1: Create `src/agent/handler-persistence.ts`

```typescript
/**
 * Handler State Persistence
 *
 * Saves handler state to disk every 30 seconds.
 * Enables recovery from crashes during trading day.
 */

import * as fs from 'fs';
import type { OpenPosition } from './types';
import type { Config } from '../config/types';

export interface HandlerSnapshot {
  version: 1;
  ts: number;
  configs: Record<string, ConfigSnapshot>;
}

export interface ConfigSnapshot {
  positions: SerializedPosition[];
  lastEntryTs: number;
  dailyPnl: number;
  tradesCompleted: number;
  sessionSignalCount: number;
  basketMembers: Array<[posId: string, memberId: string]>;
}

interface SerializedPosition {
  id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number | null;
  openedAt: number;
  highWaterPrice?: number;
  bracketOrderId?: string;
}

const SNAPSHOT_FILE = 'logs/handler-snapshot.json';
const SNAPSHOT_TMP = 'logs/handler-snapshot.json.tmp';
const SNAPSHOT_INTERVAL_MS = 30_000;

function serializePosition(pos: OpenPosition): SerializedPosition {
  return {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    strike: pos.strike,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    openedAt: pos.openedAt,
    highWaterPrice: pos.highWaterPrice,
    bracketOrderId: pos.bracketOrderId,
  };
}

function deserializePosition(data: SerializedPosition): OpenPosition {
  return {
    ...data,
    // Reconstruct empty fields
    exitReason: undefined,
    closedAt: undefined,
    exitPrice: undefined,
  };
}

/**
 * Save handler state to disk.
 * Atomic write via temp file to prevent corruption.
 */
export function saveSnapshot(
  configs: Map<string, {
    config: Config;
    positions: Map<string, OpenPosition>;
    lastEntryTs: number;
    dailyPnl: number;
    tradesCompleted: number;
    sessionSignalCount: number;
    basketMembers: Map<string, string>;
  }>
): void {
  const snapshot: HandlerSnapshot = {
    version: 1,
    ts: Date.now(),
    configs: {},
  };

  for (const [configId, state] of configs) {
    snapshot.configs[configId] = {
      positions: Array.from(state.positions.values()).map(serializePosition),
      lastEntryTs: state.lastEntryTs,
      dailyPnl: state.dailyPnl,
      tradesCompleted: state.tradesCompleted,
      sessionSignalCount: state.sessionSignalCount,
      basketMembers: Array.from(state.basketMembers.entries()),
    };
  }

  try {
    fs.mkdirSync('logs', { recursive: true });
    fs.writeFileSync(SNAPSHOT_TMP, JSON.stringify(snapshot, null, 2));
    fs.renameSync(SNAPSHOT_TMP, SNAPSHOT_FILE);
  } catch (e) {
    console.error('[handler-persistence] Failed to save snapshot:', (e as Error).message);
  }
}

/**
 * Load handler state from disk.
 * Returns null if snapshot is too old (>24h) or doesn't exist.
 */
export function loadSnapshot(): HandlerSnapshot | null {
  try {
    fs.mkdirSync('logs', { recursive: true });
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf-8');
    const snapshot = JSON.parse(raw) as HandlerSnapshot;

    // Reject if too old
    const ageMs = Date.now() - snapshot.ts;
    if (ageMs > 24 * 60 * 60 * 1000) {
      console.warn(`[handler-persistence] Snapshot too old (${Math.round(ageMs / 3600000)}h), ignoring`);
      return null;
    }

    console.log(`[handler-persistence] Loaded snapshot from ${new Date(snapshot.ts).toISOString()} (${Object.keys(snapshot.configs).length} configs)`);
    return snapshot;
  } catch (e: any) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[handler-persistence] Failed to load snapshot:', (e as Error).message);
    }
    return null;
  }
}

/**
 * Start periodic snapshot saves.
 */
export function startSnapshotTimer(
  configs: Map<string, any>
): NodeJS.Timeout {
  return setInterval(() => {
    saveSnapshot(configs);
  }, SNAPSHOT_INTERVAL_MS);
}
```

#### Step 2: Update `event_handler_mvp.ts` to use persistence

```typescript
// Add imports
import { saveSnapshot, loadSnapshot, startSnapshotTimer } from './src/agent/handler-persistence';

// In main(), after loadConfigs():
async function main(): Promise<void> {
  // ... existing code ...

  await loadConfigs();

  if (configs.size === 0) {
    console.error('[handler] No configs loaded, exiting');
    process.exit(1);
  }

  // NEW: Load snapshot before reconciliation
  const snapshot = loadSnapshot();
  if (snapshot) {
    for (const [configId, snap] of Object.entries(snapshot.configs)) {
      const state = configs.get(configId);
      if (!state) {
        console.warn(`[handler] Snapshot has config '${configId}' but not loaded, skipping`);
        continue;
      }

      // Restore positions
      const positions = new Map<string, OpenPosition>();
      for (const posData of snap.positions) {
        const pos = deserializePosition(posData);
        positions.set(pos.id, pos);
      }

      // Restore basket members
      const basketMembers = new Map<string, string>(snap.basketMembers);

      // Merge snapshot state
      state.positions = positions;
      state.lastEntryTs = snap.lastEntryTs;
      state.dailyPnl = snap.dailyPnl;
      state.tradesCompleted = snap.tradesCompleted;
      state.sessionSignalCount = snap.sessionSignalCount;
      state.basketMembers = basketMembers;

      console.log(`[handler] [${configId}] Restored from snapshot: ${positions.size} positions, $${snap.dailyPnl.toFixed(2)} P&L`);
    }
  }

  await reconcileStartup();
  await updateBrokerPnl();

  // ... rest of main() ...

  // NEW: Start snapshot timer
  const snapshotTimer = startSnapshotTimer(configs);

  // Update gracefulShutdown to clear timer
  const originalShutdown = gracefulShutdown;
  const gracefulShutdownWithCleanup = () => {
    clearInterval(snapshotTimer);
    saveSnapshot(configs); // Final snapshot
    originalShutdown();
  };

  process.removeListener('SIGINT', gracefulShutdown);
  process.removeListener('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdownWithCleanup);
  process.on('SIGTERM', gracefulShutdownWithCleanup);
}
```

**Testing**:
- Start handler, open position, verify snapshot file created
- Kill handler, restart, verify position restored
- Modify snapshot file to be 25 hours old, verify it's rejected
- Corrupt snapshot file, verify handler starts cleanly (no crash)

---

## Fix 3: OCO Protection Retry (CRITICAL)

**Problem**: OCO submission fails → position unprotected → catastrophic loss.

### Implementation

```typescript
// In event_handler_mvp.ts, replace submitOcoProtection with:

interface OcoResult {
  success: boolean;
  orderId?: string;
  error?: string;
}

async function submitOcoProtectionWithRetry(
  pos: OpenPosition,
  accountId: string,
  maxAttempts: number = 4
): Promise<OcoResult> {
  const backoffs = [500, 2000, 5000, 10_000];
  let lastErr: string | undefined;

  // Check if OCO already exists
  const existingOco = await checkExistingOco(pos, accountId);
  if (existingOco) {
    console.log(`[handler] OCO already exists for ${pos.symbol} (order #${existingOco}), skipping`);
    return { success: true, orderId: existingOco };
  }

  for (let attempt = 0; attempt < Math.min(maxAttempts, backoffs.length); attempt++) {
    try {
      const orderId = await submitOcoInternal(pos, accountId);
      const label = attempt === 0 ? '' : ` (attempt ${attempt + 1})`;
      console.log(`[handler] OCO submitted for ${pos.symbol}: order #${orderId}${label}`);
      return { success: true, orderId };
    } catch (e: any) {
      lastErr = e?.response?.data?.errors?.error || e.message;
      console.warn(`[handler] OCO attempt ${attempt + 1}/${backoffs.length} failed for ${pos.symbol}: ${lastErr}`);

      if (attempt < backoffs.length - 1) {
        await new Promise(r => setTimeout(r, backoffs[attempt]));
      }
    }
  }

  // All retries failed
  const errorMsg = `Failed to submit OCO for ${pos.symbol} after ${backoffs.length} attempts: ${lastErr}`;
  console.error(`[handler] 🚨 CRITICAL: ${errorMsg}. Position is UNPROTECTED at broker.`);

  // Write to critical alerts log
  try {
    fs.mkdirSync('logs', { recursive: true });
    fs.appendFileSync('logs/critical-alerts.jsonl', JSON.stringify({
      ts: Date.now(),
      level: 'CRITICAL',
      config: 'event-handler',
      message: errorMsg,
      position: {
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        strike: pos.strike,
        quantity: pos.quantity,
        entryPrice: pos.entryPrice,
      },
      error: lastErr,
    }) + '\n');
  } catch (e) {
    // Ignore log write errors
  }

  return { success: false, error: lastErr };
}

async function checkExistingOco(pos: OpenPosition, accountId: string): Promise<string | null> {
  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };

  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      { headers: hdrs, timeout: 10_000 }
    );

    const rawOrders = data?.orders?.order;
    const allOrders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];

    for (const order of allOrders) {
      if (order.status !== 'open' && order.status !== 'pending') continue;

      const legs = Array.isArray(order.leg) ? order.leg : order.leg ? [order.leg] : [];
      const hasOcoForSymbol = legs.some((l: any) =>
        (l.status === 'open' || l.status === 'pending') &&
        l.side === 'sell_to_close' &&
        l.option_symbol === pos.symbol
      );

      if (hasOcoForSymbol) {
        return order.id;
      }
    }

    return null;
  } catch (e: any) {
    console.warn(`[handler] Failed to check existing OCO: ${e.message}`);
    return null;
  }
}

async function submitOcoInternal(pos: OpenPosition, accountId: string): Promise<string> {
  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const tp = pos.takeProfit ?? pos.entryPrice * 1.5;
  const sl = pos.stopLoss;
  const tpRounded = roundToOptionTick(tp);
  const slRounded = roundToOptionTick(sl);

  const body = [
    'class=oco',
    'duration=day',
    `symbol=${EXECUTION.symbol}`,
    `type[0]=limit`,
    `option_symbol[0]=${pos.symbol}`,
    `side[0]=sell_to_close`,
    `quantity[0]=${pos.quantity}`,
    `price[0]=${tpRounded.toFixed(2)}`,
    `type[1]=stop`,
    `option_symbol[1]=${pos.symbol}`,
    `side[1]=sell_to_close`,
    `quantity[1]=${pos.quantity}`,
    `stop[1]=${slRounded.toFixed(2)}`,
  ].join('&');

  const { data } = await axios.post(
    `${TRADIER_BASE}/accounts/${accountId}/orders`,
    body,
    { headers: hdrs, timeout: 10_000 }
  );

  const orderId = data?.order?.id;
  if (!orderId) {
    throw new Error(`Tradier returned no order id: ${JSON.stringify(data)}`);
  }

  return orderId;
}

// Update handleContractSignal to use OCO retry:
const ocoResult = await submitOcoProtectionWithRetry(result.position, TRADIER_ACCOUNT_ID);

if (!ocoResult.success) {
  // OCO failed — consider closing the position
  console.warn(`[handler] OCO protection failed for ${result.position.symbol}, closing position for safety`);
  await closePosition(
    result.position,
    'oco_failed',
    result.execution.fillPrice || result.position.entryPrice,
    configPaper,
    EXECUTION
  );
  state.positions.delete(result.position.id);
  syncConfigPositions(configId, state);
}
```

**Testing**:
- Mock Tradier error responses, verify retry logic works
- Mock OCO already exists, verify skip
- Mock all retries fail, verify critical alert written

---

## Fix 4: Signal Deduplication (HIGH PRIORITY)

**Problem**: Same signal processed multiple times → double entry.

### Implementation

```typescript
// Add to event_handler_mvp.ts
const seenSignals = new Map<string, number>(); // hash → timestamp
const SIGNAL_DEDUP_WINDOW_MS = 5000; // 5 seconds
const SIGNAL_HASH_CLEANUP_MS = 10000; // 10 seconds

function signalHash(signal: any): string {
  // Hash based on: symbol + HMA pair + direction + 5-second time bucket
  const timeBucket = Math.floor(signal.timestamp / SIGNAL_DEDUP_WINDOW_MS);
  return `${signal.symbol}:${signal.hmaFastPeriod}x${signal.hmaSlowPeriod}:${signal.direction}:${timeBucket}`;
}

function cleanupSignalHashes(): void {
  const now = Date.now();
  for (const [hash, ts] of seenSignals) {
    if (now - ts > SIGNAL_HASH_CLEANUP_MS) {
      seenSignals.delete(hash);
    }
  }
}

// In handleContractSignal(), add at the top:
async function handleContractSignal(signal: any): Promise<void> {
  // Check for duplicate
  const hash = signalHash(signal);
  const now = Date.now();

  if (seenSignals.has(hash)) {
    const lastSeen = seenSignals.get(hash)!;
    if (now - lastSeen < SIGNAL_DEDUP_WINDOW_MS) {
      console.log(`[handler] Duplicate signal ${hash}, skipping`);
      return;
    }
  }

  seenSignals.set(hash, now);
  cleanupSignalHashes();

  // ... rest of function ...
}
```

**Testing**:
- Send same signal twice within 5 seconds → second one skipped
- Send same signal twice with 6 second gap → both processed
- Verify hash cleanup works (Map doesn't grow unbounded)

---

## Fix 5: Entry Lock per Config (MEDIUM PRIORITY)

**Problem**: Multiple signals arrive before entry completes → over-entry.

### Implementation

```typescript
// Add to event_handler_mvp.ts
const entryLocks = new Map<string, Promise<void>>(); // configId → entry promise

// In handleContractSignal(), wrap the entry logic:
async function handleContractSignal(signal: any): Promise<void> {
  // ... existing code up to routingDecisions ...

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
        // ... existing entry logic (lines 377-498) ...
        // All the existing code goes here, wrapped in try-finally
      } finally {
        // Release lock after 5 second delay (prevent immediate re-entry)
        await new Promise(r => setTimeout(r, 5000));
        entryLocks.delete(configId);
      }
    })();

    entryLocks.set(configId, entryPromise);

    // Wait for entry to complete (or timeout after 60s)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Entry timeout')), 60_000)
    );

    try {
      await Promise.race([entryPromise, timeoutPromise]);
    } catch (e: any) {
      console.error(`[handler] [${configId}] Entry failed:`, e.message);
      entryLocks.delete(configId); // Force release on timeout
    }

    // Record routing decision
    // ... existing code ...
  }
}
```

**Testing**:
- Send two signals for same config rapidly → second one waits
- Send entry that takes >60s → lock force-released
- Verify lock released after entry completes

---

## Testing Checklist

After implementing all fixes:

- [ ] Unit tests pass (`npm test`)
- [ ] Handler starts cleanly from cold (no snapshot)
- [ ] Handler starts and restores from snapshot
- [ ] Signal deduplication works
- [ ] Entry lock prevents double entry
- [ ] Exit retry works on broker error
- [ ] OCO retry works on Tradier error
- [ ] Critical alerts written to log
- [ ] Dead letter queue enqueues failed signals
- [ ] State snapshot saved every 30s
- [ ] All locks released properly
- [ ] No memory leaks (Map sizes bounded)
- [ ] Handler survives WebSocket disconnect
- [ ] Handler survives Tradier API rate limit
- [ ] Full trading day paper test passes

---

## Deployment Steps

1. **Implement fixes in dev branch**
   ```bash
   git checkout -b feature/event-handler-edge-cases
   ```

2. **Test locally**
   ```bash
   # Terminal 1: Data service
   npm run dev

   # Terminal 2: Event handler (paper mode)
   AGENT_CONFIG_ID="test-config" AGENT_PAPER=true npx tsx event_handler_mvp.ts
   ```

3. **Run full test suite**
   ```bash
   npm test
   ```

4. **Deploy to staging**
   ```bash
   pm2 restart event-handler --update-env
   ```

5. **Monitor for 1 trading day**
   - Check logs for errors
   - Verify critical alerts log is empty
   - Verify DLQ size is small

6. **Deploy to production**
   ```bash
   # Update ecosystem.config.js
   pm2 restart event-handler
   ```

---

**END OF IMPLEMENTATION GUIDE**

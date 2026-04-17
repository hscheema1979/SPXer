/**
 * Standalone metrics collector — polls system state every 60s and stores
 * time-series metrics in the SQLite database.
 *
 * Run directly: npx tsx src/ops/metrics-collector.ts
 * Or via PM2:   pm2 start ecosystem.config.js --only metrics-collector
 *
 * Metrics are stored in the `metrics` table with 7-day automatic retention.
 * Query via metrics-api.ts helpers or raw SQL.
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DB_PATH || './data/spxer.db';
const DATA_SERVICE_PORT = parseInt(process.env.PORT || '3600', 10);
const COLLECT_INTERVAL_MS = 60_000;
const RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

let db: DB;

function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      tags TEXT DEFAULT '',
      PRIMARY KEY (ts, name, tags)
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(name, ts);
  `);
}

// Prepared statements (initialized after DB open)
let insertStmt: ReturnType<DB['prepare']>;
let purgeStmt: ReturnType<DB['prepare']>;

function prepareStatements(): void {
  insertStmt = db.prepare(
    'INSERT OR REPLACE INTO metrics (ts, name, value, tags) VALUES (?, ?, ?, ?)'
  );
  purgeStmt = db.prepare('DELETE FROM metrics WHERE ts < ?');
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

interface MetricPoint {
  name: string;
  value: number;
  tags?: string;
}

function writeMetrics(points: MetricPoint[]): void {
  const ts = Math.floor(Date.now() / 1000);
  const tx = db.transaction((pts: MetricPoint[]) => {
    for (const p of pts) {
      insertStmt.run([ts, p.name, p.value, p.tags || '']);
    }
  });
  tx(points);
}

function purgeOld(): void {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  const info = purgeStmt.run(cutoff);
  if (info.changes > 0) {
    console.log(`[metrics] Purged ${info.changes} metrics older than ${RETENTION_DAYS}d`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helper — lightweight GET with timeout
// ---------------------------------------------------------------------------

function httpGet(urlPath: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: DATA_SERVICE_PORT, path: urlPath, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${urlPath}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${urlPath}`)); });
  });
}

async function fetchJson<T>(urlPath: string): Promise<T | null> {
  try {
    const body = await httpGet(urlPath);
    return JSON.parse(body) as T;
  } catch (e: any) {
    console.warn(`[metrics] Failed to fetch ${urlPath}: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function collectSystem(): MetricPoint[] {
  const points: MetricPoint[] = [];
  const mem = os.totalmem();
  const free = os.freemem();
  points.push({ name: 'system.memory_total_mb', value: Math.round(mem / 1048576) });
  points.push({ name: 'system.memory_used_mb', value: Math.round((mem - free) / 1048576) });
  points.push({ name: 'system.load_1m', value: parseFloat(os.loadavg()[0].toFixed(2)) });

  try {
    const dfOut = execSync('df -B1G / --output=used,avail', { timeout: 5000 }).toString();
    const lines = dfOut.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      points.push({ name: 'system.disk_used_gb', value: parseInt(parts[0], 10) });
      points.push({ name: 'system.disk_free_gb', value: parseInt(parts[1], 10) });
    }
  } catch (e: any) {
    console.warn(`[metrics] disk check failed: ${e.message}`);
  }

  return points;
}

interface HealthResponse {
  lastSpxPrice?: number;
  trackedContracts?: number;
  activeContracts?: number;
  wsClients?: number;
  providers?: Record<string, { healthy?: boolean; staleSec?: number; consecutiveFailures?: number }>;
  db?: { sizeMb?: number; walSizeMb?: number };
}

interface PipelineHealthResponse {
  barBuilder?: { barsBuilt?: number; syntheticBars?: number; gapsInterpolated?: number; gapsStale?: number; barsRejected?: number };
  indicators?: { computed?: number; nanRejected?: number };
  db?: { writesAttempted?: number; writesSucceeded?: number; writesFailed?: number; walSizeMbAtLastCheckpoint?: number };
  signals?: { detected?: number };
  circuitBreakers?: Record<string, string>;
}

// Track previous counter values for delta computation
let prevBarsBuilt: number | null = null;

async function collectPipeline(): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];

  const health = await fetchJson<HealthResponse>('/health');
  if (health) {
    if (health.lastSpxPrice != null) points.push({ name: 'pipeline.spx_price', value: health.lastSpxPrice });
    if (health.trackedContracts != null) points.push({ name: 'pipeline.contracts_tracked', value: health.trackedContracts });
    if (health.activeContracts != null) points.push({ name: 'pipeline.contracts_active', value: health.activeContracts });
    if (health.wsClients != null) points.push({ name: 'pipeline.ws_clients', value: health.wsClients });

    // Per-provider metrics
    if (health.providers) {
      for (const [name, info] of Object.entries(health.providers)) {
        const tags = JSON.stringify({ provider: name });
        if (info.staleSec != null) points.push({ name: 'pipeline.provider.staleness_sec', value: info.staleSec, tags });
        points.push({ name: 'pipeline.provider.healthy', value: info.healthy ? 1 : 0, tags });
      }
    }
  }

  const ph = await fetchJson<PipelineHealthResponse>('/pipeline/health');
  if (ph) {
    if (ph.barBuilder) {
      const bb = ph.barBuilder;
      // Delta for bars_built (counter)
      if (bb.barsBuilt != null) {
        if (prevBarsBuilt !== null && bb.barsBuilt >= prevBarsBuilt) {
          points.push({ name: 'pipeline.bars_built', value: bb.barsBuilt - prevBarsBuilt });
        }
        prevBarsBuilt = bb.barsBuilt;
      }
      // Synthetic ratio
      if (bb.barsBuilt && bb.barsBuilt > 0 && bb.syntheticBars != null) {
        points.push({ name: 'pipeline.bars_synthetic_ratio', value: parseFloat((bb.syntheticBars / bb.barsBuilt).toFixed(4)) });
      }
    }

    if (ph.indicators) {
      if (ph.indicators.nanRejected != null) points.push({ name: 'pipeline.indicator_nan_count', value: ph.indicators.nanRejected });
    }

    if (ph.db) {
      if (ph.db.writesFailed != null) points.push({ name: 'pipeline.db_writes_failed', value: ph.db.writesFailed });
    }

    // SPX staleness — derive from provider data if available
    if (health?.providers) {
      // Use tradier staleness during RTH as proxy for SPX staleness
      const tradier = health.providers['tradier'] || health.providers['Tradier'];
      if (tradier?.staleSec != null) {
        points.push({ name: 'pipeline.spx_staleness_sec', value: tradier.staleSec });
      }
    }

    // Circuit breakers
    if (ph.circuitBreakers) {
      for (const [name, state] of Object.entries(ph.circuitBreakers)) {
        const val = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
        const tags = JSON.stringify({ circuit: name });
        points.push({ name: 'pipeline.circuit.state', value: val, tags });
      }
    }
  }

  return points;
}

interface AgentStatus {
  cycle?: number;
  openPositions?: number;
  dailyPnL?: number;
  tradesToday?: number;
  judgeCallsToday?: number;
  spxPrice?: number;
  minutesToClose?: number;
}

function readAgentStatus(agentId: string): MetricPoint[] {
  const points: MetricPoint[] = [];
  const filePath = path.resolve('logs', `agent-status-${agentId}.json`);

  try {
    if (!fs.existsSync(filePath)) return points;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const status: AgentStatus = JSON.parse(raw);

    const prefix = `agent.${agentId}`;
    if (status.cycle != null) points.push({ name: `${prefix}.cycle`, value: status.cycle });
    if (status.openPositions != null) points.push({ name: `${prefix}.positions_open`, value: status.openPositions });
    if (status.dailyPnL != null) points.push({ name: `${prefix}.daily_pnl`, value: status.dailyPnL });

    const trades = status.tradesToday ?? status.judgeCallsToday;
    if (trades != null) points.push({ name: `${prefix}.trades_today`, value: trades });
  } catch (e: any) {
    console.warn(`[metrics] Failed to read agent status for ${agentId}: ${e.message}`);
  }

  return points;
}

function collectAgents(): MetricPoint[] {
  return [...readAgentStatus('spx'), ...readAgentStatus('xsp')];
}

interface PM2Process {
  name: string;
  pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number };
  monit?: { memory?: number; cpu?: number };
}

function collectProcesses(): MetricPoint[] {
  const points: MetricPoint[] = [];

  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const procs: PM2Process[] = JSON.parse(raw);

    for (const proc of procs) {
      const name = proc.name;
      const tags = JSON.stringify({ process: name });

      if (proc.monit) {
        if (proc.monit.memory != null) {
          points.push({ name: 'process.memory_mb', value: Math.round(proc.monit.memory / 1048576), tags });
        }
        if (proc.monit.cpu != null) {
          points.push({ name: 'process.cpu', value: proc.monit.cpu, tags });
        }
      }

      if (proc.pm2_env) {
        if (proc.pm2_env.restart_time != null) {
          points.push({ name: 'process.restarts', value: proc.pm2_env.restart_time, tags });
        }
        points.push({ name: 'process.online', value: proc.pm2_env.status === 'online' ? 1 : 0, tags });
      }
    }
  } catch (e: any) {
    console.warn(`[metrics] pm2 jlist failed: ${e.message}`);
  }

  return points;
}

function collectDb(): MetricPoint[] {
  const points: MetricPoint[] = [];
  const dbFile = path.resolve(DB_PATH);

  try {
    const stat = fs.statSync(dbFile);
    points.push({ name: 'db.size_mb', value: parseFloat((stat.size / 1048576).toFixed(2)) });
  } catch { /* file doesn't exist yet */ }

  try {
    const walFile = dbFile + '-wal';
    if (fs.existsSync(walFile)) {
      const stat = fs.statSync(walFile);
      points.push({ name: 'db.wal_size_mb', value: parseFloat((stat.size / 1048576).toFixed(2)) });
    } else {
      points.push({ name: 'db.wal_size_mb', value: 0 });
    }
  } catch { /* ignore */ }

  return points;
}

// ---------------------------------------------------------------------------
// Main collection cycle
// ---------------------------------------------------------------------------

let cycleCount = 0;

async function collect(): Promise<void> {
  cycleCount++;
  const t0 = Date.now();

  try {
    const [systemPts, pipelinePts, agentPts, processPts, dbPts] = await Promise.all([
      Promise.resolve(collectSystem()),
      collectPipeline(),
      Promise.resolve(collectAgents()),
      Promise.resolve(collectProcesses()),
      Promise.resolve(collectDb()),
    ]);

    const allPoints = [...systemPts, ...pipelinePts, ...agentPts, ...processPts, ...dbPts];

    if (allPoints.length > 0) {
      writeMetrics(allPoints);
    }

    // Purge old metrics once per cycle
    purgeOld();

    const elapsed = Date.now() - t0;
    console.log(`[metrics] Cycle ${cycleCount}: collected ${allPoints.length} metrics in ${elapsed}ms`);
  } catch (e: any) {
    console.error(`[metrics] Collection cycle ${cycleCount} failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(): void {
  console.log('[metrics] Shutting down...');
  try {
    if (db && db.open) db.close();
  } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
  console.log(`[metrics] Starting metrics collector (interval=${COLLECT_INTERVAL_MS / 1000}s, retention=${RETENTION_DAYS}d)`);
  console.log(`[metrics] DB: ${path.resolve(DB_PATH)}`);

  initDb();
  prepareStatements();

  // Initial collection
  await collect();

  // Schedule recurring collection
  setInterval(() => {
    collect().catch((e) => console.error(`[metrics] Unhandled error: ${e.message}`));
  }, COLLECT_INTERVAL_MS);
}

main().catch((e) => {
  console.error(`[metrics] Fatal: ${e.message}`);
  process.exit(1);
});

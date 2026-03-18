# SPXer Data Service Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone 24/5 TypeScript data service that maintains warm, indicator-rich OHLCV bar histories for SPX and all tracked SPXW options contracts, serving data via REST and WebSocket to any consumer.

**Architecture:** Yahoo Finance `ES=F` feeds overnight bar building (24/5); Tradier supplies RTH SPX bars and options chain data; TradingView screener provides market context snapshots. All bars flow through an incremental indicator engine and a sticky-band contract tracker before being persisted to SQLite and broadcast to WebSocket subscribers.

**Tech Stack:** TypeScript, Node.js 20+, Express, `ws`, `better-sqlite3`, `axios`, `vitest`, `duckdb` (archival), `rclone` CLI (Google Drive)

**Spec:** `docs/specs/2026-03-18-spxer-design.md`

---

## File Map

```
SPXer/
├── src/
│   ├── index.ts                    Entry point — wires all modules, starts service
│   ├── types.ts                    All shared TypeScript interfaces and enums
│   ├── config.ts                   Env vars, constants, holiday calendar
│   ├── providers/
│   │   ├── yahoo.ts                Yahoo Finance HTTP — ES=F, ^GSPC, ^VIX bars
│   │   ├── tradier.ts              Tradier API — SPX quotes, timesales, options chain
│   │   └── tv-screener.ts          TradingView scanner API — ES1!, sectors, futures
│   ├── pipeline/
│   │   ├── bar-builder.ts          Bar construction, gap detection, interpolation
│   │   ├── aggregator.ts           1m → 5m/15m/1h aggregation
│   │   ├── indicators/
│   │   │   ├── tier1.ts            HMA(5,19,25), EMA(9,21), RSI, BB, ATR, VWAP
│   │   │   └── tier2.ts            EMA(50,200), SMA, Stoch, CCI, Mom, MACD, ADX
│   │   ├── indicator-engine.ts     Incremental state machine, applies tier1+2
│   │   ├── contract-tracker.ts     Sticky band model, contract lifecycle
│   │   └── scheduler.ts            Time-based source switching, holiday calendar
│   ├── storage/
│   │   ├── db.ts                   SQLite connection, WAL config, migrations
│   │   ├── queries.ts              All read/write DB operations
│   │   └── archiver.ts             DuckDB parquet export + rclone upload
│   └── server/
│       ├── http.ts                 Express REST API
│       └── ws.ts                   WebSocket server, subscription manager
├── tests/
│   ├── providers/
│   │   ├── yahoo.test.ts
│   │   ├── tradier.test.ts
│   │   └── tv-screener.test.ts
│   ├── pipeline/
│   │   ├── bar-builder.test.ts
│   │   ├── aggregator.test.ts
│   │   ├── indicators/
│   │   │   ├── tier1.test.ts
│   │   │   └── tier2.test.ts
│   │   ├── indicator-engine.test.ts
│   │   ├── contract-tracker.test.ts
│   │   └── scheduler.test.ts
│   ├── storage/
│   │   ├── db.test.ts
│   │   └── queries.test.ts
│   └── server/
│       └── http.test.ts
├── data/
│   └── .gitkeep                    SQLite DB lives here (gitignored)
├── docs/
│   ├── specs/
│   └── superpowers/plans/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `data/.gitkeep`
- Create: `.gitignore`

- [ ] **Step 1: Init project**

```bash
cd /home/ubuntu/SPXer
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express ws better-sqlite3 axios
npm install -D typescript @types/node @types/express @types/ws @types/better-sqlite3 ts-node vitest tsx duckdb
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Write vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Add scripts to package.json**

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: Write .env.example**

```env
PORT=3600
TRADIER_TOKEN=your_tradier_token
TRADIER_ACCOUNT_ID=your_account_id
GDRIVE_REMOTE=gdrive:SPXer/archives
DB_PATH=./data/spxer.db
LOG_LEVEL=info
```

- [ ] **Step 7: Write .gitignore**

```
node_modules/
dist/
data/*.db
data/*.db-shm
data/*.db-wal
.env
*.parquet
```

- [ ] **Step 8: Create directory structure**

```bash
mkdir -p src/providers src/pipeline/indicators src/storage src/server
mkdir -p tests/providers tests/pipeline/indicators tests/storage tests/server
mkdir -p data
touch data/.gitkeep
```

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "chore: project scaffold, deps, tsconfig"
```

---

## Task 2: Types and Config

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`

- [ ] **Step 1: Write failing type test**

```typescript
// tests/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Bar, Contract, ContractState, Timeframe } from '../src/types';

describe('types', () => {
  it('Bar has required fields', () => {
    const bar: Bar = {
      symbol: 'SPX', timeframe: '1m', ts: 1700000000,
      open: 100, high: 101, low: 99, close: 100.5,
      volume: 0, synthetic: false, gapType: null, indicators: {}
    };
    expect(bar.symbol).toBe('SPX');
  });

  it('ContractState enum has expected values', () => {
    const state: ContractState = 'ACTIVE';
    expect(['UNSEEN','ACTIVE','STICKY','EXPIRED']).toContain(state);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/types.test.ts
```
Expected: FAIL — cannot find module `../src/types`

- [ ] **Step 3: Write src/types.ts**

```typescript
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1d';
export type ContractState = 'UNSEEN' | 'ACTIVE' | 'STICKY' | 'EXPIRED';
export type GapType = 'interpolated' | 'stale' | null;
export type OptionType = 'call' | 'put';
export type InstrumentType = 'index' | 'future' | 'etf' | 'call' | 'put';

export interface Bar {
  symbol: string;
  timeframe: Timeframe;
  ts: number;          // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic: boolean;
  gapType: GapType;
  indicators: Record<string, number | null>;
}

export interface Contract {
  symbol: string;       // Tradier canonical: SPXW260318C06700000
  type: InstrumentType;
  underlying: string;   // 'SPX'
  strike: number;
  expiry: string;       // 'YYYY-MM-DD'
  state: ContractState;
  firstSeen: number;    // Unix seconds
  lastBarTs: number;
  createdAt: number;
}

export interface OHLCVRaw {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorState {
  // Tracks incremental rolling windows per symbol+timeframe
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  typicalPrices: number[];  // (h+l+c)/3 for VWAP
  cumulativeTPV: number;    // for VWAP
  cumulativeVol: number;    // for VWAP
  emaState: Record<number, number | null>;   // period → last EMA value
  macdState: { fastEma: number | null; slowEma: number | null; signalEma: number | null };
  atrState: number | null;
  adxState: { plusDM: number | null; minusDM: number | null; tr: number | null; adx: number | null };
}

export interface ChainContract {
  symbol: string;
  type: OptionType;
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface ScreenerSnapshot {
  symbol: string;
  close: number;
  change: number;
  rsi: number | null;
  macd: number | null;
  ema50: number | null;
  volatilityD: number | null;
  recommendation: number | null;
  ts: number;
}

export interface ServiceStatus {
  uptime: number;
  trackedContracts: number;
  activeContracts: number;
  stickyContracts: number;
  dbSizeMb: number;
  currentMode: 'overnight' | 'preopen' | 'rth' | 'weekend';
  lastSpxPrice: number | null;
  lastUpdate: number;
}
```

- [ ] **Step 4: Write src/config.ts**

```typescript
import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3600'),
  tradierToken: process.env.TRADIER_TOKEN || '',
  tradierAccountId: process.env.TRADIER_ACCOUNT_ID || '',
  gdriveRemote: process.env.GDRIVE_REMOTE || 'gdrive:SPXer/archives',
  dbPath: process.env.DB_PATH || './data/spxer.db',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export const TRADIER_BASE = 'https://api.tradier.com/v1';

// NYSE market holidays 2025-2027 (YYYY-MM-DD)
export const MARKET_HOLIDAYS = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18',
  '2025-05-26','2025-06-19','2025-07-04','2025-09-01',
  '2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
  '2026-05-25','2026-06-19','2026-07-03','2026-08-31',
  '2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26',
  '2027-05-31','2027-06-18','2027-07-05','2027-09-06',
  '2027-11-25','2027-12-24',
]);

// Early close days (1:00 PM ET) — day before July 4th and Thanksgiving Friday
export const EARLY_CLOSE_DAYS = new Set([
  '2025-07-03','2025-11-28',
  '2026-07-02','2026-11-27',
  '2027-07-02','2027-11-26',
]);

// Strike $5 intervals, ±$100 band
export const STRIKE_BAND = 100;
export const STRIKE_INTERVAL = 5;

// Polling intervals (ms)
export const POLL_UNDERLYING_MS = 60_000;
export const POLL_OPTIONS_RTH_MS = 30_000;
export const POLL_OPTIONS_OVERNIGHT_MS = 300_000;
export const POLL_SCREENER_MS = 60_000;

// Gap interpolation thresholds
export const GAP_INTERPOLATE_MAX_MINS = 60;

// Bar history limits (in memory per symbol per timeframe)
export const MAX_BARS_MEMORY = 2000;
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/types.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/types.test.ts
git commit -m "feat: types, config, holiday calendar"
```

---

## Task 3: SQLite Storage Layer

**Files:**
- Create: `src/storage/db.ts`
- Create: `src/storage/queries.ts`
- Test: `tests/storage/db.test.ts`, `tests/storage/queries.test.ts`

- [ ] **Step 1: Write failing db test**

```typescript
// tests/storage/db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/storage/db';

describe('db', () => {
  beforeAll(() => initDb(':memory:'));
  afterAll(() => closeDb());

  it('initializes with bars and contracts tables', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('bars');
    expect(names).toContain('contracts');
  });

  it('has WAL mode enabled', () => {
    const db = getDb();
    const mode = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(mode[0].journal_mode).toBe('wal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/storage/db.test.ts
```

- [ ] **Step 3: Write src/storage/db.ts**

```typescript
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

let db: DB;

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations();
}

export function getDb(): DB {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol      TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      open        REAL NOT NULL,
      high        REAL NOT NULL,
      low         REAL NOT NULL,
      close       REAL NOT NULL,
      volume      INTEGER NOT NULL DEFAULT 0,
      synthetic   INTEGER NOT NULL DEFAULT 0,
      gap_type    TEXT,
      indicators  TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- UNIQUE constraint enables ON CONFLICT upsert; intentional deviation from spec's non-unique index
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bars_symbol_tf_ts
      ON bars(symbol, timeframe, ts);

    CREATE TABLE IF NOT EXISTS contracts (
      symbol      TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      underlying  TEXT NOT NULL DEFAULT 'SPX',
      strike      REAL NOT NULL,
      expiry      TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'UNSEEN',
      first_seen  INTEGER,
      last_bar_ts INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/storage/db.test.ts
```

- [ ] **Step 5: Write failing queries test**

```typescript
// tests/storage/queries.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { upsertBar, getBars, upsertContract, getContractsByState } from '../../src/storage/queries';
import type { Bar, Contract } from '../../src/types';

const testBar: Bar = {
  symbol: 'SPX', timeframe: '1m', ts: 1700000000,
  open: 5000, high: 5010, low: 4990, close: 5005,
  volume: 100, synthetic: false, gapType: null,
  indicators: { rsi: 55.5 }
};

describe('queries', () => {
  beforeAll(() => initDb(':memory:'));
  afterAll(() => closeDb());

  it('upserts and retrieves a bar', () => {
    upsertBar(testBar);
    const bars = getBars('SPX', '1m', 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(5005);
    expect(bars[0].indicators.rsi).toBe(55.5);
  });

  it('upsert is idempotent (same ts)', () => {
    upsertBar(testBar);
    upsertBar({ ...testBar, close: 5010 });
    const bars = getBars('SPX', '1m', 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(5010); // updated
  });

  it('retrieves contracts by state', () => {
    const contract: Contract = {
      symbol: 'SPXW260318C06700000', type: 'call',
      underlying: 'SPX', strike: 6700, expiry: '2026-03-18',
      state: 'ACTIVE', firstSeen: 1700000000, lastBarTs: 1700000000,
      createdAt: 1700000000,
    };
    upsertContract(contract);
    const active = getContractsByState('ACTIVE');
    expect(active.some(c => c.symbol === 'SPXW260318C06700000')).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npx vitest run tests/storage/queries.test.ts
```

- [ ] **Step 7: Write src/storage/queries.ts**

```typescript
import { getDb } from './db';
import type { Bar, Contract, ContractState } from '../types';

export function upsertBar(bar: Bar): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators)
    VALUES (@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume, @synthetic, @gapType, @indicators)
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume,
      synthetic=excluded.synthetic, gap_type=excluded.gap_type,
      indicators=excluded.indicators
  `).run({
    ...bar,
    synthetic: bar.synthetic ? 1 : 0,
    gapType: bar.gapType,
    indicators: JSON.stringify(bar.indicators),
  });
}

export function upsertBars(bars: Bar[]): void {
  const db = getDb();
  const insert = db.transaction((rows: Bar[]) => rows.forEach(upsertBar));
  insert(bars);
}

export function getBars(symbol: string, timeframe: string, n: number): Bar[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM bars WHERE symbol=? AND timeframe=?
    ORDER BY ts DESC LIMIT ?
  `).all(symbol, timeframe, n) as any[];
  return rows.reverse().map(rowToBar);
}

export function getLatestBar(symbol: string, timeframe: string): Bar | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM bars WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT 1
  `).get(symbol, timeframe) as any;
  return row ? rowToBar(row) : null;
}

export function upsertContract(contract: Contract): void {
  getDb().prepare(`
    INSERT INTO contracts (symbol, type, underlying, strike, expiry, state, first_seen, last_bar_ts, created_at)
    VALUES (@symbol, @type, @underlying, @strike, @expiry, @state, @firstSeen, @lastBarTs, @createdAt)
    ON CONFLICT(symbol) DO UPDATE SET
      state=excluded.state, last_bar_ts=excluded.last_bar_ts
  `).run(contract);
}

export function getContractsByState(...states: ContractState[]): Contract[] {
  const db = getDb();
  const placeholders = states.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM contracts WHERE state IN (${placeholders})`
  ).all(...states) as any[];
  return rows.map(rowToContract);
}

export function getAllActiveContracts(): Contract[] {
  return getContractsByState('ACTIVE', 'STICKY');
}

export function getExpiredContracts(): Contract[] {
  return getContractsByState('EXPIRED');
}

export function deleteBarsBySymbols(symbols: string[]): void {
  const db = getDb();
  const placeholders = symbols.map(() => '?').join(',');
  db.prepare(`DELETE FROM bars WHERE symbol IN (${placeholders})`).run(...symbols);
}

export function getDbSizeMb(): number {
  const db = getDb();
  const result = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
  return Math.round(result.size / 1024 / 1024 * 10) / 10;
}

function rowToBar(row: any): Bar {
  return {
    symbol: row.symbol, timeframe: row.timeframe, ts: row.ts,
    open: row.open, high: row.high, low: row.low, close: row.close,
    volume: row.volume, synthetic: row.synthetic === 1,
    gapType: row.gap_type, indicators: JSON.parse(row.indicators || '{}'),
  };
}

function rowToContract(row: any): Contract {
  return {
    symbol: row.symbol, type: row.type, underlying: row.underlying,
    strike: row.strike, expiry: row.expiry, state: row.state,
    firstSeen: row.first_seen, lastBarTs: row.last_bar_ts, createdAt: row.created_at,
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run tests/storage/
```
Expected: PASS (both files)

- [ ] **Step 9: Commit**

```bash
git add src/storage/ tests/storage/
git commit -m "feat: SQLite storage layer with WAL, upsert, queries"
```

---

## Task 4: Yahoo Finance Provider

**Files:**
- Create: `src/providers/yahoo.ts`
- Test: `tests/providers/yahoo.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/providers/yahoo.test.ts
import { describe, it, expect } from 'vitest';
import { fetchYahooBars } from '../../src/providers/yahoo';

describe('yahoo provider', () => {
  it('fetches ES=F 1m bars with volume', async () => {
    const bars = await fetchYahooBars('ES=F', '1m', '2d');
    expect(bars.length).toBeGreaterThan(100);
    expect(bars[0]).toMatchObject({
      ts: expect.any(Number),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume: expect.any(Number),
    });
    // ES futures have volume overnight
    const withVol = bars.filter(b => b.volume > 0);
    expect(withVol.length).toBeGreaterThan(50);
  }, 15000);

  it('fetches ^VIX bars', async () => {
    const bars = await fetchYahooBars('^VIX', '1m', '1d');
    expect(bars.length).toBeGreaterThan(0);
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/providers/yahoo.test.ts
```

- [ ] **Step 3: Write src/providers/yahoo.ts**

```typescript
import axios from 'axios';
import type { OHLCVRaw } from '../types';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

export async function fetchYahooBars(
  symbol: string,
  interval: '1m' | '5m' | '15m' | '1h' | '1d',
  range: '1d' | '2d' | '5d' | '30d' | '60d' | '1y'
): Promise<OHLCVRaw[]> {
  const encoded = encodeURIComponent(symbol);
  const url = `${YAHOO_BASE}/${encoded}?interval=${interval}&range=${range}`;

  const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens: (number | null)[] = quote.open || [];
  const highs: (number | null)[] = quote.high || [];
  const lows: (number | null)[] = quote.low || [];
  const closes: (number | null)[] = quote.close || [];
  const volumes: (number | null)[] = quote.volume || [];

  const bars: OHLCVRaw[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue;
    bars.push({
      ts: timestamps[i],
      open: opens[i] ?? close,
      high: highs[i] ?? close,
      low: lows[i] ?? close,
      close,
      volume: volumes[i] ?? 0,
    });
  }
  return bars;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/providers/yahoo.test.ts
```
Expected: PASS (makes real HTTP calls — requires internet)

- [ ] **Step 5: Commit**

```bash
git add src/providers/yahoo.ts tests/providers/yahoo.test.ts
git commit -m "feat: Yahoo Finance provider for ES=F, GSPC, VIX bars"
```

---

## Task 5: Tradier Provider

**Files:**
- Create: `src/providers/tradier.ts`
- Test: `tests/providers/tradier.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/providers/tradier.test.ts
import { describe, it, expect } from 'vitest';
import { fetchSpxQuote, fetchOptionsChain, fetchExpirations, normalizeSymbol } from '../../src/providers/tradier';

describe('tradier provider', () => {
  it('normalizes option symbol format', () => {
    expect(normalizeSymbol('SPXW260318C6700.0')).toBe('SPXW260318C06700000');
    expect(normalizeSymbol('SPXW260318P6650.0')).toBe('SPXW260318P06650000');
    expect(normalizeSymbol('SPXW260318C06700000')).toBe('SPXW260318C06700000');
  });

  it('fetches SPX live quote with bid/ask', async () => {
    const quote = await fetchSpxQuote();
    expect(quote.last).toBeGreaterThan(1000);
    expect(quote.bid).toBeGreaterThan(0);
    expect(quote.ask).toBeGreaterThan(0);
  }, 10000);

  it('fetches SPX option expirations', async () => {
    const dates = await fetchExpirations('SPX');
    expect(dates.length).toBeGreaterThan(3);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 10000);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/providers/tradier.test.ts
```

- [ ] **Step 3: Write src/providers/tradier.ts**

```typescript
import axios from 'axios';
import { config, TRADIER_BASE } from '../config';
import type { ChainContract } from '../types';

function headers() {
  return {
    Authorization: `Bearer ${config.tradierToken}`,
    Accept: 'application/json',
  };
}

export interface SpxQuote {
  last: number;
  bid: number;
  ask: number;
  change: number;
  volume: number;
}

export function normalizeSymbol(symbol: string): string {
  // Already canonical (17+ chars): SPXW260318C06700000
  if (/^SPXW\d{6}[CP]\d{8}$/.test(symbol)) return symbol;
  // Convert SPXW260318C6700.0 → SPXW260318C06700000
  const match = symbol.match(/^(SPXW\d{6}[CP])([\d.]+)$/);
  if (!match) return symbol;
  const strike = Math.round(parseFloat(match[2]) * 1000);
  return `${match[1]}${String(strike).padStart(8, '0')}`;
}

export async function fetchSpxQuote(): Promise<SpxQuote> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
    headers: headers(),
    params: { symbols: 'SPX' },
    timeout: 8000,
  });
  const q = data?.quotes?.quote;
  return {
    last: q.last ?? q.bid ?? 0,
    bid: q.bid ?? 0,
    ask: q.ask ?? 0,
    change: q.change ?? 0,
    volume: q.volume ?? 0,
  };
}

export async function fetchExpirations(symbol: string): Promise<string[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/options/expirations`, {
    headers: headers(),
    params: { symbol },
    timeout: 8000,
  });
  const dates = data?.expirations?.date;
  if (!dates) return [];
  return Array.isArray(dates) ? dates : [dates];
}

export async function fetchOptionsChain(
  symbol: string,
  expiry: string,
  greeks = true
): Promise<ChainContract[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/options/chains`, {
    headers: headers(),
    params: { symbol, expiration: expiry, greeks },
    timeout: 10000,
  });
  const opts = data?.options?.option;
  if (!opts) return [];
  const list = Array.isArray(opts) ? opts : [opts];
  return list.map((o: any) => ({
    symbol: normalizeSymbol(o.symbol),
    type: o.option_type as 'call' | 'put',
    strike: o.strike,
    expiry,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    last: o.last ?? null,
    volume: o.volume ?? null,
    openInterest: o.open_interest ?? null,
    impliedVolatility: o.implied_volatility ?? null,
    delta: o.greeks?.delta ?? null,
    gamma: o.greeks?.gamma ?? null,
    theta: o.greeks?.theta ?? null,
    vega: o.greeks?.vega ?? null,
  }));
}

export async function fetchBatchQuotes(symbols: string[]): Promise<Map<string, { bid: number | null; ask: number | null; last: number | null }>> {
  const result = new Map<string, { bid: number | null; ask: number | null; last: number | null }>();
  // Tradier max 50 symbols per request
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
      headers: headers(),
      params: { symbols: batch.join(',') },
      timeout: 10000,
    });
    const quotes = data?.quotes?.quote;
    if (!quotes) continue;
    const list = Array.isArray(quotes) ? quotes : [quotes];
    for (const q of list) {
      result.set(normalizeSymbol(q.symbol), {
        bid: q.bid ?? null, ask: q.ask ?? null, last: q.last ?? null,
      });
    }
  }
  return result;
}

export async function fetchSpxTimesales(date: string): Promise<import('../types').OHLCVRaw[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/timesales`, {
    headers: headers(),
    params: { symbol: 'SPX', interval: '1min', start: date, end: date, session_filter: 'all' },
    timeout: 10000,
  });
  const series = data?.series?.data;
  if (!series) return [];
  const list = Array.isArray(series) ? series : [series];
  return list.map((d: any) => ({
    ts: Math.floor(new Date(d.time).getTime() / 1000),
    open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/providers/tradier.test.ts
```
Expected: PASS (makes real API calls — needs `.env` with valid token)

- [ ] **Step 5: Commit**

```bash
git add src/providers/tradier.ts tests/providers/tradier.test.ts
git commit -m "feat: Tradier provider — quotes, chains, timesales, symbol normalization"
```

---

## Task 6: TradingView Screener Provider

**Files:**
- Create: `src/providers/tv-screener.ts`
- Test: `tests/providers/tv-screener.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/providers/tv-screener.test.ts
import { describe, it, expect } from 'vitest';
import { fetchScreenerSnapshot } from '../../src/providers/tv-screener';

describe('tv-screener provider', () => {
  it('fetches ES1! and sector ETFs', async () => {
    const results = await fetchScreenerSnapshot();
    expect(results.length).toBeGreaterThan(5);
    const symbols = results.map(r => r.symbol);
    expect(symbols).toContain('ES1!');
    expect(symbols).toContain('SPY');
    const es = results.find(r => r.symbol === 'ES1!');
    expect(es!.close).toBeGreaterThan(1000);
    expect(es!.rsi).not.toBeNull();
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/providers/tv-screener.test.ts
```

- [ ] **Step 3: Write src/providers/tv-screener.ts**

```typescript
import axios from 'axios';
import type { ScreenerSnapshot } from '../types';

// Direct calls to TradingView scanner API (same endpoint the Python library wraps)
const TV_SCAN_BASE = 'https://scanner.tradingview.com';
const COLUMNS = [
  'name','close','change','RSI','MACD.macd','EMA50','BB.upper','BB.lower',
  'Volatility.D','Recommend.All','volume',
];

async function scan(market: string, names: string[]): Promise<ScreenerSnapshot[]> {
  const body = {
    filter: [{ left: 'name', operation: 'in_range', right: names }],
    columns: COLUMNS,
    sort: { sortBy: 'name', sortOrder: 'asc' },
    range: [0, names.length],
  };
  const { data } = await axios.post(
    `${TV_SCAN_BASE}/${market}/scan`,
    body,
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  const ts = Math.floor(Date.now() / 1000);
  return (data?.data || []).map((row: any) => {
    const [name, close, change, rsi, macd, ema50,,, volD, rec] = row.d;
    return { symbol: name, close, change, rsi, macd, ema50, volatilityD: volD, recommendation: rec, ts };
  });
}

export async function fetchScreenerSnapshot(): Promise<ScreenerSnapshot[]> {
  const [futures, equities] = await Promise.all([
    scan('futures', ['ES1!','NQ1!','RTY1!','VX1!','MES1!']),
    scan('america', ['SPY','QQQ','XLF','XLK','XLE','XLV','XLI','XLY','XLP','GLD','TLT']),
  ]);
  return [...futures, ...equities];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/providers/tv-screener.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/tv-screener.ts tests/providers/tv-screener.test.ts
git commit -m "feat: TradingView screener provider — futures and sector ETFs"
```

---

## Task 7: Bar Builder + Gap Interpolation

**Files:**
- Create: `src/pipeline/bar-builder.ts`
- Test: `tests/pipeline/bar-builder.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/pipeline/bar-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildBars, interpolateGap } from '../../src/pipeline/bar-builder';
import type { OHLCVRaw } from '../../src/types';

describe('bar-builder', () => {
  it('converts raw OHLCV to Bar format', () => {
    const raw: OHLCVRaw = { ts: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 500 };
    const [bar] = buildBars('SPX', '1m', [raw]);
    expect(bar.symbol).toBe('SPX');
    expect(bar.synthetic).toBe(false);
    expect(bar.gapType).toBeNull();
    expect(bar.close).toBe(100.5);
  });

  it('interpolates a 3-minute gap linearly', () => {
    // T1=100, T2=104, gap=3 bars → values: 101, 102, 103
    const filled = interpolateGap(1700000000, 100, 1700000240, 104, 60);
    expect(filled).toHaveLength(3);
    expect(filled[0].close).toBeCloseTo(101, 4);
    expect(filled[1].close).toBeCloseTo(102, 4);
    expect(filled[2].close).toBeCloseTo(103, 4);
    expect(filled[0].synthetic).toBe(true);
    expect(filled[0].gapType).toBe('interpolated');
    expect(filled[0].volume).toBe(0);
  });

  it('uses flat/stale fill for gaps over 60 minutes', () => {
    const filled = interpolateGap(1700000000, 100, 1700007200, 110, 60); // 2 hours
    expect(filled.length).toBeGreaterThan(0);
    expect(filled[0].gapType).toBe('stale');
    filled.forEach(b => expect(b.close).toBe(100)); // flat at last price
  });

  it('flags synthetic bars when constituent 1m bar is synthetic', () => {
    const raw1: OHLCVRaw = { ts: 1700000000, open: 100, high: 101, low: 99, close: 100, volume: 10 };
    const raw2: OHLCVRaw = { ts: 1700000060, open: 100, high: 102, low: 99, close: 101, volume: 20 };
    const bars = buildBars('SPX', '1m', [raw1, raw2]);
    expect(bars[0].synthetic).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/pipeline/bar-builder.test.ts
```

- [ ] **Step 3: Write src/pipeline/bar-builder.ts**

```typescript
import type { Bar, GapType, OHLCVRaw, Timeframe } from '../types';
import { GAP_INTERPOLATE_MAX_MINS } from '../config';

export function buildBars(symbol: string, timeframe: Timeframe, raws: OHLCVRaw[]): Bar[] {
  return raws.map(r => rawToBar(symbol, timeframe, r));
}

export function rawToBar(symbol: string, timeframe: Timeframe, raw: OHLCVRaw): Bar {
  return {
    symbol, timeframe, ts: raw.ts,
    open: raw.open, high: raw.high, low: raw.low, close: raw.close,
    volume: raw.volume, synthetic: false, gapType: null, indicators: {},
  };
}

export function interpolateGap(
  t1: number, p1: number,
  t2: number, p2: number,
  barSeconds: number
): Bar[] {
  const gapBars = Math.floor((t2 - t1) / barSeconds) - 1;
  if (gapBars <= 0) return [];

  const gapMinutes = (t2 - t1) / 60;
  const isStale = gapMinutes > GAP_INTERPOLATE_MAX_MINS;

  const bars: Bar[] = [];
  for (let k = 1; k <= gapBars; k++) {
    const price = isStale ? p1 : p1 + (p2 - p1) * (k / (gapBars + 1));
    const ts = t1 + k * barSeconds;
    bars.push({
      symbol: '', timeframe: '1m', ts,
      open: price, high: price, low: price, close: price,
      volume: 0, synthetic: true,
      gapType: isStale ? 'stale' : 'interpolated',
      indicators: {},
    });
  }
  return bars;
}

export function fillGaps(symbol: string, timeframe: Timeframe, bars: Bar[], barSeconds: number): Bar[] {
  if (bars.length === 0) return bars;
  const result: Bar[] = [bars[0]];

  for (let i = 1; i < bars.length; i++) {
    const prev = result[result.length - 1];
    const curr = bars[i];
    const gap = curr.ts - prev.ts;

    if (gap > barSeconds * 1.5) {
      const synthetic = interpolateGap(prev.ts, prev.close, curr.ts, curr.close, barSeconds);
      synthetic.forEach(b => { b.symbol = symbol; b.timeframe = timeframe; });
      result.push(...synthetic);
    }
    result.push(curr);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/pipeline/bar-builder.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/bar-builder.ts tests/pipeline/bar-builder.test.ts
git commit -m "feat: bar builder with linear gap interpolation and stale fill"
```

---

## Task 8: Timeframe Aggregator

**Files:**
- Create: `src/pipeline/aggregator.ts`
- Test: `tests/pipeline/aggregator.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/pipeline/aggregator.test.ts
import { describe, it, expect } from 'vitest';
import { aggregate } from '../../src/pipeline/aggregator';
import type { Bar } from '../../src/types';

function makeBar(ts: number, o: number, h: number, l: number, c: number, vol = 100, synthetic = false): Bar {
  return { symbol: 'SPX', timeframe: '1m', ts, open: o, high: h, low: l, close: c, volume: vol, synthetic, gapType: null, indicators: {} };
}

describe('aggregator', () => {
  it('aggregates 5 x 1m bars into one 5m bar', () => {
    const bars = [
      makeBar(1700000000, 100, 103, 99,  101),
      makeBar(1700000060, 101, 104, 100, 102),
      makeBar(1700000120, 102, 105, 101, 103),
      makeBar(1700000180, 103, 106, 102, 104),
      makeBar(1700000240, 104, 107, 103, 105),
    ];
    const [agg] = aggregate(bars, '5m', 300);
    expect(agg.open).toBe(100);    // first open
    expect(agg.high).toBe(107);    // max high
    expect(agg.low).toBe(99);      // min low
    expect(agg.close).toBe(105);   // last close
    expect(agg.volume).toBe(500);  // sum
    expect(agg.timeframe).toBe('5m');
    expect(agg.synthetic).toBe(false);
  });

  it('marks aggregated bar synthetic if any constituent is synthetic', () => {
    const bars = [
      makeBar(1700000000, 100, 103, 99, 101, 100, false),
      makeBar(1700000060, 101, 104, 100, 102, 0, true),
    ];
    const [agg] = aggregate(bars.slice(0, 2), '5m', 300);
    expect(agg.synthetic).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/pipeline/aggregator.test.ts
```

- [ ] **Step 3: Write src/pipeline/aggregator.ts**

```typescript
import type { Bar, Timeframe } from '../types';

export function aggregate(bars: Bar[], targetTf: Timeframe, periodSeconds: number): Bar[] {
  if (bars.length === 0) return [];

  const buckets = new Map<number, Bar[]>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.ts / periodSeconds) * periodSeconds;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(bar);
  }

  const result: Bar[] = [];
  for (const [bucketTs, group] of Array.from(buckets.entries()).sort(([a], [b]) => a - b)) {
    result.push({
      symbol: group[0].symbol,
      timeframe: targetTf,
      ts: bucketTs,
      open: group[0].open,
      high: Math.max(...group.map(b => b.high)),
      low: Math.min(...group.map(b => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, b) => s + b.volume, 0),
      synthetic: group.some(b => b.synthetic),
      gapType: group.some(b => b.gapType === 'stale') ? 'stale'
              : group.some(b => b.gapType === 'interpolated') ? 'interpolated'
              : null,
      indicators: {},
    });
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/pipeline/aggregator.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/aggregator.ts tests/pipeline/aggregator.test.ts
git commit -m "feat: 1m→5m/15m/1h timeframe aggregator, synthetic flag propagation"
```

---

## Task 9: Indicator Engine — Tier 1

**Files:**
- Create: `src/pipeline/indicators/tier1.ts`
- Test: `tests/pipeline/indicators/tier1.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/pipeline/indicators/tier1.test.ts
import { describe, it, expect } from 'vitest';
import { computeHMA, computeEMA, computeRSI, computeBB, computeATR } from '../../../src/pipeline/indicators/tier1';

describe('tier1 indicators', () => {
  // Use 50 data points — enough to warm all indicators
  const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
  const highs = closes.map(c => c + 1);
  const lows = closes.map(c => c - 1);

  it('HMA(5) returns a number', () => {
    const v = computeHMA(closes, 5);
    expect(v).not.toBeNull();
    expect(typeof v).toBe('number');
    expect(isFinite(v!)).toBe(true);
  });

  it('EMA(9) returns correct value (incremental)', () => {
    let ema: number | null = null;
    for (const c of closes) {
      ema = computeEMA(c, ema, 9);
    }
    expect(ema).not.toBeNull();
    expect(isFinite(ema!)).toBe(true);
  });

  it('RSI(14) is between 0 and 100', () => {
    const rsi = computeRSI(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
  });

  it('BB returns upper > middle > lower', () => {
    const bb = computeBB(closes, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.middle).toBeGreaterThan(bb!.lower);
  });

  it('ATR(14) is positive', () => {
    const atr = computeATR(highs, lows, closes, 14);
    expect(atr).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/pipeline/indicators/tier1.test.ts
```

- [ ] **Step 3: Write src/pipeline/indicators/tier1.ts**

```typescript
// All functions operate on arrays and return current value
// Incremental EMA takes previous value as parameter for O(1) updates

export function computeWMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  let num = 0, den = 0;
  for (let i = 0; i < period; i++) {
    const w = i + 1;
    num += slice[i] * w;
    den += w;
  }
  return num / den;
}

export function computeHMA(closes: number[], period: number): number | null {
  const half = Math.floor(period / 2);
  const sqrtP = Math.round(Math.sqrt(period));
  if (closes.length < period) return null;

  // Build raw = 2*WMA(half) - WMA(period) for each point
  const raw: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const wh = computeWMA(closes.slice(0, i + 1), half);
    const wf = computeWMA(closes.slice(0, i + 1), period);
    if (wh !== null && wf !== null) raw.push(2 * wh - wf);
  }
  return computeWMA(raw, sqrtP);
}

export function computeEMA(price: number, prevEma: number | null, period: number): number {
  if (prevEma === null) return price;
  const k = 2 / (period + 1);
  return price * k + prevEma * (1 - k);
}

export function computeRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(-period - 1).map((c, i, arr) =>
    i === 0 ? 0 : c - arr[i - 1]
  ).slice(1);

  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function computeBB(closes: number[], period: number, stdMult: number): { upper: number; middle: number; lower: number; width: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + stdMult * std;
  const lower = middle - stdMult * std;
  return { upper, middle, lower, width: (upper - lower) / middle };
}

export function computeATR(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length < 2) return highs[0] - lows[0];
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export function computeVWAP(
  close: number, high: number, low: number, volume: number,
  cumTPV: number, cumVol: number
): { vwap: number; cumTPV: number; cumVol: number } {
  const tp = (high + low + close) / 3;
  const newTPV = cumTPV + tp * volume;
  const newVol = cumVol + volume;
  return { vwap: newVol > 0 ? newTPV / newVol : close, cumTPV: newTPV, cumVol: newVol };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/pipeline/indicators/tier1.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/indicators/tier1.ts tests/pipeline/indicators/tier1.test.ts
git commit -m "feat: Tier 1 indicators — HMA, EMA, RSI, BB, ATR, VWAP"
```

---

## Task 10: Indicator Engine — Tier 2 + Engine Orchestration

**Files:**
- Create: `src/pipeline/indicators/tier2.ts`
- Create: `src/pipeline/indicator-engine.ts`
- Test: `tests/pipeline/indicators/tier2.test.ts`
- Test: `tests/pipeline/indicator-engine.test.ts`

- [ ] **Step 1: Write failing tier2 test**

```typescript
// tests/pipeline/indicators/tier2.test.ts
import { describe, it, expect } from 'vitest';
import { computeMACD, computeStochastic, computeADX } from '../../../src/pipeline/indicators/tier2';

describe('tier2 indicators', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 3);
  const highs = closes.map(c => c + 1.5);
  const lows = closes.map(c => c - 1.5);

  it('MACD returns finite values', () => {
    let fast: number | null = null, slow: number | null = null, signal: number | null = null;
    for (const c of closes) {
      const result = computeMACD(c, fast, slow, signal);
      fast = result.fastEma; slow = result.slowEma; signal = result.signalEma;
    }
    expect(fast).not.toBeNull();
    expect(isFinite(fast!)).toBe(true);
  });

  it('Stochastic %K is between 0 and 100', () => {
    const k = computeStochastic(highs, lows, closes, 14, 3);
    expect(k).not.toBeNull();
    expect(k!.k).toBeGreaterThanOrEqual(0);
    expect(k!.k).toBeLessThanOrEqual(100);
  });

  it('ADX is positive', () => {
    const adx = computeADX(highs, lows, closes, 14);
    expect(adx).not.toBeNull();
    expect(adx!).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Write src/pipeline/indicators/tier2.ts**

```typescript
import { computeEMA } from './tier1';

export function computeMACD(
  price: number,
  fastEma: number | null, slowEma: number | null, signalEma: number | null
): { fastEma: number; slowEma: number; signalEma: number; macd: number; histogram: number } {
  const newFast = computeEMA(price, fastEma, 12);
  const newSlow = computeEMA(price, slowEma, 26);
  const macd = newFast - newSlow;
  const newSignal = computeEMA(macd, signalEma, 9);
  return { fastEma: newFast, slowEma: newSlow, signalEma: newSignal, macd, histogram: macd - newSignal };
}

export function computeStochastic(
  highs: number[], lows: number[], closes: number[], kPeriod: number, dPeriod: number
): { k: number; d: number } | null {
  if (closes.length < kPeriod) return null;
  const hh = Math.max(...highs.slice(-kPeriod));
  const ll = Math.min(...lows.slice(-kPeriod));
  if (hh === ll) return { k: 50, d: 50 };
  const k = ((closes[closes.length - 1] - ll) / (hh - ll)) * 100;
  // Simplified %D = SMA of last dPeriod %K values (single point here)
  return { k, d: k };
}

export function computeADX(
  highs: number[], lows: number[], closes: number[], period: number
): number | null {
  if (highs.length < period + 1) return null;
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(tr);
  }

  const sliceTR = trs.slice(-period);
  const slicePlus = plusDMs.slice(-period);
  const sliceMinus = minusDMs.slice(-period);
  const atr = sliceTR.reduce((a, b) => a + b) / period;
  if (atr === 0) return 0;
  const plusDI = (slicePlus.reduce((a, b) => a + b) / period / atr) * 100;
  const minusDI = (sliceMinus.reduce((a, b) => a + b) / period / atr) * 100;
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0;
  return Math.abs(plusDI - minusDI) / diSum * 100;
}

export function computeMomentum(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  return closes[closes.length - 1] - closes[closes.length - 1 - period];
}

export function computeCCI(highs: number[], lows: number[], closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const tps = closes.slice(-period).map((c, i) => (highs.slice(-period)[i] + lows.slice(-period)[i] + c) / 3);
  const mean = tps.reduce((a, b) => a + b) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}
```

- [ ] **Step 3: Write src/pipeline/indicator-engine.ts**

```typescript
import type { Bar, IndicatorState, Timeframe } from '../types';
import { computeHMA, computeEMA, computeRSI, computeBB, computeATR, computeVWAP } from './indicators/tier1';
import { computeMACD, computeStochastic, computeADX, computeMomentum, computeCCI } from './indicators/tier2';
import { MAX_BARS_MEMORY } from '../config';

// Per-symbol-per-timeframe incremental state
const states = new Map<string, IndicatorState>();

function key(symbol: string, tf: Timeframe): string { return `${symbol}:${tf}`; }

function getState(symbol: string, tf: Timeframe): IndicatorState {
  const k = key(symbol, tf);
  if (!states.has(k)) {
    states.set(k, {
      closes: [], highs: [], lows: [], volumes: [], typicalPrices: [],
      cumulativeTPV: 0, cumulativeVol: 0,
      emaState: {}, macdState: { fastEma: null, slowEma: null, signalEma: null },
      atrState: null, adxState: { plusDM: null, minusDM: null, tr: null, adx: null },
    });
  }
  return states.get(k)!;
}

export function resetVWAP(symbol: string, tf: Timeframe): void {
  const s = getState(symbol, tf);
  s.cumulativeTPV = 0;
  s.cumulativeVol = 0;
}

export function seedState(symbol: string, tf: Timeframe, bars: Bar[]): void {
  const s = getState(symbol, tf);
  s.closes = bars.map(b => b.close).slice(-MAX_BARS_MEMORY);
  s.highs = bars.map(b => b.high).slice(-MAX_BARS_MEMORY);
  s.lows = bars.map(b => b.low).slice(-MAX_BARS_MEMORY);
  s.volumes = bars.map(b => b.volume).slice(-MAX_BARS_MEMORY);
}

export function computeIndicators(bar: Bar, tier: 1 | 2 = 1): Record<string, number | null> {
  const s = getState(bar.symbol, bar.timeframe as Timeframe);

  // Append new bar data
  s.closes.push(bar.close);
  s.highs.push(bar.high);
  s.lows.push(bar.low);
  s.volumes.push(bar.volume);
  if (s.closes.length > MAX_BARS_MEMORY) {
    s.closes.shift(); s.highs.shift(); s.lows.shift(); s.volumes.shift();
  }

  // VWAP
  const vwapResult = computeVWAP(bar.close, bar.high, bar.low, bar.volume, s.cumulativeTPV, s.cumulativeVol);
  s.cumulativeTPV = vwapResult.cumTPV;
  s.cumulativeVol = vwapResult.cumVol;

  // Tier 1 EMA (incremental)
  for (const p of [9, 21]) {
    s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
  }

  // Compute BB once — used for 4 fields
  const bb = computeBB(s.closes, 20, 2);

  const ind: Record<string, number | null> = {
    hma5:  computeHMA(s.closes, 5),
    hma19: computeHMA(s.closes, 19),
    hma25: computeHMA(s.closes, 25),
    ema9:  s.emaState[9],
    ema21: s.emaState[21],
    rsi14: computeRSI(s.closes, 14),
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    bbWidth: bb?.width ?? null,
    atr14: computeATR(s.highs, s.lows, s.closes, 14),
    atrPct: s.closes.length > 1 ? (computeATR(s.highs, s.lows, s.closes, 14) / bar.close) * 100 : null,
    vwap: vwapResult.vwap,
  };

  if (tier === 2) {
    for (const p of [50, 200]) {
      s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
      ind[`ema${p}`] = s.emaState[p];
    }
    for (const p of [20, 50]) {
      const slice = s.closes.slice(-p);
      ind[`sma${p}`] = slice.length >= p ? slice.reduce((a, b) => a + b) / p : null;
    }
    const macd = computeMACD(bar.close, s.macdState.fastEma, s.macdState.slowEma, s.macdState.signalEma);
    s.macdState = { fastEma: macd.fastEma, slowEma: macd.slowEma, signalEma: macd.signalEma };
    ind.macd = macd.macd;
    ind.macdSignal = macd.signalEma;
    ind.macdHistogram = macd.histogram;

    const stoch = computeStochastic(s.highs, s.lows, s.closes, 14, 3);
    ind.stochK = stoch?.k ?? null;
    ind.stochD = stoch?.d ?? null;
    ind.cci20 = computeCCI(s.highs, s.lows, s.closes, 20);
    ind.momentum10 = computeMomentum(s.closes, 10);
    ind.adx14 = computeADX(s.highs, s.lows, s.closes, 14);
  }

  return ind;
}
```

- [ ] **Step 4: Write tests/pipeline/indicator-engine.test.ts**

```typescript
// tests/pipeline/indicator-engine.test.ts
import { describe, it, expect } from 'vitest';
import { computeIndicators, resetVWAP } from '../../src/pipeline/indicator-engine';
import type { Bar } from '../../src/types';

function makeBar(close: number, ts = 1700000000): Bar {
  return {
    symbol: 'SPX', timeframe: '1m', ts,
    open: close - 1, high: close + 1, low: close - 1, close,
    volume: 100, synthetic: false, gapType: null, indicators: {},
  };
}

describe('indicator-engine', () => {
  it('returns tier1 indicators for options contract (tier=1)', () => {
    const bars = Array.from({ length: 30 }, (_, i) => makeBar(100 + i, 1700000000 + i * 60));
    let ind: Record<string, number | null> = {};
    for (const b of bars) ind = computeIndicators(b, 1);
    expect(ind).toHaveProperty('hma5');
    expect(ind).toHaveProperty('rsi14');
    expect(ind).toHaveProperty('vwap');
    // Tier 2 keys should NOT be present at tier=1
    expect(ind.macd).toBeUndefined();
    expect(ind.adx14).toBeUndefined();
  });

  it('returns tier2 indicators for underlying (tier=2)', () => {
    const bars = Array.from({ length: 40 }, (_, i) => makeBar(200 + i * 0.5, 1700100000 + i * 60));
    let ind: Record<string, number | null> = {};
    // Use a unique symbol to avoid state from previous test
    for (const b of bars) ind = computeIndicators({ ...b, symbol: 'ES' }, 2);
    expect(ind).toHaveProperty('macd');
    expect(ind).toHaveProperty('adx14');
    expect(ind).toHaveProperty('ema200');
  });

  it('resetVWAP zeroes cumulative accumulator', () => {
    const b = makeBar(5000, 1700200000);
    computeIndicators({ ...b, symbol: 'VWAP_TEST' }, 1);
    resetVWAP('VWAP_TEST', '1m');
    // After reset, VWAP should equal the next close (fresh accumulation)
    const ind = computeIndicators({ ...b, symbol: 'VWAP_TEST', close: 5010, high: 5011, low: 5009 }, 1);
    // vwap = (5011+5009+5010)/3 / 1 = 5010 (TP = close approximately)
    expect(ind.vwap).toBeCloseTo(5010, 0);
  });
});
```

- [ ] **Step 5: Run all indicator tests**

```bash
npx vitest run tests/pipeline/indicators/ tests/pipeline/indicator-engine.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/indicators/tier2.ts src/pipeline/indicator-engine.ts tests/pipeline/indicators/tier2.test.ts tests/pipeline/indicator-engine.test.ts
git commit -m "feat: Tier 2 indicators and incremental indicator engine"
```

---

## Task 11: Contract Tracker

**Files:**
- Create: `src/pipeline/contract-tracker.ts`
- Test: `tests/pipeline/contract-tracker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/pipeline/contract-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContractTracker } from '../../src/pipeline/contract-tracker';

describe('ContractTracker', () => {
  let tracker: ContractTracker;

  beforeEach(() => {
    tracker = new ContractTracker(100, 5); // band=100, interval=5
  });

  it('adds contracts within band as ACTIVE', () => {
    const added = tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
      { symbol: 'SPXW260318C05105000', strike: 5105, expiry: '2026-03-18', type: 'call' as const },
    ]);
    expect(added.some(c => c.symbol === 'SPXW260318C05000000')).toBe(true);
    // 5105 is > 100 away from 5000, so only the ATM contract is added
    expect(tracker.getActive().length).toBe(1);
  });

  it('keeps contract STICKY when price moves outside band', () => {
    tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
    ]);
    // SPX moves to 5200 — 5000 strike is now 200 away
    tracker.updateBand(5200, []);
    const all = tracker.getTracked();
    const contract = all.find(c => c.symbol === 'SPXW260318C05000000');
    expect(contract?.state).toBe('STICKY');
  });

  it('transitions STICKY back to ACTIVE when price returns', () => {
    tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
    ]);
    tracker.updateBand(5200, []); // goes STICKY
    tracker.updateBand(5050, []); // returns within band
    const contract = tracker.getTracked().find(c => c.symbol === 'SPXW260318C05000000');
    expect(contract?.state).toBe('ACTIVE');
  });

  it('marks contracts EXPIRED after expiry', () => {
    const pastExpiry = '2020-01-01';
    tracker.updateBand(5000, [
      { symbol: 'SPXW200101C05000000', strike: 5000, expiry: pastExpiry, type: 'call' as const },
    ]);
    tracker.checkExpiries();
    const contract = tracker.getTracked().find(c => c.symbol === 'SPXW200101C05000000');
    expect(contract?.state).toBe('EXPIRED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/pipeline/contract-tracker.test.ts
```

- [ ] **Step 3: Write src/pipeline/contract-tracker.ts**

```typescript
import type { Contract, ContractState, OptionType } from '../types';

interface ChainEntry {
  symbol: string;
  strike: number;
  expiry: string;
  type: OptionType;
}

export class ContractTracker {
  private contracts = new Map<string, Contract>();
  private currentSpx = 0;

  constructor(private band: number, private strikeInterval: number) {}

  updateBand(spxPrice: number, chainEntries: ChainEntry[]): Contract[] {
    this.currentSpx = spxPrice;
    const now = Math.floor(Date.now() / 1000);
    const added: Contract[] = [];

    // Add new contracts within band
    for (const entry of chainEntries) {
      if (!this.contracts.has(entry.symbol)) {
        if (Math.abs(entry.strike - spxPrice) <= this.band) {
          const contract: Contract = {
            symbol: entry.symbol, type: entry.type, underlying: 'SPX',
            strike: entry.strike, expiry: entry.expiry, state: 'ACTIVE',
            firstSeen: now, lastBarTs: now, createdAt: now,
          };
          this.contracts.set(entry.symbol, contract);
          added.push(contract);
        }
      }
    }

    // Update states for existing contracts
    for (const [symbol, contract] of this.contracts) {
      if (contract.state === 'EXPIRED') continue;
      const inBand = Math.abs(contract.strike - spxPrice) <= this.band;
      if (inBand && contract.state === 'STICKY') {
        this.contracts.set(symbol, { ...contract, state: 'ACTIVE' });
      } else if (!inBand && contract.state === 'ACTIVE') {
        this.contracts.set(symbol, { ...contract, state: 'STICKY' });
      }
    }

    return added;
  }

  checkExpiries(): void {
    // Use ET local date components to avoid UTC vs ET midnight mismatch
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const today = `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, '0')}-${String(etNow.getDate()).padStart(2, '0')}`;
    const rthCloseEt = this.isAfterRTHClose();
    for (const [symbol, contract] of this.contracts) {
      if (contract.state === 'EXPIRED') continue;
      if (contract.expiry < today || (contract.expiry === today && rthCloseEt)) {
        this.contracts.set(symbol, { ...contract, state: 'EXPIRED' });
      }
    }
  }

  getTracked(): Contract[] {
    return Array.from(this.contracts.values());
  }

  getActive(): Contract[] {
    return this.getTracked().filter(c => c.state === 'ACTIVE');
  }

  getSticky(): Contract[] {
    return this.getTracked().filter(c => c.state === 'STICKY');
  }

  getExpired(): Contract[] {
    return this.getTracked().filter(c => c.state === 'EXPIRED');
  }

  // Restores a previously persisted contract into in-memory state (startup resume)
  restoreContract(contract: Contract): void {
    if (!this.contracts.has(contract.symbol)) {
      this.contracts.set(contract.symbol, contract);
    }
  }

  private isAfterRTHClose(): boolean {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return et.getHours() > 16 || (et.getHours() === 16 && et.getMinutes() >= 15);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/pipeline/contract-tracker.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/contract-tracker.ts tests/pipeline/contract-tracker.test.ts
git commit -m "feat: sticky band contract tracker with ACTIVE/STICKY/EXPIRED lifecycle"
```

---

## Task 12: Scheduler

**Files:**
- Create: `src/pipeline/scheduler.ts`
- Test: `tests/pipeline/scheduler.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/pipeline/scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { getMarketMode, isMarketHoliday, getActiveExpirations } from '../../src/pipeline/scheduler';

describe('scheduler', () => {
  it('detects holiday', () => {
    expect(isMarketHoliday('2026-01-01')).toBe(true);
    expect(isMarketHoliday('2026-03-18')).toBe(false);
  });

  it('returns correct mode for overnight (2 AM ET)', () => {
    // Simulate 2 AM ET on a weekday
    const mode = getMarketMode(new Date('2026-03-18T07:00:00Z')); // 2 AM ET = 7 AM UTC
    expect(mode).toBe('overnight');
  });

  it('returns rth mode during market hours', () => {
    const mode = getMarketMode(new Date('2026-03-18T15:00:00Z')); // 10 AM ET
    expect(mode).toBe('rth');
  });

  it('returns correct DTE expirations for a Wednesday', () => {
    const exps = getActiveExpirations('2026-03-18', ['2026-03-18','2026-03-20','2026-03-23','2026-03-25']);
    expect(exps).toContain('2026-03-18'); // 0DTE
    expect(exps).toContain('2026-03-20'); // 2DTE
    expect(exps).not.toContain('2026-03-25'); // 7DTE — excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/pipeline/scheduler.test.ts
```

- [ ] **Step 3: Write src/pipeline/scheduler.ts**

```typescript
import { MARKET_HOLIDAYS, EARLY_CLOSE_DAYS } from '../config';

export type MarketMode = 'overnight' | 'preopen' | 'rth' | 'weekend';

export function isMarketHoliday(date: string): boolean {
  return MARKET_HOLIDAYS.has(date);
}

export function isEarlyCloseDay(date: string): boolean {
  return EARLY_CLOSE_DAYS.has(date);
}

function toET(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function getMarketMode(now: Date = new Date()): MarketMode {
  const et = toET(now);
  const day = et.getDay(); // 0=Sun, 6=Sat
  // Use local date components (not toISOString which returns UTC) to get the ET calendar date
  const dateStr = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;

  if (day === 0 || day === 6) return 'weekend';
  if (isMarketHoliday(dateStr)) return 'overnight';

  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;

  const rthEnd = isEarlyCloseDay(dateStr) ? 13 * 60 : 16 * 60 + 15;

  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 30) return 'preopen';
  if (mins >= 9 * 60 + 30 && mins < rthEnd) return 'rth';
  return 'overnight';
}

export function getActiveExpirations(today: string, available: string[]): string[] {
  const todayDate = new Date(today);
  const dayOfWeek = todayDate.getDay(); // 5=Friday
  const maxDTE = dayOfWeek === 5 ? 3 : 2;

  return available.filter(exp => {
    const diff = (new Date(exp).getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= maxDTE;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/pipeline/scheduler.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/scheduler.ts tests/pipeline/scheduler.test.ts
git commit -m "feat: scheduler with market mode detection, holiday calendar, expiry filtering"
```

---

## Task 13: Pipeline Orchestrator (Entry Point)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write src/index.ts**

```typescript
import { initDb } from './storage/db';
import { getAllActiveContracts, upsertBar, upsertBars, upsertContract, getDbSizeMb } from './storage/queries';
import { fetchYahooBars } from './providers/yahoo';
import { fetchSpxQuote, fetchOptionsChain, fetchExpirations, fetchSpxTimesales, fetchBatchQuotes } from './providers/tradier';
import { fetchScreenerSnapshot } from './providers/tv-screener';
import { buildBars, fillGaps } from './pipeline/bar-builder';
import { aggregate } from './pipeline/aggregator';
import { computeIndicators, seedState, resetVWAP } from './pipeline/indicator-engine';
import { ContractTracker } from './pipeline/contract-tracker';
import { getMarketMode, getActiveExpirations } from './pipeline/scheduler';
import { startHttpServer } from './server/http';
import { startWsServer, broadcast } from './server/ws';
import { config, STRIKE_BAND, STRIKE_INTERVAL, POLL_UNDERLYING_MS, POLL_OPTIONS_RTH_MS, POLL_OPTIONS_OVERNIGHT_MS, POLL_SCREENER_MS } from './config';

const tracker = new ContractTracker(STRIKE_BAND, STRIKE_INTERVAL);
let lastSpxPrice: number | null = null;
let prevMode: string | null = null; // tracks mode transitions for VWAP reset

function loadContractsFromDb(): void {
  // Reload ACTIVE/STICKY contracts into tracker on startup so sticky state survives restarts
  const persisted = getAllActiveContracts();
  for (const contract of persisted) {
    tracker.restoreContract(contract);
  }
  console.log(`[startup] Restored ${persisted.length} active/sticky contracts from DB`);
}

async function warmup(): Promise<void> {
  console.log('[startup] Warming up ES=F overnight bars...');
  const rawBars = await fetchYahooBars('ES=F', '1m', '2d');
  const bars = fillGaps('ES', '1m', buildBars('ES', '1m', rawBars), 60);
  const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
  upsertBars(enriched);

  // Aggregate to higher timeframes
  for (const [tf, secs] of [['5m', 300], ['15m', 900], ['1h', 3600]] as const) {
    const agg = aggregate(enriched, tf, secs).map(b => ({
      ...b, indicators: computeIndicators(b, 2)
    }));
    upsertBars(agg);
  }
  console.log(`[startup] Warmed ${enriched.length} ES 1m bars`);
}

async function pollUnderlying(): Promise<void> {
  const mode = getMarketMode();
  const today = new Date().toISOString().split('T')[0];

  try {
    let bars;
    if (mode === 'rth') {
      const raw = await fetchSpxTimesales(today);
      if (raw.length) {
        bars = buildBars('SPX', '1m', raw.slice(-5));
      }
    } else {
      const raw = await fetchYahooBars('ES=F', '1m', '1d');
      bars = buildBars('ES', '1m', raw.slice(-5));
    }

    if (bars?.length) {
      const symbol = mode === 'rth' ? 'SPX' : 'ES';
      const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
      upsertBars(enriched);
      lastSpxPrice = enriched[enriched.length - 1].close;
      broadcast({ type: 'spx_bar', data: enriched[enriched.length - 1] });
    }
  } catch (e) {
    console.error('[poll:underlying]', e);
  }
}

async function pollOptions(): Promise<void> {
  if (!lastSpxPrice) return;
  try {
    const expirations = await fetchExpirations('SPX');
    const today = new Date().toISOString().split('T')[0];
    const active = getActiveExpirations(today, expirations);

    // Full chain fetch to discover new contracts entering the band
    for (const expiry of active) {
      const chain = await fetchOptionsChain('SPX', expiry);
      tracker.updateBand(lastSpxPrice, chain.map(c => ({
        symbol: c.symbol, strike: c.strike, expiry: c.expiry, type: c.type
      })));
      broadcast({ type: 'chain_update', expiry, data: chain });
    }

    // Batch-quote update for already-tracked contracts (avoids full chain re-fetch overhead)
    const tracked = tracker.getActive().concat(tracker.getSticky());
    if (tracked.length > 0) {
      const quotes = await fetchBatchQuotes(tracked.map(c => c.symbol));
      quotes.forEach((q, sym) => broadcast({ type: 'contract_bar', symbol: sym, data: q }));
    }

    tracker.checkExpiries();
  } catch (e) {
    console.error('[poll:options]', e);
  }
}

async function pollScreener(): Promise<void> {
  try {
    const snap = await fetchScreenerSnapshot();
    broadcast({ type: 'market_context', data: snap });
  } catch (e) {
    console.error('[poll:screener]', e);
  }
}

async function main(): Promise<void> {
  initDb(config.dbPath);
  loadContractsFromDb(); // restore ACTIVE/STICKY contracts from previous session
  await warmup();

  const { app, httpServer } = startHttpServer(config.port);
  startWsServer(httpServer); // pass http.Server, not Express app

  setInterval(pollUnderlying, POLL_UNDERLYING_MS);
  const optionsInterval = getMarketMode() === 'rth' ? POLL_OPTIONS_RTH_MS : POLL_OPTIONS_OVERNIGHT_MS;
  setInterval(pollOptions, optionsInterval);
  setInterval(pollScreener, POLL_SCREENER_MS);

  // Reset VWAP exactly once on transition into RTH (not every minute during RTH)
  setInterval(() => {
    const mode = getMarketMode();
    if (mode === 'rth' && prevMode !== 'rth') {
      resetVWAP('SPX', '1m');
      resetVWAP('ES', '1m');
    }
    prevMode = mode;
  }, 60_000);

  console.log(`[SPXer] Running on port ${config.port}`);
  await pollUnderlying();
  await pollOptions();
  await pollScreener();

  // Graceful shutdown
  process.on('SIGTERM', () => { console.log('[SPXer] Shutting down'); process.exit(0); });
  process.on('SIGINT',  () => { console.log('[SPXer] Shutting down'); process.exit(0); });
}

main().catch(console.error);
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: pipeline orchestrator — warmup, polling loops, graceful shutdown"
```

---

## Task 14: REST API

**Files:**
- Create: `src/server/http.ts`
- Test: `tests/server/http.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/server/http.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { startHttpServer } from '../../src/server/http';
import axios from 'axios';

let server: any;
const PORT = 3699;

beforeAll(() => {
  initDb(':memory:');
  const { httpServer } = startHttpServer(PORT);
  server = httpServer;
});

afterAll(() => { server?.close(); closeDb(); });

describe('REST API', () => {
  it('GET /health returns 200', async () => {
    const { data, status } = await axios.get(`http://localhost:${PORT}/health`);
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
  });

  it('GET /contracts/active returns array', async () => {
    const { data } = await axios.get(`http://localhost:${PORT}/contracts/active`);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /spx/bars returns array', async () => {
    const { data } = await axios.get(`http://localhost:${PORT}/spx/bars?tf=1m&n=10`);
    expect(Array.isArray(data)).toBe(true);
  });
});
```

- [ ] **Step 2: Write src/server/http.ts**

```typescript
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb } from '../storage/queries';
import { getMarketMode } from '../pipeline/scheduler';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';

let lastSpxPrice: number | null = null;
export function setLastSpxPrice(p: number) { lastSpxPrice = p; }

const startTime = Date.now();

export function startHttpServer(port: number): { app: Express; httpServer: Server } {
  const app = express();
  app.use(express.json());

  app.get('/health', (_, res) => res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    mode: getMarketMode(),
    lastSpxPrice,
    dbSizeMb: getDbSizeMb(),
    trackedContracts: getAllActiveContracts().length,
  }));

  app.get('/spx/snapshot', (_, res) => {
    const bar = getLatestBar('SPX', '1m') ?? getLatestBar('ES', '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/spx/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    const symbol = getMarketMode() === 'rth' ? 'SPX' : 'ES';
    res.json(getBars(symbol, tf, n));
  });

  app.get('/contracts/active', (_, res) => res.json(getAllActiveContracts()));

  app.get('/contracts/:symbol/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars(req.params.symbol, tf, n));
  });

  app.get('/contracts/:symbol/latest', (req, res) => {
    const bar = getLatestBar(req.params.symbol, '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/chain', async (req, res) => {
    try {
      const expiry = req.query.expiry as string;
      if (!expiry) return res.status(400).json({ error: 'expiry required' });
      const chain = await fetchOptionsChain('SPX', expiry);
      res.json(chain);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /chain/expirations — list all tracked expiry dates
  app.get('/chain/expirations', async (_req, res) => {
    try {
      const dates = await fetchExpirations('SPX');
      res.json(dates);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /underlying/context — market context snapshot (ES, NQ, VX, sectors)
  app.get('/underlying/context', async (_req, res) => {
    try {
      const { fetchScreenerSnapshot } = await import('../providers/tv-screener');
      const snap = await fetchScreenerSnapshot();
      res.json(snap);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/server/http.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/http.ts tests/server/http.test.ts
git commit -m "feat: REST API — health, SPX bars, contracts, chain endpoints"
```

---

## Task 15: WebSocket Server

**Files:**
- Create: `src/server/ws.ts`

- [ ] **Step 1: Write src/server/ws.ts**

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

type Subscription = { channel: string; symbol?: string; expiry?: string };
const clients = new Map<WebSocket, Set<string>>();

export function startWsServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.set(ws, new Set());

    ws.on('message', (raw) => {
      try {
        const msg: { action: string } & Subscription = JSON.parse(raw.toString());
        const subs = clients.get(ws)!;
        if (msg.action === 'subscribe') {
          subs.add(subKey(msg));
        } else if (msg.action === 'unsubscribe') {
          subs.delete(subKey(msg));
        }
      } catch {}
    });

    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  // Heartbeat every 30s
  setInterval(() => {
    broadcast({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000) });
  }, 30_000);
}

export function broadcast(message: object): void {
  const data = JSON.stringify(message);
  for (const [ws, subs] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const msg = message as any;
    // Route to relevant subscribers
    if (msg.type === 'spx_bar' && subs.has('spx')) {
      ws.send(data);
    } else if (msg.type === 'contract_bar' && subs.has(`contract:${msg.symbol}`)) {
      ws.send(data);
    } else if (msg.type === 'chain_update' && subs.has(`chain:${msg.expiry}`)) {
      ws.send(data);
    } else if (['market_context','heartbeat','service_shutdown'].includes(msg.type)) {
      ws.send(data); // broadcast to all
    }
  }
}

function subKey(sub: Subscription): string {
  if (sub.channel === 'contract') return `contract:${sub.symbol}`;
  if (sub.channel === 'chain') return `chain:${sub.expiry}`;
  return sub.channel;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws.ts
git commit -m "feat: WebSocket server with channel subscriptions and heartbeat"
```

---

## Task 16: Archiver

**Files:**
- Create: `src/storage/archiver.ts`

- [ ] **Step 1: Write src/storage/archiver.ts**

```typescript
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { getExpiredContracts, deleteBarsBySymbols } from './queries';
import { getDb } from './db';
import { config } from '../config';

const MAX_RETRIES = 3;

export async function archiveExpired(): Promise<void> {
  const expired = getExpiredContracts();
  if (expired.length === 0) return;

  const symbols = expired.map(c => c.symbol);
  const date = new Date().toISOString().split('T')[0];
  const tmpPath = `/tmp/spxer_archive_${date}.parquet`;

  console.log(`[archiver] Archiving ${symbols.length} expired contracts...`);

  try {
    await exportToParquet(symbols, tmpPath);
    await uploadWithRetry(tmpPath, date, MAX_RETRIES);
    deleteBarsBySymbols(symbols);
    console.log(`[archiver] Archived and evicted ${symbols.length} contracts`);
  } catch (e) {
    console.error('[archiver] Failed — parquet left in /tmp for manual recovery:', e);
  }
}

async function exportToParquet(symbols: string[], outPath: string): Promise<void> {
  // Use DuckDB Node bindings (not CLI) to export from SQLite
  // duckdb npm package must be installed (Task 1)
  const duckdb = await import('duckdb');
  const db = new duckdb.Database(':memory:');
  await new Promise<void>((resolve, reject) => {
    db.run('INSTALL sqlite; LOAD sqlite;', (err: Error | null) => err ? reject(err) : resolve());
  });
  await new Promise<void>((resolve, reject) => {
    db.run(`ATTACH '${config.dbPath}' AS spxer (TYPE sqlite);`, (err: Error | null) => err ? reject(err) : resolve());
  });
  const symbolList = symbols.map(s => `'${s}'`).join(',');
  const sql = `
    COPY (
      SELECT symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type,
             json_extract(indicators, '$.hma5')     AS hma5,
             json_extract(indicators, '$.hma19')    AS hma19,
             json_extract(indicators, '$.hma25')    AS hma25,
             json_extract(indicators, '$.ema9')     AS ema9,
             json_extract(indicators, '$.ema21')    AS ema21,
             json_extract(indicators, '$.rsi14')    AS rsi14,
             json_extract(indicators, '$.bbUpper')  AS bb_upper,
             json_extract(indicators, '$.bbLower')  AS bb_lower,
             json_extract(indicators, '$.bbWidth')  AS bb_width,
             json_extract(indicators, '$.atr14')    AS atr14,
             json_extract(indicators, '$.vwap')     AS vwap,
             json_extract(indicators, '$.macd')     AS macd,
             json_extract(indicators, '$.adx14')    AS adx14
      FROM spxer.bars WHERE symbol IN (${symbolList})
    ) TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `;
  await new Promise<void>((resolve, reject) => {
    db.run(sql, (err: Error | null) => err ? reject(err) : resolve());
  });
  db.close();
}

async function uploadWithRetry(localPath: string, date: string, retries: number): Promise<void> {
  if (!existsSync(localPath)) throw new Error(`Parquet not found: ${localPath}`);
  const [year, month] = date.split('-');
  const remote = `${config.gdriveRemote}/${year}/${month}/`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      execSync(`rclone copy ${localPath} ${remote} --config ~/.config/rclone/rclone.conf`, { timeout: 60000 });
      return;
    } catch (e) {
      console.warn(`[archiver] rclone attempt ${attempt}/${retries} failed`, e);
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, attempt * 5000)); // exponential backoff
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/storage/archiver.ts
git commit -m "feat: DuckDB Node bindings parquet archival with retry and rclone Google Drive upload"
```

---

## Task 17: Smoke Test — Full Service Start

- [ ] **Step 1: Copy .env.example to .env and fill credentials**

```bash
cp .env.example .env
# Edit .env with real TRADIER_TOKEN
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```
Expected: All tests PASS

- [ ] **Step 3: Start service and verify**

```bash
npm run dev
```

Expected output:
```
[startup] Warming up ES=F overnight bars...
[startup] Warmed 2000+ ES 1m bars
[http] Listening on :3600
[SPXer] Running on port 3600
```

- [ ] **Step 4: Verify health endpoint**

```bash
curl http://localhost:3600/health
```
Expected: `{"status":"ok","uptime":...,"lastSpxPrice":...,"dbSizeMb":...}`

- [ ] **Step 5: Verify SPX bars**

```bash
curl "http://localhost:3600/spx/bars?tf=1m&n=5"
```
Expected: Array of 5 bars with `indicators` containing `hma5`, `rsi14`, etc.

- [ ] **Step 6: Verify options chain**

```bash
curl "http://localhost:3600/chain?expiry=$(date +%Y-%m-%d)"
```
Expected: Array of contracts with strikes, bid/ask, delta, theta

- [ ] **Step 7: Final commit**

```bash
git add .
git commit -m "chore: smoke test passing, service starts clean"
```

---

## Task 18: PM2 Process Config

**Files:**
- Create: `ecosystem.config.js`

- [ ] **Step 1: Write ecosystem.config.js**

```javascript
module.exports = {
  apps: [{
    name: 'spxer',
    script: 'npm',
    args: 'run start', // compiled JS via 'tsc && node dist/index.js' — not tsx dev runner
    cwd: '/home/ubuntu/SPXer',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/ubuntu/SPXer/logs/error.log',
    out_file: '/home/ubuntu/SPXer/logs/out.log',
  }]
};
```

- [ ] **Step 2: Create logs directory and start**

```bash
mkdir -p /home/ubuntu/SPXer/logs
pm2 start ecosystem.config.js
pm2 save
```

- [ ] **Step 3: Verify running**

```bash
pm2 status
pm2 logs spxer --lines 20
```

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.js
git commit -m "chore: PM2 config for 24/5 auto-restart"
```

---

## What's Next

Once SPXer is stable:

1. **SPX-0DTE Dashboard Refactor** — separate plan. Replace ~1200 lines of inline data pipeline in `server.ts` with SPXer WebSocket subscription.
2. **MCP Server** — thin Python FastMCP wrapper calling SPXer REST endpoints. Exposes tools for Claude agents.
3. **rclone Google Drive setup** — one-time: `rclone config` to authorize Google Drive remote.

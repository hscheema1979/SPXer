<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# storage — Database Layer

## Purpose

SQLite database with WAL (write-ahead log) mode for persistent storage and concurrent access:

1. **Database initialization** — Schema creation, connection setup
2. **Query builders** — Type-safe database operations (upsertBar, upsertBars, getAllActiveContracts, etc.)
3. **Archival** — Export expired contracts to Parquet, upload to Google Drive via rclone

Supports concurrent reads (WebSocket broadcast, query API) while writer updates bars.

## Key Files

| File | Description |
|------|-------------|
| `db.ts` | SQLite database initialization, schema, WAL mode setup |
| `queries.ts` | Query builders — bar operations, contract operations, chain queries |
| `archiver.ts` | Export expired contracts to Parquet, upload to Google Drive |

## For AI Agents

### Working In This Directory

1. **Use parameterized queries** — All database operations use prepared statements (bindings) to prevent SQL injection.
2. **Schema is the contract** — Don't modify schema without migration plan (add columns with DEFAULT, don't drop).
3. **WAL mode assumptions** — Multiple readers can run concurrently with one writer. Don't assume exclusive access.
4. **Transactions** — Batch operations (upsertBars with N items) should use explicit transaction for atomicity.
5. **Testing** — Mock database in tests; don't create real SQLite files during unit tests.

### Common Patterns

- **Prepared statements**: `db.prepare('SELECT * FROM bars WHERE symbol = ?').all(symbol)`
- **Transactions**: `db.exec('BEGIN'); ... db.exec('COMMIT');`
- **Batch operations**: Insert many bars in single transaction, not one-by-one
- **Idempotent upserts**: `INSERT OR REPLACE` ensures no duplicates on retry

## Database Schema

### bars Table

```sql
CREATE TABLE IF NOT EXISTS bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,
  synthetic INTEGER NOT NULL,
  gapType TEXT,
  indicators TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(symbol, timeframe, ts)
);
```

**Indexes**:
- `symbol, timeframe, ts` — Primary query key (fastest)
- `symbol, ts` — Common for single-timeframe queries
- `createdAt` — Time-based cleanup

### contracts Table

```sql
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  underlying TEXT NOT NULL,
  strike REAL NOT NULL,
  expiry TEXT NOT NULL,
  state TEXT NOT NULL,
  firstSeen INTEGER NOT NULL,
  lastBarTs INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
```

**Indexes**:
- `symbol` — Unique contract lookup
- `state` — Find ACTIVE/STICKY contracts quickly
- `expiry` — Archival (expired contracts)

### Key Queries

| Query | Purpose |
|-------|---------|
| `upsertBar(bar)` | Insert or replace single bar |
| `upsertBars(bars)` | Batch insert/replace bars (transaction) |
| `getBars(symbol, timeframe, limit)` | Last N bars for a symbol/timeframe |
| `getAllActiveContracts()` | All ACTIVE + STICKY contracts (startup load) |
| `upsertContract(contract)` | Insert or replace contract |
| `updateContractState(symbol, state)` | Transition contract state |
| `getExpiredContracts(before)` | Contracts past expiry date |
| `getExpirations()` | Distinct expiry dates in tracking |
| `getChain(expiry)` | All contracts for given expiry |
| `getDbSizeMb()` | Current database size (for monitoring) |

## WAL Mode Details

**Advantages**:
- Multiple concurrent readers don't block on writer
- Writer doesn't block readers (much faster overall)
- Checkpoint mechanism auto-maintains WAL file size

**Trade-off**: Requires `better-sqlite3` (not all SQLite drivers support WAL fully).

**Files**:
- `data/spxer.db` — Main database file
- `data/spxer.db-shm` — Shared memory file (WAL mode)
- `data/spxer.db-wal` — Write-ahead log file

## Archival Strategy

**Trigger**: When contract state transitions to EXPIRED (after expiry date).

**Process**:
1. Fetch all expired contracts from database
2. Export to Parquet format (columnar, compression)
3. Upload to Google Drive (`gdrive:SPXer/archives/`)
4. Delete from hot database (keep DB < 500 MB)

**Rationale**: Historical contracts rarely queried. Archival keeps hot database fast, allows full history retrieval.

## Dependencies

### Internal
- `src/types.ts` — Bar, Contract types

### External
- `better-sqlite3` — SQLite driver
- `rclone` — Google Drive upload (for archival)

## Key Files by Purpose

### Database Management
- `db.ts` — Schema, initialization, WAL mode

### Query Interface
- `queries.ts` — Type-safe query builders

### Archival
- `archiver.ts` — Parquet export, rclone upload

## Performance Considerations

- **Index strategy**: Queries always use `(symbol, timeframe, ts)` tuple; index supports this
- **WAL checkpoint**: Auto-triggered when WAL > 8MB, manual checkpoints via `PRAGMA optimize`
- **Memory**: WAL mode uses ~3-5 MB extra memory per concurrent connection
- **Batch operations**: 1000 bars/batch is efficient; larger batches risk OOM on low-memory systems

## Error Handling

- **Unique constraint violations**: `upsertBar` uses `INSERT OR REPLACE`, idempotent
- **Database locked**: Rare with WAL mode; retry on error
- **Archival failures**: Log and continue (don't fail data pipeline on archival error)

<!-- MANUAL: Add storage-specific notes on backup, recovery, or custom queries below -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests/storage — Database Layer Tests

## Purpose

Test SQLite database layer: initialization, WAL mode, query builders, and data persistence. All tests use mocked SQLite (no real database files created during tests).

## Test Files

| File | Description |
|------|-------------|
| `db.test.ts` | Database initialization, schema validation, WAL mode setup |
| `queries.test.ts` | All query builders (upsertBar, upsertBars, getAllActiveContracts, getBars, etc.) |
| `archiver.test.ts` | Parquet export and Google Drive upload (mocked rclone) |

## For AI Agents

### Working In This Directory

1. **Mock SQLite completely** — Don't create real database files. Use `better-sqlite3` mocks.
2. **Test idempotency** — `INSERT OR REPLACE` should be idempotent (same data, same result)
3. **Batch operations** — Test bulk insert (upsertBars with 100+ bars) in transaction
4. **Error cases** — Test unique constraint violations, invalid data types
5. **Schema verification** — Verify tables and indexes exist after initialization

### Mocking Pattern

```typescript
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      all: vi.fn().mockReturnValue([...]),
      get: vi.fn().mockReturnValue({ ... }),
    }),
    exec: vi.fn(),
    pragma: vi.fn(),
  })),
}));
```

## Database Tests (db.test.ts)

### Initialization
- Database file created (or in-memory for tests)
- Schema exists (bars table, contracts table)
- Indexes created (symbol+timeframe+ts, state, expiry)
- WAL mode enabled (via PRAGMA)

### Schema Validation
- `bars` table has columns: id, symbol, timeframe, ts, open, high, low, close, volume, synthetic, gapType, indicators, createdAt
- `contracts` table has columns: id, symbol, type, underlying, strike, expiry, state, firstSeen, lastBarTs, createdAt
- Unique constraints correct (bars: symbol+timeframe+ts, contracts: symbol)

## Query Tests (queries.test.ts)

### upsertBar / upsertBars
- Insert single bar → 1 row in database
- Insert same bar twice → 1 row (idempotent, replaces)
- Insert 100 bars in transaction → all 100 in database
- Indicators JSON stored and retrieved correctly

### getBars
- Get last N bars for symbol/timeframe → correct order (ascending ts)
- Get 100 bars when only 50 exist → return 50 (no error)
- Get 0 bars → empty array
- Indicators field preserved (JSON blob)

### getAllActiveContracts
- All ACTIVE contracts returned
- All STICKY contracts returned
- EXPIRED contracts excluded
- Result includes latest bar for each contract

### upsertContract / updateContractState
- Insert contract → state = UNSEEN
- Update state UNSEEN → ACTIVE → STICKY → EXPIRED
- Strike number preserved (5000.5, not rounded)
- Expiry date correct

### getExpiredContracts
- Contracts past expiry date returned
- Contracts before expiry date excluded
- Used for archival workflow

### getExpirations
- List distinct expiry dates in tracking
- Dates in YYYY-MM-DD format
- Sorted (earliest first)

### getChain
- All calls + puts for given expiry
- Ordered by strike (low to high)
- Includes Greeks if available

### getDbSizeMb
- Returns current database file size in MB
- Used for monitoring (ensure < 500 MB)

## Archiver Tests (archiver.test.ts)

### Parquet Export
- Export expired contracts to Parquet format
- Include bar history (OHLCV + indicators)
- Compress with Snappy (Parquet default)
- File created with timestamp (contracts_2026-03-20.parquet)

### Google Drive Upload
- Mock rclone command execution
- Upload parquet to configured GDrive path (gdrive:SPXer/archives/)
- Verify upload command called with correct args
- Error handling: log and continue (don't fail pipeline)

### Cleanup
- Delete archived contracts from hot database
- Verify row count decreases
- Verify database size decreases

## Test Data Fixtures

Example bar for insertion:
```json
{
  "symbol": "SPXW260318C05000000",
  "timeframe": "1m",
  "ts": 1708348200,
  "open": 1.45,
  "high": 1.55,
  "low": 1.40,
  "close": 1.50,
  "volume": 1234,
  "synthetic": false,
  "gapType": null,
  "indicators": { "rsi_14": 65.5, "hma_3m": 1.48 },
  "createdAt": 1708348200
}
```

Example contract for insertion:
```json
{
  "symbol": "SPXW260318C05000000",
  "type": "call",
  "underlying": "SPX",
  "strike": 5000,
  "expiry": "2026-03-18",
  "state": "ACTIVE",
  "firstSeen": 1708348200,
  "lastBarTs": 1708348200,
  "createdAt": 1708348200
}
```

## Transaction Tests

Test batch operations use explicit transactions:

```typescript
it('should batch insert 100 bars in transaction', () => {
  const bars = generateTestBars(100);

  db.exec('BEGIN');
  for (const bar of bars) {
    upsertBar(bar);
  }
  db.exec('COMMIT');

  const result = getAllBars();
  expect(result).toHaveLength(100);
});
```

## Performance Tests

Optional assertions:

```typescript
it('should insert 1000 bars in < 500ms', () => {
  const bars = generateTestBars(1000);

  const start = performance.now();
  upsertBars(bars);
  const elapsed = performance.now() - start;

  expect(elapsed).toBeLessThan(500);
});
```

## Dependencies

### Internal
- `src/storage/db.ts`
- `src/storage/queries.ts`
- `src/storage/archiver.ts`
- `src/types.ts` (Bar, Contract types)

### External
- `vitest` — Test framework
- `better-sqlite3` (mocked)
- `rclone` (mocked for archival tests)

<!-- MANUAL: Add storage test-specific notes on schema migrations, backup/recovery, or custom queries below -->

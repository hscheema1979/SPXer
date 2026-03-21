<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests/server — HTTP API Tests

## Purpose

Test Express HTTP API endpoints and WebSocket server. Verify correct response format, status codes, and error handling.

## Test Files

| File | Description |
|------|-------------|
| `http.test.ts` | All REST API endpoints (GET /health, /spx/snapshot, /spx/bars, /contracts/*, /chain) |

## Test Structure

Each endpoint tested with:
1. Happy path (valid request → 200 with correct data)
2. Error cases (invalid params → 400 or 404)
3. Response format (verify schema)

## Endpoint Tests

### GET /health

**Happy path**:
- Status 200
- Response includes: success, data (status, uptime, spx_price, db_size_mb, mode)

**Edge cases**:
- Service just started (uptime < 1s) → no error
- No bars in database yet → spx_price null

### GET /spx/snapshot

**Happy path**:
- Status 200
- Response: latest SPX 1m bar with all indicators
- Includes: symbol, timeframe, ts, OHLCV, indicators (rsi_14, hma_3m, ema_9, etc.)

**Error case**:
- Database empty → 404 with "No SPX data available"

### GET /spx/bars?tf=1m&n=100

**Happy path**:
- Status 200
- Response: array of last 100 1m bars for SPX
- Bars in ascending timestamp order

**Query param validation**:
- Missing `tf` → use default '1m'
- Invalid `tf` → 400 error
- Missing `n` → use default 50
- `n` > 1000 → cap at 1000 (prevent huge responses)
- `n` < 1 → 400 error

### GET /contracts/active

**Happy path**:
- Status 200
- Response: array of ACTIVE + STICKY contracts
- Each contract includes: symbol, strike, state, latest bar with indicators

**Edge case**:
- No contracts tracked → empty array (not error)

### GET /contracts/:symbol/bars?tf=1m&n=100

**Happy path**:
- Status 200
- Response: bars for specific contract symbol
- Same validation as `/spx/bars`

**Error cases**:
- Contract symbol not found → 404
- Invalid symbol format → 400

### GET /chain?expiry=YYYY-MM-DD

**Happy path**:
- Status 200
- Response: full options chain for specified expiry
- Includes all calls and puts with bid/ask, Greeks, volume

**Validation**:
- Invalid date format → 400
- Date not in tracking → empty array (not error)

### GET /chain/expirations

**Happy path**:
- Status 200
- Response: array of available expiration dates (YYYY-MM-DD format)

**Edge case**:
- No contracts tracked → empty array

## Error Response Format

All errors return:
```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

## For AI Agents

### Working In This Directory

1. **Mock database** — Don't create real SQLite. Mock `storage/queries.ts` functions.
2. **Test response shape** — Verify JSON structure, not just status code.
3. **Timestamp format** — Verify timestamps in Unix seconds (not milliseconds or ISO string).
4. **Numeric precision** — OHLCV prices should be floats with 2 decimal places (cents).
5. **Array order** — Verify bars returned in ascending timestamp order (oldest first).

### Mocking Pattern

```typescript
vi.mock('../storage/queries', () => ({
  getAllActiveContracts: vi.fn().mockReturnValue([...]),
  getBars: vi.fn().mockReturnValue([...]),
  getExpirations: vi.fn().mockReturnValue(['2026-03-21', ...]),
}));
```

### Testing Pattern

```typescript
it('GET /spx/snapshot should return latest SPX bar', async () => {
  const response = await request(app).get('/spx/snapshot');

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    success: true,
    data: {
      symbol: 'SPX',
      timeframe: '1m',
      ts: expect.any(Number),
      close: expect.any(Number),
      indicators: expect.any(Object),
    },
  });
});
```

## Response Format Validation

### Bar Response
```json
{
  "symbol": "SPX",
  "timeframe": "1m",
  "ts": 1708348200,
  "open": 4947.5,
  "high": 4950.2,
  "low": 4945.0,
  "close": 4948.5,
  "volume": 1234567,
  "synthetic": false,
  "gapType": null,
  "indicators": {
    "hma_3m": 4948.2,
    "rsi_14": 65.5,
    "ema_9": 4949.1,
    ...
  }
}
```

### Contract Response
```json
{
  "symbol": "SPXW260318C05000000",
  "strike": 5000,
  "type": "call",
  "state": "ACTIVE",
  "expiry": "2026-03-18",
  "latestBar": { ... }  // Bar object above
}
```

## Dependencies

### Internal
- `src/server/http.ts` (Express app)
- `src/storage/queries.ts` (mocked)

### External
- `vitest` — Test framework
- `supertest` — HTTP testing (optional, can use fetch or axios)

## Performance Tests

Optional assertions:

```typescript
it('should respond in < 100ms', async () => {
  const start = performance.now();
  await request(app).get('/spx/snapshot');
  const elapsed = performance.now() - start;

  expect(elapsed).toBeLessThan(100);
});
```

<!-- MANUAL: Add HTTP API test-specific notes on new endpoints, authentication, or rate limiting below -->

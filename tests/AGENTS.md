<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests — Test Suite

## Purpose

Comprehensive test coverage across the entire system:

- **Unit tests**: Pure functions (indicators, bar builders, formatters)
- **Integration tests**: API endpoints, database operations, provider integration
- **Pipeline tests**: Bar building, indicator computation, aggregation

Tests use Vitest with globals enabled, `node` environment, and 10s timeout.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `pipeline/` | Bar builder, indicator engine, aggregator, contract tracker, scheduler tests — see `pipeline/AGENTS.md` |
| `providers/` | Tradier, Yahoo, TradingView screener provider mocks and tests — see `providers/AGENTS.md` |
| `server/` | HTTP API endpoint tests — see `server/AGENTS.md` |
| `storage/` | Database layer tests (mocked SQLite) — see `storage/AGENTS.md` |

## Root Test Files

| File | Description |
|------|-------------|
| `smoke.test.ts` | Integration smoke test — full pipeline with mock data |
| `types.test.ts` | Type definition tests |

## For AI Agents

### Working In This Directory

1. **Never call real APIs** — All tests mock providers. Use fixtures with known data.
2. **Isolation**: Each test independent; no shared state between tests.
3. **Mock database**: Tests don't create real SQLite files. Use in-memory mocks.
4. **Deterministic**: Same inputs → same outputs, every time. No randomness.
5. **Fast**: Unit tests < 30s, integration tests < 2 min, full suite < 10 min.

### Test Structure

```typescript
describe('Module Name', () => {
  describe('Function Name', () => {
    it('should do X when given Y', () => {
      const input = { ... };
      const result = functionUnderTest(input);
      expect(result).toEqual(expected);
    });
  });
});
```

### Testing Patterns

- **Fixtures**: Use realistic but fixed test data (e.g., real SPX bar from a known date)
- **Mocks**: Mock external APIs (Tradier, Yahoo) with canned responses
- **Assertions**: Test output shape, edge cases, error conditions
- **Coverage**: Aim for > 80% code coverage per module

## Configuration

**vitest.config.ts**:
```typescript
export default defineConfig({
  test: {
    globals: true,        // describe/it/expect available without imports
    environment: 'node',  // Node.js environment (not jsdom)
    timeout: 10000,       // 10s timeout per test
    coverage: {
      provider: 'v8',
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    },
  },
});
```

## Running Tests

```bash
npm run test              # Run all tests (vitest run)
npm run test:watch       # Watch mode
npx vitest tests/pipeline --run    # Single directory
npx vitest tests/pipeline/indicator-engine.test.ts --run  # Single file
```

## Coverage Targets

| Layer | Target | Current |
|-------|--------|---------|
| Unit tests | > 80% | ~70% |
| Integration tests | > 60% | ~50% |
| E2E (replay scripts) | Critical paths | 100% |
| Security tests | OWASP Top 10 | Full |

## Key Test Files by Purpose

### Pipeline Tests
- `pipeline/bar-builder.test.ts` — Gap interpolation, synthetic bar marking
- `pipeline/indicator-engine.test.ts` — Incremental indicator computation vs batch
- `pipeline/aggregator.test.ts` — Higher timeframe construction from 1m bars
- `pipeline/contract-tracker.test.ts` — State transitions, sticky band model
- `pipeline/scheduler.test.ts` — Market mode switching (ES vs SPX)
- `pipeline/indicators/tier1.test.ts` — HMA, EMA, RSI, Bollinger, ATR, VWAP
- `pipeline/indicators/tier2.test.ts` — EMA 50/200, SMA, Stochastic, CCI, MACD, ADX

### Provider Tests
- `providers/tradier.test.ts` — Batch quotes, options chain, timesales (mocked)
- `providers/yahoo.test.ts` — ES futures bars (mocked)
- `providers/tv-screener.test.ts` — Market snapshot (mocked)

### Server Tests
- `server/http.test.ts` — All REST endpoints return correct data

### Storage Tests
- `storage/db.test.ts` — Database initialization, WAL mode
- `storage/queries.test.ts` — All query builders work correctly
- `storage/archiver.test.ts` — Parquet export (mocked)

## Test Data Fixtures

Example fixture (realistic SPX bar from a known date):

```typescript
const testBar: Bar = {
  symbol: 'SPX',
  timeframe: '1m',
  ts: 1708348200,  // 2024-02-19 09:30 ET
  open: 4947.5,
  high: 4950.2,
  low: 4945.0,
  close: 4949.1,
  volume: 1234567,
  synthetic: false,
  gapType: null,
  indicators: { rsi_14: 65.2, hma_3m: 4948.5, ema_9: 4950.0 },
};
```

## Mocking Patterns

### Mock Tradier API

```typescript
vi.mock('../providers/tradier', () => ({
  fetchBatchQuotes: vi.fn().mockResolvedValue([
    { symbol: 'SPXW260318C05000000', bid: 1.5, ask: 1.6, ... }
  ]),
}));
```

### Mock Database

```typescript
vi.mock('../storage/queries', () => ({
  upsertBar: vi.fn(),
  getBars: vi.fn().mockReturnValue([testBar, ...]),
  getAllActiveContracts: vi.fn().mockReturnValue([...]),
}));
```

## Dependencies

### Internal
- All modules under `src/` being tested

### External
- `vitest` — Test runner
- `@vitest/ui` — UI dashboard (optional)

## Performance Targets

- **Unit test suite**: < 30 seconds
- **Integration test suite**: < 2 minutes
- **Full suite (unit + integration)**: < 10 minutes
- **Single test**: < 100ms (most tests much faster)

## Common Issues & Troubleshooting

| Issue | Solution |
|-------|----------|
| Test timeout | Increase timeout or mock async calls |
| Mock not working | Check vi.mock() called before imports |
| Shared state between tests | Use beforeEach() to reset state |
| Flaky tests | Avoid real API calls, mock time if needed |

<!-- MANUAL: Add test-specific notes on new test data, fixtures, or challenging test scenarios below -->

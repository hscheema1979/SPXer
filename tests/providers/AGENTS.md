<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# tests/providers — Data Provider Tests

## Purpose

Test data provider integration with mocked API responses. Providers fetch raw OHLCV and market data; tests verify correct parsing and error handling.

## Test Files

| File | Description |
|------|-------------|
| `tradier.test.ts` | Tradier API client — batch quotes, options chain, timesales (all mocked) |
| `yahoo.test.ts` | Yahoo Finance client — ES futures bars (mocked) |
| `tv-screener.test.ts` | TradingView screener client — market snapshot (mocked) |

## For AI Agents

### Working In This Directory

1. **Never call real APIs** — All tests mock HTTP responses. No real API calls.
2. **Use canned responses** — Mock data should be realistic but fixed (same inputs → same outputs every run)
3. **Test parsing** — Verify API response → OHLCVRaw conversion is correct
4. **Test error cases** — API down, invalid response, timeout, empty data
5. **Idempotent tests** — Running test suite 10× should give same results

### Mocking Pattern

```typescript
vi.mock('axios', () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      data: {
        quotes: [
          { symbol: 'SPXW260318C05000000', bid: 1.5, ask: 1.6, last: 1.55 },
        ]
      }
    }),
  },
}));
```

## Tradier Tests

### Batch Quotes
- Request: 50 option symbols → Response: 50 quotes with bid/ask/last
- Verify mid-price calculation: (bid + ask) / 2
- Error case: API returns 200 but empty quotes
- Error case: API down (500 error) → provider returns empty array

### Options Chain
- Request: symbol + expiry → Response: all calls and puts for that expiry
- Verify call/put parsing (C vs P in symbol)
- Verify strike parsing from symbol (8-digit zero-padded)
- Verify Greeks present (delta, gamma, theta, vega)

### Timesales (1m bars)
- Request: symbol (SPX or option) → Response: array of trades
- Verify conversion to OHLCVRaw (ts, open, high, low, close, volume)
- Verify timestamp parsing (Tradier returns ISO, convert to Unix seconds ET)
- Empty response → provider returns empty array

### Symbol Format
- Tradier canonical: `SPXW260318C05000000`
- Parsing: Extract expiry (260318), type (C/P), strike (05000000 / 1000 = 5000)
- Verify no off-by-one errors in parsing

## Yahoo Finance Tests

### ES Futures Bars
- Request: ES=F → Response: daily or 1m bars
- Verify column mapping (Date, Open, High, Low, Close, Volume)
- Verify timestamp conversion to Unix seconds ET
- Verify volume is integer (not NaN)
- Error case: symbol doesn't exist → empty array

## TradingView Screener Tests

### Market Snapshot
- Request: (none, screener API) → Response: market overview
- Verify response includes RSI, MACD, EMA 50/200, volatility
- Verify numeric values are in expected ranges (RSI 0-100, volatility > 0)
- Error case: API unreachable → graceful empty snapshot

## Test Data Fixtures

Example mocked Tradier batch quotes response:

```json
{
  "quotes": [
    {
      "symbol": "SPXW260318C05000000",
      "bid": 1.45,
      "ask": 1.55,
      "last": 1.50,
      "volume": 4321,
      "open_interest": 1000,
      "delta": 0.65,
      "gamma": 0.008,
      "theta": -0.25,
      "vega": 2.1
    },
    ...
  ]
}
```

Example mocked Yahoo ES bars:

```json
{
  "chart": {
    "result": [
      {
        "timestamp": [1708348200, 1708348260, ...],
        "open": [4947.5, 4948.0, ...],
        "high": [4950.0, 4951.2, ...],
        "low": [4945.0, 4947.5, ...],
        "close": [4948.5, 4950.1, ...],
        "volume": [123456, 234567, ...]
      }
    ]
  }
}
```

## Error Handling Tests

| Error Case | Expected Behavior |
|-------------|------------------|
| API returns 500 error | Provider catches, logs, returns empty array |
| Response is invalid JSON | Provider catches, logs, returns empty array |
| Response is correct JSON but wrong schema | Provider validates and returns empty array |
| Network timeout | Provider catches, logs, returns empty array |
| Empty response (200 OK, but 0 quotes) | Provider returns empty array (not error) |

## Dependencies

### Internal
- Provider modules under `src/providers/`
- `src/types.ts` (OHLCVRaw type)

### External
- `vitest` — Test framework
- `vi.mock()` for HTTP mocking

<!-- MANUAL: Add provider test-specific notes on API changes, new endpoints, or edge cases below -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# providers — Data Source Integration

## Purpose

Three data providers fetch raw OHLCV and market data from external APIs:

1. **Tradier** — Real-time options quotes, SPX timesales, batch quote endpoint
2. **Yahoo Finance** — ES futures data overnight (when SPX not trading)
3. **TradingView Screener** — Additional market snapshot data (rsi, macd, ema, etc.)

All providers return raw `OHLCVRaw` arrays. Pipeline stages (bar-builder, indicator-engine) convert to processed bars. Providers handle API errors, rate limiting, and data validation.

## Key Files

| File | Description |
|------|-------------|
| `tradier.ts` | Tradier API client — quotes, timesales, batch, expirations, account data |
| `yahoo.ts` | Yahoo Finance client — ES futures bars via yfinance API |
| `tv-screener.ts` | TradingView screener snapshot — market overview, technical data |

## For AI Agents

### Working In This Directory

1. **API contract**: Each provider exports functions returning `OHLCVRaw[]` or snapshot objects. Don't change return types without updating callers.
2. **Error handling**: Catch API errors, log with context, return empty arrays on failure (let main loop retry).
3. **Rate limiting**: Tradier batch quotes support up to 50 symbols per call. Respect API limits (avoid hammering endpoints).
4. **Testing**: Mock responses in `tests/providers/` using fixed data. Don't call real APIs in tests.
5. **Configuration**: API keys, base URLs loaded from `src/config.ts` or environment variables.

### Common Patterns

- Return empty arrays on error (main loop handles retry logic)
- Parse API response schema and extract relevant OHLCV fields
- Validate data (prices > 0, volumes >= 0) before returning
- Log provider state (up/down, last successful call time)

## Dependencies

### Internal
- `src/types.ts` — OHLCVRaw, Bar types
- `src/config.ts` — API keys, base URLs, poll intervals

### External
- `axios` — HTTP client
- Environment variables — TRADIER_TOKEN, TRADIER_ACCOUNT_ID, etc.

## Tradier Provider Details

### Functions

| Function | Purpose |
|----------|---------|
| `fetchSpxQuote()` | Latest SPX price from Tradier |
| `fetchSpxTimesales(symbol, opts?)` | 1-minute bars for SPX or option contract |
| `fetchBatchQuotes(symbols)` | Batch quote endpoint (up to 50 symbols) |
| `fetchOptionsChain(symbol, expiry)` | Full option chain for a given expiry |
| `fetchExpirations(symbol)` | List available expiration dates |
| `fetchTimesales(symbol)` | Legacy call for option contract timesales |
| `fetchAccountData()` | Account info (balance, buying power) |

### Symbol Format

Tradier uses canonical format: `SPXW260318C05000000`
- `SPXW` = SPX Weekly
- `260318` = YYMMDD expiration
- `C` = Call (or `P` for put)
- `05000000` = 8-digit zero-padded strike × 1000 (e.g., 5000000 = $5000)

### Batch Quotes

Batch endpoint accepts up to 50 symbols per request. Much faster than individual calls.

## Yahoo Provider Details

### ES Futures

ES (Emini S&P 500) trades 24 hours via Globex (CME). Pulled overnight when SPX is closed.

```
Symbol: ES=F
Columns: Date, Open, High, Low, Close, Volume
Parsed into: OHLCVRaw with timestamp converted to ET
```

## TradingView Screener Details

Returns market snapshot:
- Current price
- RSI value
- MACD histogram
- EMA 50, EMA 200
- Volatility (D)
- Other technical metrics

Used for pre-market analysis and regime classification.

## Error Handling Strategy

1. **API down**: Log error, return empty array, main loop retries at next poll cycle
2. **Rate limit**: Add exponential backoff (optional — currently just retry next cycle)
3. **Invalid response**: Log warning with response snippet, return empty array
4. **Network timeout**: Catch and log, return empty array

Main loop is resilient: if any provider fails, others continue. Missed bars are backfilled on next provider success.

<!-- MANUAL: Add any provider-specific notes or API changes below -->

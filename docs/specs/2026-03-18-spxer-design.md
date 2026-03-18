# SPXer — SPX Data Service Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Location:** `/home/ubuntu/SPXer/`

---

## 1. Overview

SPXer is a standalone, always-on data service for SPX index and SPXW options contracts. It runs 24/5, builds and maintains bar histories with a full indicator battery, and serves enriched data to any consumer — dashboards, MCP servers, trading agents, or backtesters. It provides data only; signal generation is the responsibility of consumers.

---

## 2. Goals

- Run continuously 24/5 without manual intervention
- Maintain warm, indicator-rich bar histories for SPX and all tracked options contracts
- Handle missing trade data gracefully via smooth bar interpolation
- Track options contracts using a sticky band model (once in band, tracked until expiry)
- Serve data via REST and WebSocket APIs to any consumer
- Archive expired data to Google Drive in parquet format for backtesting

---

## 3. Non-Goals

- Signal generation (buy/sell/neutral — left to consumers)
- Trade execution
- Portfolio management
- UI / visualisation

---

## 4. Data Sources

| Time Window | Source | Data |
|-------------|--------|------|
| 6PM–9:25AM ET (overnight) | Yahoo Finance `ES=F` | 1m/5m/15m OHLCV bars, 24/5, real volume |
| 9:25AM–9:30AM ET (pre-open) | Yahoo `ES=F` + Tradier SPX bid/ask | Chain pre-load window |
| 9:30AM–4:15PM ET (RTH) | Tradier timesales + Yahoo `^GSPC` | SPX 1min bars, options chain prices |
| Always | TradingView Screener | ES1!, NQ1!, RTY1!, VX1!, SPY, QQQ, sector ETFs (snapshot indicators) |
| Always | Tradier quotes | SPX live bid/ask, VIX, SPY |

**Source switching** is automatic based on `America/New_York` time. No manual intervention required.

---

## 5. Tracked Instruments

### 5.1 Underlying

- **SPX** — primary underlying during RTH (9:30AM–4:15PM ET), stored as symbol `SPX`
- **ES** — overnight proxy (Yahoo Finance `ES=F`), stored as symbol `ES`, separate bar series from `SPX`. Indicators computed independently on each series. At 9:30 AM ET, `SPX` becomes the active underlying; the `ES` series continues updating in background for context. **No price stitching between ES and SPX** — they are two distinct series. Consumers request `SPX` for the primary underlying at all times; SPXer routes to the correct source automatically.
- **VIX** — volatility context, always tracked

### 5.2 Options Contracts (SPXW)

**Expiry coverage:**

| Day | Expirations tracked |
|-----|-------------------|
| Monday–Thursday | 0DTE, 1DTE, 2DTE |
| Friday | 0DTE, 1DTE (Mon), 2DTE (Wed), 3DTE (next Fri) |
| Saturday–Sunday | Maintain existing tracked set, no new chain fetches |

**Strike band:** The band is defined as current live SPX price ± $100, re-evaluated on every polling cycle. As SPX moves, new contracts entering the band are added (UNSEEN → ACTIVE). Contracts that drift outside the band are retained via sticky tracking (ACTIVE → STICKY). The band is never frozen at a fixed price.

SPX strike intervals are $5. ~41 strikes × 2 (calls + puts) × 3–4 expiries = **~246–328 active contracts** on a typical day.

### 5.3 Sticky Tracking Model

```
Contract states:
  UNSEEN    → not yet touched the ±$100 band, not tracked
  ACTIVE    → inside current ±$100 band, fully tracked
  STICKY    → band has shifted away but contract was previously ACTIVE; keep tracking
  EXPIRED   → past expiry datetime; archive and evict from hot storage

Transitions:
  UNSEEN  → ACTIVE   : contract enters ±$100 of current SPX price
  ACTIVE  → STICKY   : SPX moves and contract falls outside ±$100 (do NOT drop)
  STICKY  → ACTIVE   : SPX moves back and contract re-enters ±$100
  ACTIVE|STICKY → EXPIRED : expiry datetime passes (4:15 PM ET on expiry date)
```

**Never drop a contract early.** Once tracked, always tracked until expiry. This preserves indicator continuity through large intraday moves where contracts temporarily go deep OTM but may return.

**Maximum tracked contracts (worst case):** SPX swings ±$150 intraday → sticky set grows to ~60 strikes × 2 × 4 expiries = ~480 contracts. Still manageable (~60MB/day).

---

## 6. Bar Construction

### 6.1 Real Bars

Standard OHLCV bars from data source. Each bar tagged `synthetic: false`.

### 6.2 Synthetic Bar Interpolation

Options contracts frequently go minutes without a trade. When a gap is detected:

```
Gap: last real bar at T1 (price P1), new real bar at T2 (price P2), N bars missing

For each missing bar at T1+k (k = 1..N-1):
  interpolated_price = P1 + (P2 - P1) * (k / N)
  bar = {
    open:      interpolated_price,
    high:      interpolated_price,
    low:       interpolated_price,
    close:     interpolated_price,
    volume:    0,
    synthetic: true,
    gap_start: T1,
    gap_end:   T2
  }
```

**Linear interpolation** is used (not cubic spline) — honest representation, no phantom price levels. Consumers can filter `synthetic: true` bars if they want trade-only data.

Indicators **are computed** on synthetic bars so HMA/RSI/BB remain continuous. Consumers are responsible for deciding how to weight synthetic bars in their own logic.

### 6.3 Gap threshold

Gaps under 1 minute: no interpolation needed (bar arrives late, use as-is).
Gaps 2–60 minutes: interpolate with linear fill.
Gaps over 60 minutes: use last known price for all missing bars (flat line) and flag `gap_type: "stale"`.

---

## 7. Indicator Battery

Computed **incrementally** on every new bar — rolling windows are maintained in memory per symbol, not recomputed from scratch. When a new bar arrives, each indicator appends one step to its existing state. This keeps per-poll CPU constant regardless of bar history depth.

### Tier 1 — Computed on every bar, every tracked instrument (underlying + options contracts)
- HMA: periods 5, 19, 25
- EMA: periods 9, 21
- RSI: period 14
- Bollinger Bands: period 20, 2 std dev (upper, middle, lower, width)
- ATR: period 14 (absolute + as % of price)
- VWAP (cumulative, resets at RTH open)

### Tier 2 — Computed on every bar, underlying (SPX/ES) only
- EMA: periods 50, 200
- SMA: periods 20, 50
- Stochastic: %K 14, %D 3
- CCI: period 20
- Momentum: period 10
- MACD: fast 12, slow 26, signal 9 (MACD line, signal line, histogram)
- ADX: period 14

### Tier 3 — Computed on demand via API (not stored per bar)
- Pivot points: Classic, Fibonacci, Camarilla, Woodie, Demark (derived from daily OHLC)
- Overnight high/low/close summary (from ES session)

**Rationale for tiering:** With up to 480 contracts × ~20 Tier 1 indicators, incremental computation at 60s polling is ~9,600 indicator steps per cycle — fast. Tier 2 on the underlying only adds ~10 steps. Tier 3 is stateless and computed on request.

All Tier 1+2 indicator values stored per bar as a flat JSON blob in the `indicators` column. Null for bars where insufficient history exists (e.g. HMA(25) undefined for first 25 bars).

---

## 8. Storage Architecture

### 8.1 Hot Storage — SQLite (WAL mode)

**Retention:** 7 rolling days of active + sticky contracts.

**Schema:**

**Contract symbol format:** Tradier's canonical format is used as the primary key throughout.
Example: `SPXW260318C05000000` = SPXW + YYMMDD + C/P + 8-digit zero-padded strike (strike × 1000).
`6700.0` strike → `06700000`. A normalization function converts any format to this canonical form on ingestion.

```sql
-- One row per bar per symbol
CREATE TABLE bars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,        -- e.g. 'SPX', 'ES', 'SPXW260318C06700000'
  timeframe   TEXT NOT NULL,        -- '1m', '5m', '15m', '1h'
  ts          INTEGER NOT NULL,     -- Unix timestamp (seconds)
  open        REAL,
  high        REAL,
  low         REAL,
  close       REAL NOT NULL,
  volume      INTEGER DEFAULT 0,
  synthetic   INTEGER DEFAULT 0,    -- 0=real, 1=interpolated
  gap_type    TEXT,                 -- NULL | 'interpolated' | 'stale'
  indicators  TEXT,                 -- JSON blob: all indicator values for this bar
  created_at  INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_bars_symbol_tf_ts ON bars(symbol, timeframe, ts DESC);

-- Contract registry
CREATE TABLE contracts (
  symbol      TEXT PRIMARY KEY,
  type        TEXT NOT NULL,        -- 'call' | 'put' | 'index' | 'etf' | 'future'
  underlying  TEXT,                 -- 'SPX'
  strike      REAL,
  expiry      TEXT,                 -- ISO date 'YYYY-MM-DD'
  state       TEXT NOT NULL,        -- 'ACTIVE' | 'STICKY' | 'EXPIRED' | 'UNSEEN'
  first_seen  INTEGER,
  last_bar_ts INTEGER,
  created_at  INTEGER DEFAULT (unixepoch())
);
```

### 8.2 Daily Archival — Parquet + Google Drive

```
4:15 PM ET daily (or on expiry):
  1. Query all bars for expired contracts from hot DB
  2. Export to parquet: /tmp/spxer_archive_YYYY-MM-DD.parquet
     Columns: symbol, timeframe, ts, open, high, low, close, volume,
               synthetic, gap_type, + all indicator columns (flat, not JSON)
  3. Upload to Google Drive: SPXer/archives/YYYY/MM/spxer_YYYY-MM-DD.parquet
     via rclone (configured once, runs as CLI)
  4. DELETE expired bars from hot SQLite
  5. Log archival: rows archived, file size, upload status
```

**Parquet sizing:** ~360 contracts × 390 bars × 30 columns × 8 bytes ≈ ~33MB/day uncompressed → ~3–5MB compressed parquet. Google Drive storage: ~100MB/month.

### 8.3 Storage Management

- Hot DB target: < 500MB at all times
- Alert (log warning) if hot DB exceeds 400MB
- Emergency eviction: if DB > 500MB, force-archive oldest 2 days immediately
- Sticky contracts older than 7 days: archive even if not expired (deep OTM, stale)

---

## 9. API

### 9.1 REST

```
GET  /health                          Service status, uptime, tracked contract count
GET  /spx/snapshot                    Current SPX price + all indicators (1m latest bar)
GET  /spx/bars?tf=1m&n=100           Last N bars for SPX at given timeframe
GET  /underlying/context              ES1!, NQ1!, VX1!, SPY, QQQ, sectors snapshot
GET  /contracts/active                List all currently ACTIVE + STICKY contracts
GET  /contracts/:symbol/bars?tf=1m&n=100   Bar history for a specific contract
GET  /contracts/:symbol/latest        Latest bar + indicators for a contract
GET  /chain?expiry=2026-03-18&type=both   Full options chain snapshot for an expiry
GET  /chain/expirations               Available tracked expiry dates
```

### 9.2 WebSocket

```
Connect:   ws://localhost:PORT/ws

Subscribe messages (client → server):
  { "action": "subscribe", "channel": "spx" }
  { "action": "subscribe", "channel": "contract", "symbol": "SPXW260318C6700.0" }
  { "action": "subscribe", "channel": "chain", "expiry": "2026-03-18" }
  { "action": "unsubscribe", ... }

Broadcast messages (server → client):
  { "type": "spx_bar",      "data": { bar + indicators } }
  { "type": "contract_bar", "symbol": "...", "data": { bar + indicators } }
  { "type": "chain_update", "expiry": "...", "data": [ contract snapshots ] }
  { "type": "band_shift",   "old_atm": 6700, "new_atm": 6750, "added": [...], "sticky": [...] }
  { "type": "service_status", "data": { uptime, tracked_count, db_size_mb } }
```

---

## 10. Service Architecture

```
SPXer/
├── src/
│   ├── index.ts                  Entry point, starts all services
│   ├── server/
│   │   ├── http.ts               Express REST API
│   │   └── ws.ts                 WebSocket server + subscription manager
│   ├── pipeline/
│   │   ├── scheduler.ts          Time-based source switching (overnight/RTH)
│   │   ├── bar-builder.ts        Bar construction + gap detection + interpolation
│   │   ├── indicator-engine.ts   Full indicator battery computation
│   │   └── contract-tracker.ts   Sticky band model, contract lifecycle
│   ├── providers/
│   │   ├── yahoo.ts              Yahoo Finance ES=F, ^GSPC, ^VIX bars
│   │   ├── tradier.ts            SPX quotes, timesales, options chains
│   │   └── tv-screener.ts        TradingView screener snapshots
│   ├── storage/
│   │   ├── db.ts                 SQLite connection, WAL config
│   │   ├── queries.ts            All DB read/write operations
│   │   └── archiver.ts           Parquet export + rclone Google Drive push
│   └── types.ts                  Shared TypeScript interfaces
├── data/
│   └── spxer.db                  SQLite hot database
├── docs/
│   └── specs/
│       └── 2026-03-18-spxer-design.md
├── package.json
├── tsconfig.json
└── .env                          TRADIER_TOKEN, TRADIER_ACCOUNT_ID, PORT, GDRIVE_REMOTE
```

---

## 11. Consumer Integration

### SPX-0DTE Dashboard (refactor)

`server.ts` (1658 lines total) currently contains inline Tradier/Yahoo data fetching, indicator calculation, bar aggregation, options chain management, and WebSocket broadcasting. After SPXer is running:

- Remove inline data pipeline from `server.ts` (~1200–1400 lines of data logic)
- Replace with SPXer WebSocket subscription (~50 lines)
- Dashboard becomes a thin consumer: receives bars + indicators, renders UI
- Remaining `server.ts`: Express setup, Vite proxy, UI WebSocket relay (~250 lines)

### MCP Server (future)

A thin Python FastMCP wrapper that calls SPXer REST endpoints and exposes them as Claude tools. No data logic in the MCP layer.

### Future Agents

Any process that needs SPX/options data connects to SPXer's REST or WebSocket. Zero duplication of data logic.

---

## 12. Operational Details

### Startup Sequence

1. Initialize SQLite, run migrations
2. Load existing contract registry from DB (resume tracked set)
3. Fetch last 2 days of `ES=F` 1m bars from Yahoo → rebuild bar histories → warm all indicators
4. Aggregate 1m bars into 5m and 15m bars in memory (all higher timeframes derived from 1m)
5. Determine current time: overnight or RTH → activate correct data source
6. Fetch current options chain from Tradier → reconcile with sticky tracked set
7. Start REST + WebSocket servers
8. Begin polling loops

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop all polling loops
2. Flush in-memory bar buffer to SQLite
3. Close all WebSocket connections (send `{"type":"service_shutdown"}` to subscribers)
4. Complete any in-progress archival
5. Close SQLite connection

### Contract Rollover

New expiry dates are checked on every options chain fetch. When a new expiry appears within the DTE window that wasn't previously tracked, its contracts are evaluated against the current ±$100 band and eligible ones transition UNSEEN → ACTIVE. This happens automatically — no scheduled rollover job needed.

On **Friday at 4:15 PM ET**: 0DTE expires → archive. The Monday expiry (3DTE on Friday) is already being tracked. Weekend polling continues at 5-minute intervals for non-options data (ES, VIX) to keep the ES bar series warm.

### Market Holidays

A holiday calendar is embedded in `scheduler.ts` covering NYSE market holidays and early-close days (e.g. day before July 4th closes at 1:00 PM ET). On holidays: RTH mode is not entered, overnight/ES mode continues. On early-close days: RTH archival triggers at the early close time, not 4:15 PM.

### Higher Timeframe Bars (5m, 15m, 1h)

All timeframes above 1m are **aggregated from 1m bars**, not fetched independently. Aggregation rule: OHLCV candles, open = first 1m open, high = max of 1m highs, low = min of 1m lows, close = last 1m close, volume = sum. A bar is only emitted when the period closes (e.g. 5m bar emits at :05, :10, :15...). Synthetic flag propagates: if any constituent 1m bar is synthetic, the higher-timeframe bar is also flagged synthetic.

### Polling Intervals

| Data | Interval | Source |
|------|----------|--------|
| SPX underlying bars | 60s | Yahoo/Tradier (by time of day) |
| Options chain prices | 30s (RTH) / 5min (overnight) | Tradier |
| TV screener snapshot | 60s | TradingView screener |
| VIX | 60s | Yahoo ^VIX |
| SPX bid/ask (overnight) | 30s | Tradier quotes |

### Error Handling

- Data source failure: log error, continue with last known values, mark bars `gap_type: "stale"` after 5 min
- Tradier 429: exponential backoff, minimum 10s between retries
- Yahoo rate limit: 2s between requests, jitter
- DB write failure: buffer in memory (max 100 bars), retry every 30s
- Google Drive upload failure: retry 3 times, leave parquet in `/tmp`, alert log

---

## 13. Environment Variables

```env
PORT=3600
TRADIER_TOKEN=your_tradier_token
TRADIER_ACCOUNT_ID=your_account_id
GDRIVE_REMOTE=gdrive:SPXer/archives   # rclone remote path
DB_PATH=./data/spxer.db
LOG_LEVEL=info
```

---

## 14. Resolved Decisions

- **5m/15m/1h bars**: Aggregated from 1m bars (not fetched independently) — see Section 12
- **Parquet library**: DuckDB Node bindings preferred over parquetjs-lite (more reliable for large files, better type support)
- **Google Drive archival**: rclone CLI (configured once via `rclone config`, called as child process)
- **WebSocket reconnection**: Consumers are responsible for reconnect with exponential backoff; SPXer sends `{"type":"service_status"}` heartbeat every 30s so consumers can detect stale connections
- **Tradier batching**: All options quote fetches use Tradier's batch quote endpoint (`/v1/markets/quotes?symbols=A,B,C,...`) — max 50 symbols per call, multiple calls if needed. Never one call per contract.
- **Gap threshold boundary**: 2–60 minutes inclusive uses linear interpolation; strictly over 60 minutes uses flat/stale fill

---

## 15. Out of Scope (v1)

- Authentication on the API (internal service, not public)
- Multi-underlying support (only SPX/SPXW in v1)
- Real-time tick data (1-minute bar granularity is sufficient)
- Backtesting engine (Google Drive parquet files serve backtesting consumers)

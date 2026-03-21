<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# server — HTTP API & WebSocket Server

## Purpose

Expose market data and contract information to clients:

1. **HTTP Server** (Express) — REST API endpoints on port 3600 for health checks, market snapshots, bar history, options chains
2. **WebSocket Server** (WS) — Real-time broadcast of new bars, contract updates, state changes

Clients connect via WebSocket to subscribe to streaming updates; HTTP endpoints for one-time queries or historical data.

## Key Files

| File | Description |
|------|-------------|
| `http.ts` | Express REST API server with routes and middleware |
| `ws.ts` | WebSocket broadcast server (new bars, contract updates) |

## HTTP API Endpoints

### Health & Status

**GET `/health`**
- Response: Service status, uptime, current SPX price, database size, market mode
- Purpose: Monitoring, deployment health checks

### Market Data

**GET `/spx/snapshot`**
- Response: Latest SPX 1m bar with all indicators
- Purpose: Quick market check (current price, RSI, moving averages, etc.)

**GET `/spx/bars?tf=1m&n=100`**
- Query params: `tf` = timeframe (1m/5m/15m/1h/1d), `n` = number of bars
- Response: Array of SPX bars in ascending timestamp order
- Purpose: Historical chart data

**GET `/contracts/active`**
- Response: All ACTIVE + STICKY option contracts with latest bars
- Purpose: Live options chain view

**GET `/contracts/:symbol/bars?tf=1m&n=100`**
- Response: Historical bars for a specific contract
- Purpose: Individual option chart data

### Options Chain

**GET `/chain?expiry=YYYY-MM-DD`**
- Query params: `expiry` = specific expiration date
- Response: Full options chain (all calls and puts) for that expiry with Greeks, bid/ask
- Purpose: Option selection, strike comparison

**GET `/chain/expirations`**
- Response: List of available tracked expiration dates
- Purpose: UI dropdown, date selection

## WebSocket Events

### Server → Client (Broadcast)

**`bar`** — New 1-minute bar received
```json
{ "event": "bar", "data": { "symbol": "SPX", "timeframe": "1m", "ts": ..., "close": ..., "indicators": {...} } }
```

**`contract`** — Contract state change (UNSEEN → ACTIVE → STICKY → EXPIRED)
```json
{ "event": "contract", "data": { "symbol": "...", "state": "ACTIVE", "strike": 5000, ... } }
```

**`update`** — General server update
```json
{ "event": "update", "data": { "message": "..." } }
```

## For AI Agents

### Working In This Directory

1. **Stateless HTTP endpoints** — Each request is independent; no session state
2. **WebSocket broadcasts** — All connected clients receive updates; don't track subscriptions
3. **Error responses** — Return JSON with `error` field on failure
4. **Rate limiting** — Consider adding rate limits if exposed to public (currently internal only)
5. **CORS** — Server currently open to all origins (suitable for internal network)

### Testing Requirements

- HTTP endpoints return correct data (mock database queries)
- WebSocket connects, receives broadcasts
- Error cases handled (missing data, invalid queries)

### Common Patterns

- **Middleware**: Parse request, validate params, run query, return JSON
- **Error handling**: Try-catch with meaningful error messages
- **Broadcast**: All connected WS clients receive update (no filtering)

## API Response Format

All HTTP endpoints return JSON:

**Success**:
```json
{
  "success": true,
  "data": { ... }
}
```

**Error**:
```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

## Server Startup

1. **HTTP server** listens on port 3600 (configurable via `PORT` env var)
2. **WebSocket server** listens on same port under `/ws` path
3. **Middleware**: Express body parser, CORS, logging
4. **Routes**: Register all endpoints in `startHttpServer()`

## Dependencies

### Internal
- `src/storage/queries.ts` — Database queries
- `src/types.ts` — Bar, Contract types
- `src/config.ts` — Configuration (port, log level)

### External
- `express` — HTTP server framework
- `ws` — WebSocket server
- `dotenv` — Environment configuration

## Key Patterns

### Handler Pattern
```typescript
app.get('/endpoint', (req, res) => {
  try {
    const result = query(req.params, req.query);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});
```

### WebSocket Broadcast
```typescript
function broadcast(event: string, data: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  });
}
```

## Performance Notes

- **HTTP response time**: < 10ms (database query only)
- **WebSocket broadcast latency**: < 50ms (all connected clients)
- **Concurrent connections**: 100+ easily supported (lightweight protocol)

## Security Considerations

- **Authentication**: Currently none (internal network only)
- **Input validation**: Query params validated before passing to queries
- **SQL injection**: Impossible (all queries parameterized in storage layer)
- **Rate limiting**: Not implemented (add if exposed to internet)

<!-- MANUAL: Add API endpoint notes, client examples, or WebSocket subscription patterns below -->

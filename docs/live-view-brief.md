# Live View — Product Brief

**Date:** 2026-03-30
**Priority:** Medium
**Estimated effort:** 3–5 hours

---

## Goal

Add a **Live** tab to the existing replay viewer that shows real-time SPX price action, active agent status, trade activity, and contract mini-charts — all updating via WebSocket without page refresh.

---

## Why

Today we monitor the live agent by SSH-ing in and tailing logs, running `pm2 logs`, or curling `/agent/status`. There's no visual way to see:

- Where SPX is relative to recent HMA crosses
- Whether the agent has open positions and what direction
- Today's P&L trajectory
- How the active option contracts are moving

The replay viewer already has all the UI components (charts, trade tables, contract grids). A live tab reuses the same visual language for real-time monitoring.

---

## Approach: Tab on Replay Viewer

**Add a tab**, not a separate dashboard, because:

1. **Replay viewer already has everything** — lightweight-charts candlestick charts, trades table, contract mini-charts, strategy analysis panel, the full UI kit (~1,544 lines, well-structured)
2. **Same data shape** — the live data service exposes bars, contracts, and agent status in the same format as replay data
3. **WebSocket already exists** — port 3600 broadcasts `spx_bar`, `contract_bar`, `chain_update`, `market_context`, `heartbeat` events
4. **One codebase** — no separate PM2 process, separate HTML, or separate port

---

## Data Sources (Already Available)

### REST Endpoints (port 3600)

| Endpoint | Returns | Use |
|----------|---------|-----|
| `GET /spx/snapshot` | Latest SPX quote + indicators | Initial load |
| `GET /spx/bars?tf=1m&n=390` | 1-min OHLCV bars for today | Chart backfill |
| `GET /contracts/active` | All active contracts with latest quote | Contract grid |
| `GET /contracts/:symbol/bars` | 1-min bars for a specific contract | Contract mini-charts |
| `GET /agent/status` | Agent status (cycle, mode, P&L, positions, etc.) | Status banner |
| `GET /agent/activity?n=50` | Recent activity log entries | Trades table |
| `GET /chain` | Full options chain | Reference |

### WebSocket Messages (port 3600)

| Message Type | Payload | Use |
|-------------|---------|-----|
| `spx_bar` | Latest 1-min bar with indicators | Update SPX chart candle |
| `contract_bar` | `{ symbol, data: quote }` | Update contract mini-charts |
| `chain_update` | `{ expiry, data: chain }` | Refresh contract grid |
| `market_context` | Full market snapshot | Refresh indicators |
| `heartbeat` | `{ ts }` | Connection health check |

### Agent Status Structure

```typescript
{
  ts: number;           // Unix timestamp
  timeET: string;       // "14:32:15"
  cycle: number;        // Agent cycle count
  mode: string;         // "LIVE" or "PAPER"
  spxPrice: number;     // Current SPX price
  minutesToClose: number;
  openPositions: number;
  dailyPnL: number;
  lastAction: string;   // "BUY CALL SPXW260330C06400000"
  lastReasoning: string;
  scannerReads: [{ id, read, setups }];
  nextCheckSecs: number;
  upSince: string;      // ISO timestamp
}
```

---

## UI Spec

### Header

Add a **Replay / Live** toggle to the existing header bar. When "Live" is selected:

- Date picker hides (not applicable)
- Connection status indicator appears (🟢 connected / 🔴 disconnected)
- Auto-reconnect on WebSocket drop

### Status Banner (new, Live only)

Horizontal bar below the header showing:

| Field | Source | Display |
|-------|--------|---------|
| Mode | `agent/status → mode` | `LIVE ⚠️` or `PAPER` badge |
| SPX Price | `agent/status → spxPrice` | `$6,402.15` |
| Daily P&L | `agent/status → dailyPnL` | `+$1,282` (green) / `-$340` (red) |
| Open Positions | `agent/status → openPositions` | `2 open` |
| Cycle | `agent/status → cycle` | `#847` |
| Minutes to Close | `agent/status → minutesToClose` | `47m` |
| HMA Direction | Derived from last bar HMA(3) vs HMA(17) | `▲ BULL` / `▼ BEAR` |
| Agent Uptime | `agent/status → upSince` | `4h 23m` |

Poll `/agent/status` every 5 seconds (or derive from WS `market_context` messages).

### SPX Candlestick Chart (reuse existing)

- Same lightweight-charts config as replay viewer
- **Initial load**: `GET /spx/bars?tf=1m&n=390` to backfill today's history
- **Live updates**: On each `spx_bar` WebSocket message, update the last candle (or append new one)
- Show HMA(3) and HMA(17) overlay lines (same as replay)
- Show trade markers (entry/exit arrows) from `/agent/activity`
- Auto-scroll to the latest candle (with option to pin/unpin)

### Trades Table (reuse existing)

- Same column layout as replay: Time, Direction, Strike, Entry, Exit, P&L, Reason
- **Initial load**: `GET /agent/activity?n=50`
- **Live updates**: Poll every 10 seconds (activity log is append-only JSONL)
- New trades animate in at the top
- Click a trade → expand contract chart (same behavior as replay)

### Contract Mini-Charts (reuse existing)

- Same grid layout as replay (auto-fill, 220px min-width cards)
- **Initial load**: `GET /contracts/active` for the list, then `/contracts/:symbol/bars` for each
- **Live updates**: Subscribe to `contract_bar` messages for active contracts
- Show "traded" badge on contracts that match open positions
- Calls on left tab, puts on right tab (same as replay)

### Strategy Analysis Panel (reuse existing, adapt for live)

Instead of post-hoc analysis, show **live session stats**:

- Trades today / Win rate / Avg P&L per trade
- Running equity curve (from activity entries)
- Current regime tag (if available from agent status)

---

## Implementation Plan

### Phase 1: Core Live Tab (~2 hours)

1. Add `Replay | Live` tab toggle to header
2. When Live selected:
   - Fetch `/spx/bars?tf=1m&n=390` and render chart
   - Connect WebSocket, update chart on `spx_bar`
   - Fetch `/agent/status` and render status banner
   - Fetch `/agent/activity?n=50` and render trades table
3. Auto-reconnect WebSocket with exponential backoff

### Phase 2: Contract Grid + Interactivity (~1.5 hours)

4. Fetch `/contracts/active`, render mini-chart grid
5. Subscribe to `contract_bar` for live updates
6. Click trade → expand contract chart (reuse existing expand logic)
7. Click contract card → expand full chart

### Phase 3: Polish (~1 hour)

8. Connection status indicator with reconnect
9. Auto-scroll toggle (pin/unpin latest candle)
10. New trade animation (flash/highlight)
11. Mobile-responsive status banner
12. Graceful degradation when agent is offline (`/agent/status` returns `{ status: 'offline' }`)

---

## What NOT to Build

- **No separate server** — reuse port 3600, same HTML file
- **No authentication** — this runs on a private VPS, same as replay viewer
- **No historical date selection in Live mode** — that's what Replay mode is for
- **No order placement UI** — the agent is autonomous, no manual intervention
- **No framework** — keep it vanilla JS like the replay viewer (no React/Vue)
- **No new WebSocket messages needed** — everything we need is already broadcast

---

## Technical Notes

- The replay viewer is a single 1,544-line HTML file (`src/server/replay-viewer.html`) with inline CSS and JS — keep the same pattern
- lightweight-charts v5.0.5 is already loaded via CDN
- The data service runs on port 3600, replay viewer is served at `/replay/`
- Live view should be at `/replay/#live` or `/replay/?mode=live` (hash-based tab switching)
- Agent status file is at `logs/agent-status.json`, read via `/agent/status` endpoint
- Activity log is at `logs/agent-activity.jsonl`, read via `/agent/activity` endpoint

---

## Success Criteria

1. Can see live SPX chart updating every minute without refresh
2. Can see agent's current status (P&L, positions, mode) at a glance
3. Can see trades appearing in real-time as agent executes them
4. Can click a trade to see the contract's price chart at that moment
5. WebSocket reconnects automatically after network hiccup
6. Switching between Replay and Live tabs preserves each mode's state

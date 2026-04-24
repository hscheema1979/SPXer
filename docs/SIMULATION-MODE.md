# Simulation Mode

SPXer now supports **SIMULATION mode** — live signals with locally-simulated orders. This provides a safer rollout path than Tradier's paper trading (which is often broken and doesn't return proper order IDs).

## Architecture

```
Live Data Service → Event Handler → Execution Router → [FakeBroker | Tradier]
                      ↓                    ↓
                 WebSocket            SIMULATION mode:
               contract_signal        - FakeBroker locally
                                      - OTOCO bracket orders
                                      - Real-time price feed
                                      - Simulated fills
```

## Three Execution Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **SIMULATION** | Live signals + simulated orders locally | Safe testing, validation |
| **PAPER** | Live signals + Tradier paper account | Not recommended (broken) |
| **LIVE** | Live signals + Tradier production account | Real trading |

## Quick Start

### 1. Start Event Handler in Simulation Mode

```bash
# Set execution mode to simulation
export AGENT_EXECUTION_MODE=SIMULATION

# Start the handler (paper flag is ignored in simulation mode)
npm run handler
# or
AGENT_CONFIG_ID="your-config-id" AGENT_EXECUTION_MODE=SIMULATION npm run handler
```

### 2. Verify Simulation Mode is Active

```bash
# Check current execution mode
curl http://localhost:3600/agent/mode
# Response: { "mode": "SIMULATION", "simulation": true, "paper": false }

# Check simulation stats
curl http://localhost:3600/agent/simulation
# Response: {
#   "active": true,
#   "mode": "SIMULATION",
#   "stats": {
#     "ordersSubmitted": 5,
#     "ordersFilled": 5,
#     "pendingOrders": 0
#   },
#   "positions": [...]
# }
```

### 3. Watch the Logs

```bash
# You should see:
[execution] INITIALIZING SIMULATION MODE - Orders will be simulated locally
[execution] FakeBroker ready - orders will NOT be sent to Tradier
[handler] Execution mode: SIMULATION
[executor] SIMULATION: OTOCO buy_to_open 1x SPXW260424C07100000 @ $10.00
[executor]             TP: $12.50 | SL: $7.50
[executor]             Bracket: #1000 | Entry: #1001 | TP: #1002 | SL: #1003
```

### 4. Switch to Live Mode

When you're confident signals are flowing correctly:

```bash
# Stop the handler (Ctrl+C or PM2 stop)
pm2 stop event-handler

# Switch to live mode
export AGENT_EXECUTION_MODE=LIVE

# Restart the handler
pm2 start event-handler --update-env
# or
npm run handler:live
```

## FakeBroker Features

### OTOCO Bracket Orders

FakeBroker simulates full Tradier OTOCO bracket orders:

```
Entry Order (market) → Triggers:
  ├─ TP Leg (limit) → Sells when price ≥ takeProfit
  └─ SL Leg (stop)  → Sells when price ≤ stopLoss
```

### Real-Time Price Monitoring

FakeBroker receives live price updates from the data service:

1. **WebSocket contract_bar events** — Real-time as bars close
2. **Polling fallback** — Every 5 seconds for all open positions

### Position Tracking

FakeBroker tracks all simulated positions:

```typescript
interface FakePosition {
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  stopLoss: number;
  takeProfit: number;
  orders: FakeOrder[];
}
```

## HTTP API Endpoints

### `GET /agent/simulation`

Returns simulation status and statistics:

```json
{
  "active": true,
  "mode": "SIMULATION",
  "stats": {
    "ordersSubmitted": 10,
    "ordersFilled": 8,
    "pendingOrders": 2
  },
  "positions": [
    {
      "symbol": "SPXW260424C07100000",
      "quantity": 1,
      "entryPrice": 10.00,
      "currentPrice": 10.50,
      "stopLoss": 7.50,
      "takeProfit": 12.50,
      "unrealizedPnl": 50.00,
      "status": "OPEN",
      "orders": [...]
    }
  ]
}
```

### `GET /agent/mode`

Returns current execution mode:

```json
{
  "mode": "SIMULATION",
  "simulation": true,
  "paper": false
}
```

### `POST /agent/simulation/toggle`

Instructions for changing modes (requires restart):

```json
{
  "message": "To enable simulation mode: set AGENT_EXECUTION_MODE=SIMULATION and restart handler",
  "currentMode": "LIVE",
  "requiresRestart": true
}
```

## Position Lifecycle in Simulation

```
1. Signal Received → PositionOrderManager.evaluate()
2. Decision: OPEN → FakeBroker.submitOtocOrder()
3. Entry Order Filled → Position status: OPENING
4. AccountStream Event → Position status: OPEN
5. Price Updates → FakeBroker monitors TP/SL
6. TP or SL Triggered → Position status: CLOSED
```

## Price Feed Integration

FakeBroker receives price updates from two sources:

### WebSocket (Primary)
```javascript
// In event_handler_mvp.ts handleWebSocketMessage()
if (data.type === 'contract_bar') {
  const fakeBroker = getFakeBroker();
  if (fakeBroker && data.data?.close) {
    fakeBroker.updatePrice(data.data.symbol, data.data.close);
  }
}
```

### Polling (Fallback)
```javascript
// Every 5 seconds in main()
for (const pos of positions) {
  const bar = await fetch(`/contracts/${pos.symbol}/latest`);
  fakeBroker.updatePrice(pos.symbol, bar.close);
}
```

## Testing Simulation Mode

### Unit Tests

```bash
# Run FakeBroker tests
npm test -- fake-broker.test.ts
```

### Integration Tests

```bash
# Run wire-simulator-to-pipeline test
npx tsx scripts/test/wire-simulator-to-pipeline.ts
```

### Manual Testing

1. Start data service: `npm run dev`
2. Start handler in simulation mode: `AGENT_EXECUTION_MODE=SIMULATION npm run handler`
3. Check HTTP endpoints for status
4. Monitor logs for order flow
5. Verify TP/SL fills on price moves

## Monitoring Simulation

### PM2 Process

```bash
# View logs
pm2 logs event-handler

# Monitor status
pm2 status event-handler

# Restart with mode change
pm2 restart event-handler --update-env AGENT_EXECUTION_MODE=LIVE
```

### HTTP Endpoints

```bash
# Simulation status
watch -n 5 'curl -s http://localhost:3600/agent/simulation | jq'

# Active positions
curl -s http://localhost:3600/agent/simulation | jq '.positions'

# Execution mode
curl -s http://localhost:3600/agent/mode | jq
```

## Rollout Strategy

### Phase 1: Simulation (Current)
- Live signals from data service
- Simulated orders locally
- Validate signal detection
- Verify entry/exit logic
- Monitor TP/SL behavior

### Phase 2: Small Size Live
- Switch to `AGENT_EXECUTION_MODE=LIVE`
- Start with 1 contract per signal
- Monitor for 1-2 weeks
- Compare simulated vs actual fills

### Phase 3: Full Production
- Increase position size to target
- Full confidence in system
- Continuous monitoring

## Troubleshooting

### FakeBroker Not Initialized

**Error**: `FakeBroker not initialized`

**Solution**: Check that `initExecution()` is called before any trades:
```typescript
import { initExecution } from './src/agent/execution-router';
initExecution();
```

### No Price Updates

**Error**: TP/SL not triggering

**Solutions**:
1. Check WebSocket connection: `curl http://localhost:3600/health`
2. Verify contract_bar subscription in logs
3. Check polling fallback is running (5s interval)
4. Manually trigger price update: `fakeBroker.updatePrice(symbol, price)`

### Wrong Mode Active

**Error**: Orders going to Tradier instead of simulating

**Solution**: Verify `AGENT_EXECUTION_MODE` env var:
```bash
echo $AGENT_EXECUTION_MODE  # Should be "SIMULATION"
pm2 env event-handler | grep AGENT_EXECUTION_MODE
```

## File Structure

```
src/agent/
├── execution-router.ts    — Routes orders based on EXECUTION_MODE
├── fake-broker.ts         — Simulates Tradier API and WebSocket
├── trade-executor.ts      — Modified to route to FakeBroker
└── account-stream.ts      — Real-time fill detection

event_handler_mvp.ts       — Main handler (modified for sim mode)
docs/SIMULATION-MODE.md    — This file
```

## Comparison: Paper vs Simulation

| Feature | Tradier Paper | Simulation Mode |
|---------|---------------|-----------------|
| Order IDs | ❌ Often broken | ✅ Always returned |
| OTOCO Brackets | ❌ Partial support | ✅ Full support |
| Fill Detection | ❌ Unreliable | ✅ Instant |
| Price Feed | ❌ Delayed | ✅ Real-time |
| P&L Tracking | ❌ Inaccurate | ✅ Precise |
| WebSocket Events | ❌ Inconsistent | ✅ Guaranteed |

## Future Enhancements

- [ ] Admin viewer UI with simulation controls (toggle button, position table)
- [ ] Fill slippage model based on market conditions
- [ ] Partial fill simulation
- [ ] Rejected order scenarios
- [ ] Latency injection for realistic timing
- [ ] Historical replay with FakeBroker

## Related Documentation

- [Event-Driven Handler Architecture](../docs/EVENT_HANDLER_ARCHITECTURE.md)
- [Fill Model](../docs/FILL-MODEL.md)
- [CLAUDE.md](../CLAUDE.md#event-driven-handler)

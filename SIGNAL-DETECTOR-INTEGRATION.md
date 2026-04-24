# Signal Detector Integration - Implementation Summary

## Overview

Created a pure function signal detection system that the event handler calls at :00 seconds of every minute. Completely independent of spxer - fetches all data from Tradier REST API.

## Architecture

```
Event Handler (event_handler_mvp.ts)
  ├─ Timer: fires at :00 seconds
  ├─ Calls: checkForSignals()
  │   └─ For each config:
  │       ├─ Build SignalParams from config
  │       ├─ Call: detectHmaCrossPair(params)
  │       │   ├─ Fetch SPX price from Tradier
  │       │   ├─ Calculate strikes (ITM5 call/put)
  │       │   ├─ Fetch timesales from Tradier
  │       │   ├─ Aggregate to 3m bars
  │       │   ├─ Compute HMA(3) and HMA(12)
  │       │   └─ Return: { cross, direction, hmaFast, hmaSlow, ... }
  │       └─ If cross: handleContractSignal(signal)
  └─ WebSocket: still connects to spxer (port 3600) for SPX price updates
```

## Files Created

### `src/pipeline/spx/signal-detector-function.ts`
Pure function for signal detection.

**Interface:**
```typescript
export interface SignalParams {
  fast: number;           // HMA fast period (e.g., 3)
  slow: number;           // HMA slow period (e.g., 12)
  strikeOffset: number;   // Strike offset from SPX (e.g., -5 for ITM5)
  timeframe: number;      // Bar timeframe in minutes (e.g., 3)
  side: 'call' | 'put';   // Call or put
}

export interface SignalResult {
  cross: boolean;
  direction: 'bullish' | 'bearish' | null;
  hmaFast: number;
  hmaSlow: number;
  price: number;
  strike: number;
  symbol: string;
  barTime: string | null;
  barsAnalyzed: number;
}
```

**Functions:**
- `detectHmaCross(params): Promise<SignalResult>` - Single contract detection
- `detectHmaCrossPair(params): Promise<{call, put}>` - Both call and put

### Test Files

1. **`test-signal-detector-function.ts`** - Unit test for the function
2. **`test-handler-integration.ts`** - Integration test simulating event handler usage

## Integration into Event Handler

Added to `event_handler_mvp.ts`:

1. **Import:**
```typescript
import { detectHmaCrossPair, type SignalParams } from './src/pipeline/spx/signal-detector-function';
```

2. **Timer (in `main()`):**
```typescript
// Signal detection: check at :00 seconds of every minute
setInterval(() => {
  const now = new Date();
  if (now.getSeconds() === 0) {
    checkForSignals().catch(e => console.error('[handler] Signal check failed:', e));
  }
}, 1000);
```

3. **Function:**
```typescript
async function checkForSignals(): Promise<void> {
  for (const [configId, state] of configs) {
    const cfg = state.config;

    const params: Omit<SignalParams, 'side'> = {
      fast: cfg.signals.hmaCrossFast,
      slow: cfg.signals.hmaCrossSlow,
      strikeOffset: -5,  // ITM5
      timeframe: parseInt(cfg.signals.signalTimeframe.replace(/\D/g, '')) || 3,
    };

    const results = await detectHmaCrossPair(params);

    for (const [side, result] of [['call', results.call], ['put', results.put]]) {
      if (result.cross && result.direction) {
        const signal = { symbol, strike, side, direction, ... };
        await handleContractSignal(signal);
      }
    }
  }
}
```

## Test Results

### Signal Detection Test
```
Testing ITM5 CALL: HMA(3) × HMA(12), Strike offset: -5, Timeframe: 3m

Result:
  Symbol: SPXW260424C07155000
  Strike: 7155
  SPX Price: 7158.17
  Bars analyzed: 74
  HMA(3): 8.96
  HMA(12): 9.94
  Cross: NO
  Bar time: 2026-04-24T13:02:00
```

### Handler Integration Test
```
Params: HMA: 3×12, Offset: -5, Timeframe: 3m, Side: call

Result:
  Cross: NO
  Direction: N/A
  HMA(3): 11.96
  HMA(12): 13.28
  Symbol: SPXW260424C07150000
  Strike: 7150
  SPX: 7157.15
  Bars: 74
  Time: 2026-04-24T13:02:00
```

## Key Features

1. **Independence**: No dependency on spxer data pipeline
2. **Pure Function**: Stateless, takes params, returns result
3. **Self-Contained**: Fetches everything from Tradier REST API
4. **Config-Driven**: Reads HMA pairs, timeframe from config
5. **Timer-Based**: Checks at :00 seconds, not continuous polling
6. **Pair Detection**: Checks both call and put simultaneously

## Configuration Mapping

| Config Field | SignalParams | Value |
|-------------|--------------|-------|
| `signals.hmaCrossFast` | `fast` | 3 |
| `signals.hmaCrossSlow` | `slow` | 12 |
| `signals.signalTimeframe` | `timeframe` | 3 (from "3m") |
| - | `strikeOffset` | -5 (hardcoded ITM5) |
| - | `side` | 'call' or 'put' |

## Next Steps

1. Deploy event handler with new signal detection
2. Monitor for signals in production
3. Compare with spxer's signal detection for validation
4. Consider making strikeOffset configurable if needed

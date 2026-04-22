#!/usr/bin/env tsx
/**
 * Simple WebSocket test client for contract signals
 *
 * Connects to the data service WebSocket and logs all contract_signal events.
 * Validates that channelization is working correctly.
 *
 * Usage:
 *   npx tsx test-contract-signals.ts
 */

import WebSocket from 'ws';

const WS_URL = process.env.SPXER_WS_URL || 'ws://localhost:3600/ws';

// HMA pairs to test (common ones used by configs)
const TEST_PAIRS = [
  'hma_3_19',
  'hma_5_19',
];

let signalCount = 0;
let startTime = Date.now();

function formatTime(): string {
  const now = new Date();
  return now.toISOString().split('T')[1].split('.')[0];
}

console.log(`[${formatTime()}] Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`[${formatTime()}] Connected!`);

  // Subscribe to test channels
  for (const pair of TEST_PAIRS) {
    const msg = JSON.stringify({
      action: 'subscribe',
      channel: `contract_signal:${pair}`
    });
    ws.send(msg);
    console.log(`[${formatTime()}] Subscribed to: contract_signal:${pair}`);
  }

  // Also subscribe to SPX for price context
  ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx_bar' }));

  console.log(`[${formatTime()}] Waiting for signals...`);
});

ws.on('message', (data: Buffer) => {
  try {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'contract_signal') {
      signalCount++;

      const channel = msg.channel || 'unknown';
      const data = msg.data;

      console.log(`[${formatTime()}] [${channel}] ${data.direction.toUpperCase()} HMA(${data.hmaFastPeriod})×HMA(${data.hmaSlowPeriod})`);
      console.log(`  Symbol: ${data.symbol}`);
      console.log(`  Strike: $${data.strike} ${data.side}`);
      console.log(`  Price: $${data.price.toFixed(2)}`);
      console.log(`  Total signals: ${signalCount}`);

      // Rate summary every 10 signals
      if (signalCount % 10 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (signalCount / elapsed * 60).toFixed(1);
        console.log(`\n[${formatTime()}] Rate summary: ${signalCount} signals in ${elapsed.toFixed(0)}s = ${rate} signals/min\n`);
      }
    } else if (msg.type === 'spx_bar') {
      const spxPrice = msg.data.close;
      // console.log(`[${formatTime()}] SPX: $${spxPrice.toFixed(2)}`);
    } else if (msg.type === 'connected') {
      console.log(`[${formatTime()}] Server confirmed connection`);
    } else if (msg.type === 'heartbeat') {
      // Ignore heartbeats
    } else {
      console.log(`[${formatTime()}] Other message type: ${msg.type}`);
    }
  } catch (e) {
    console.error(`[${formatTime()}] Error parsing message:`, e);
  }
});

ws.on('error', (e) => {
  console.error(`[${formatTime()}] WebSocket error:`, e);
});

ws.on('close', () => {
  console.log(`[${formatTime()}] WebSocket closed`);
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\nTest Summary:`);
  console.log(`  Duration: ${elapsed.toFixed(1)}s`);
  console.log(`  Total signals: ${signalCount}`);
  if (elapsed > 0) {
    const rate = (signalCount / elapsed * 60).toFixed(1);
    console.log(`  Average rate: ${rate} signals/min`);
  }
  process.exit(0);
});

// Auto-close after 5 minutes for testing
setTimeout(() => {
  console.log(`[${formatTime()}] Test timeout (5 minutes), closing...`);
  ws.close();
}, 5 * 60 * 1000);

#!/usr/bin/env tsx
/**
 * Query event handler positions from memory
 *
 * This script queries the data service's /agent/status endpoint
 * to see what positions the event handler is currently tracking.
 *
 * Usage: npx tsx scripts/check-handler-positions.ts
 */

import axios from 'axios';

const SPXER_URL = process.env.SPXER_URL || 'http://localhost:3600';

async function checkPositions() {
  try {
    const response = await axios.get(`${SPXER_URL}/agent/status`, { timeout: 5000 });
    const status = response.data;

    console.log('\n=== Event Handler Status ===\n');
    console.log(`Agent: ${status.agent || 'Unknown'}`);
    console.log(`Mode: ${status.mode || 'Unknown'}`);
    console.log(`SPX: $${status.spxPrice?.toFixed(2) || 'N/A'}`);
    console.log(`Uptime: ${status.uptime ? Math.floor(status.uptime / 60) + ' min' : 'N/A'}`);

    if (!status.positions || Object.keys(status.positions).length === 0) {
      console.log('\nNo open positions tracked\n');
      return;
    }

    console.log('\nOpen Positions:\n');

    for (const [posId, pos] of Object.entries(status.positions)) {
      console.log(`[${posId.substring(0, 8)}...] ${pos.symbol} x${pos.quantity}`);
      console.log(`  Entry: $${pos.entryPrice.toFixed(2)}`);
      console.log(`  TP: $${pos.takeProfit?.toFixed(2) || 'N/A'} | SL: $${pos.stopLoss.toFixed(2)}`);
      console.log(`  Opened: ${new Date(pos.openedAt).toLocaleString()}`);

      if (pos.tradierOrderId) console.log(`  Order ID: ${pos.tradierOrderId}`);
      if (pos.bracketOrderId) console.log(`  Bracket ID: ${pos.bracketOrderId}`);
      if (pos.tpLegId) console.log(`  TP Leg ID: ${pos.tpLegId}`);
      if (pos.slLegId) console.log(`  SL Leg ID: ${pos.slLegId}`);

      console.log('');
    }
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      console.error('Cannot connect to data service. Is it running?');
    } else {
      console.error('Error:', error.message);
    }
  }
}

checkPositions();

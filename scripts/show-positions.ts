#!/usr/bin/env tsx
/**
 * Show all open positions tracked by event handler
 *
 * Usage: npx tsx scripts/show-positions.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface PositionState {
  positions: Map<string, any>;
  lastEntryTs: number;
  dailyPnl: number;
}

interface SessionFile {
  date: string;
  configs: Record<string, PositionState>;
}

function showPositions(): void {
  // Find all event handler session files
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    console.log('No logs directory found');
    return;
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('agent-session-event-handler'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No event handler session files found');
    return;
  }

  // Load the most recent session file
  const sessionFile = path.join(logsDir, files[0]);
  const sessionData: SessionFile = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

  console.log(`\n=== Event Handler Positions (${sessionData.date}) ===\n`);

  let hasPositions = false;

  for (const [configId, state] of Object.entries(sessionData.configs)) {
    if (!state.positions || state.positions.size === 0) {
      continue;
    }

    hasPositions = true;
    console.log(`[${configId}]`);

    for (const [posId, pos] of state.positions) {
      console.log(`  ${pos.symbol} x${pos.quantity}`);
      console.log(`    Entry: $${pos.entryPrice.toFixed(2)} | TP: $${pos.takeProfit?.toFixed(2) || 'N/A'} | SL: $${pos.stopLoss.toFixed(2)}`);
      console.log(`    Opened: ${new Date(pos.openedAt).toLocaleString()}`);
      if (pos.tradierOrderId) console.log(`    Order ID: ${pos.tradierOrderId}`);
      if (pos.bracketOrderId) console.log(`    Bracket ID: ${pos.bracketOrderId}`);
      if (pos.tpLegId) console.log(`    TP Leg ID: ${pos.tpLegId}`);
      if (pos.slLegId) console.log(`    SL Leg ID: ${pos.slLegId}`);
      console.log(`    Position ID: ${posId}`);
      console.log('');
    }
  }

  if (!hasPositions) {
    console.log('No open positions');
  }
}

showPositions();

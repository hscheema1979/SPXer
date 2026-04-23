#!/usr/bin/env tsx
/**
 * Show positions by basket member for event handler
 *
 * Usage: npx tsx scripts/show-basket-positions.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

const WS_URL = process.env.SPXER_WS_URL || 'ws://localhost:3600/ws';

interface PositionSummary {
  symbol: string;
  quantity: number;
  entryPrice: number;
  strike: number;
  side: string;
  tradierOrderId?: number;
  bracketOrderId?: number;
  basketMember?: string;
  openedAt: number;
}

async function showBasketPositions() {
  return new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);

    // Subscribe to agent status updates if available
    let statusReceived = false;

    ws.on('open', () => {
      console.log('Connected to data service');

      // Request agent status
      ws.send(JSON.stringify({ action: 'get_status' }));

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!statusReceived) {
          console.log('\nNo event handler running or status not available\n');
          console.log('To check positions directly:');
          console.log('1. Run: npx tsx event_handler_mvp.ts (in another terminal)');
          console.log('2. Check logs for "Position opened" messages\n');
          resolve();
        }
        ws.close();
      }, 5000);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'agent_status' || msg.type === 'status') {
          statusReceived = true;
          const status = msg.data;

          console.log('\n=== Event Handler Positions ===\n');
          console.log(`Agent: ${status.agent || 'Unknown'}`);
          console.log(`Config: ${status.configId || 'Unknown'}`);
          console.log(`Mode: ${status.mode || 'Unknown'}`);
          console.log(`SPX: $${status.spxPrice?.toFixed(2) || 'N/A'}\n`);

          if (!status.positions || Object.keys(status.positions).length === 0) {
            console.log('No open positions\n');
            ws.close();
            resolve();
            return;
          }

          // Group by basket member
          const byBasket: Record<string, PositionSummary[]> = {};

          for (const [posId, pos] of Object.entries(status.positions)) {
            const basketMember = (pos as any).basketMember || 'default';
            if (!byBasket[basketMember]) {
              byBasket[basketMember] = [];
            }
            byBasket[basketMember].push(pos as PositionSummary);
          }

          // Display by basket member
          for (const [basketMember, positions] of Object.entries(byBasket)) {
            if (basketMember !== 'default') {
              console.log(`[Basket: ${basketMember}] (${positions.length} position${positions.length > 1 ? 's' : ''})`);
            } else {
              console.log(`[Default] (${positions.length} position${positions.length > 1 ? 's' : ''})`);
            }

            for (const pos of positions) {
              console.log(`  ${pos.symbol} x${pos.quantity}`);
              console.log(`    Entry: $${pos.entryPrice.toFixed(2)} | TP: $${pos.takeProfit?.toFixed(2) || 'N/A'} | SL: $${pos.stopLoss.toFixed(2)}`);
              console.log(`    Opened: ${new Date(pos.openedAt).toLocaleString()}`);

              if (pos.tradierOrderId) console.log(`    Order ID: ${pos.tradierOrderId}`);
              if (pos.bracketOrderId) console.log(`    Bracket ID: ${pos.bracketOrderId}`);

              console.log(`    Position ID: ${posId.substring(0, 12)}...\n`);
            }
          }

          ws.close();
          resolve();
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      resolve();
    });

    ws.on('close', () => {
      resolve();
    });
  });
}

showBasketPositions();

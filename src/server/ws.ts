import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

type Subscription = { channel: string; symbol?: string; expiry?: string };
const clients = new Map<WebSocket, Set<string>>();

export function startWsServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.set(ws, new Set());

    ws.on('message', (raw) => {
      try {
        const msg: { action: string } & Subscription = JSON.parse(raw.toString());
        const subs = clients.get(ws)!;
        if (msg.action === 'subscribe') {
          subs.add(subKey(msg));
        } else if (msg.action === 'unsubscribe') {
          subs.delete(subKey(msg));
        }
      } catch {}
    });

    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  // Heartbeat every 30s
  setInterval(() => {
    broadcast({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000) });
  }, 30_000);

  return wss;
}

export function broadcast(message: object): void {
  const data = JSON.stringify(message);
  for (const [ws, subs] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const msg = message as any;
    // Route to relevant subscribers
    if (msg.type === 'spx_bar' && subs.has('spx')) {
      ws.send(data);
    } else if (msg.type === 'contract_bar' && subs.has(`contract:${msg.symbol}`)) {
      ws.send(data);
    } else if (msg.type === 'chain_update' && subs.has(`chain:${msg.expiry}`)) {
      ws.send(data);
    } else if (msg.type === 'hma_cross_signal' && (subs.has('signals') || subs.has('spx'))) {
      ws.send(data);
    } else if (msg.type === 'contract_signal') {
      const fullChannel = `contract_signal:${msg.channel}`;
      if (subs.has(fullChannel)) {
        ws.send(data);
      } else {
        const parts = String(msg.channel).split(':');
        if (parts.length === 3) {
          const pairOnly = `contract_signal:${parts[1]}`;
          if (subs.has(pairOnly)) {
            ws.send(data);
          }
        }
      }
    } else if (['market_context', 'heartbeat', 'service_shutdown'].includes(msg.type)) {
      ws.send(data); // broadcast to all
    }
  }
}

export function getWsClientCount(): number {
  return clients.size;
}

function subKey(sub: Subscription): string {
  if (sub.channel === 'contract') return `contract:${sub.symbol}`;
  if (sub.channel === 'chain') return `chain:${sub.expiry}`;
  return sub.channel;
}

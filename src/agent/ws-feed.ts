/**
 * WebSocket Feed — connects to the SPXer data service WebSocket
 * and emits typed events for bar closes, signals, etc.
 *
 * Replaces REST polling for bar data. The agent subscribes to channels
 * and receives bar events pushed in real-time as they close.
 *
 * Features:
 *   - Auto-reconnect with exponential backoff
 *   - Heartbeat monitoring (90s timeout)
 *   - Subscription management (subscribe/unsubscribe channels)
 *   - Typed EventEmitter events
 *
 * Usage:
 *   const feed = new WsFeed('ws://localhost:3600/ws');
 *   feed.on('spx_bar', (bar) => { ... });
 *   feed.on('contract_bar', (symbol, bar) => { ... });
 *   feed.connect();
 *   feed.subscribe('spx');
 *   feed.subscribe('contract', 'SPXW260401C06000000');
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BarEvent {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic?: boolean;
  gapType?: string;
  indicators: Record<string, number | null>;
}

export interface WsFeedEvents {
  spx_bar: (bar: BarEvent) => void;
  contract_bar: (symbol: string, bar: BarEvent) => void;
  hma_cross_signal: (signal: { direction: string; ts: number; price: number }) => void;
  chain_update: (expiry: string, data: any) => void;
  market_context: (data: any) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnected: () => void;
}

// ── WsFeed Class ───────────────────────────────────────────────────────────

export class WsFeed extends EventEmitter {
  private url: string;
  private ws: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private running = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageTs = 0;

  // Heartbeat timeout: if no message in 90s, assume dead
  private heartbeatTimeoutMs = 90_000;

  constructor(url: string = 'ws://localhost:3600/ws') {
    super();
    this.url = url;
  }

  /** Connect to the WebSocket server */
  connect(): void {
    if (this.running) return;
    this.running = true;
    this._connect();
  }

  /** Subscribe to a channel */
  subscribe(channel: string, symbol?: string, expiry?: string): void {
    const key = this._subKey(channel, symbol, expiry);
    this.subscriptions.add(key);

    // Send subscribe if connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: any = { action: 'subscribe', channel };
      if (symbol) msg.symbol = symbol;
      if (expiry) msg.expiry = expiry;
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Unsubscribe from a channel */
  unsubscribe(channel: string, symbol?: string, expiry?: string): void {
    const key = this._subKey(channel, symbol, expiry);
    this.subscriptions.delete(key);

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: any = { action: 'unsubscribe', channel };
      if (symbol) msg.symbol = symbol;
      if (expiry) msg.expiry = expiry;
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Subscribe to all active contracts by symbol */
  subscribeContracts(symbols: string[]): void {
    for (const sym of symbols) {
      this.subscribe('contract', sym);
    }
  }

  /** Unsubscribe from contracts no longer needed */
  unsubscribeContracts(symbols: string[]): void {
    for (const sym of symbols) {
      this.unsubscribe('contract', sym);
    }
  }

  /** Is the WebSocket connected? */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.reconnecting;
  }

  /** Get time since last message in ms */
  getTimeSinceLastMessage(): number {
    return this.lastMessageTs > 0 ? Date.now() - this.lastMessageTs : Infinity;
  }

  /** Disconnect and stop reconnecting */
  close(): void {
    this.running = false;
    this._clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _connect(): void {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log(`[ws-feed] Connected to ${this.url}`);
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.lastMessageTs = Date.now();
        this._startHeartbeatMonitor();

        // Re-subscribe to all tracked channels
        this._resubscribeAll();

        if (this.reconnectAttempts === 0) {
          this.emit('connected');
        } else {
          this.emit('reconnected');
        }
      });

      this.ws.on('message', (raw: Buffer) => {
        this.lastMessageTs = Date.now();
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch (e) {
          // Ignore parse errors
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString() || `code ${code}`;
        console.log(`[ws-feed] Disconnected: ${reasonStr}`);
        this.emit('disconnected', reasonStr);
        this._scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        console.error(`[ws-feed] Error: ${err.message}`);
        // 'close' event will fire next, triggering reconnect
      });
    } catch (e) {
      console.error(`[ws-feed] Connect failed: ${(e as Error).message}`);
      this._scheduleReconnect();
    }
  }

  private _handleMessage(msg: any): void {
    switch (msg.type) {
      case 'spx_bar':
        this.emit('spx_bar', msg.data);
        break;
      case 'contract_bar':
        this.emit('contract_bar', msg.symbol, msg.data);
        break;
      case 'hma_cross_signal':
        this.emit('hma_cross_signal', msg);
        break;
      case 'chain_update':
        this.emit('chain_update', msg.expiry, msg.data);
        break;
      case 'market_context':
        this.emit('market_context', msg.data);
        break;
      case 'heartbeat':
        // Just update lastMessageTs (already done above)
        break;
      case 'connected':
        // Server ACK — already handled in 'open'
        break;
      case 'service_shutdown':
        console.log('[ws-feed] Data service shutting down — will reconnect');
        this.emit('disconnected', 'service_shutdown');
        break;
    }
  }

  private _resubscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const key of this.subscriptions) {
      const parts = key.split(':');
      const msg: any = { action: 'subscribe', channel: parts[0] };
      if (parts[0] === 'contract' && parts[1]) msg.symbol = parts[1];
      if (parts[0] === 'chain' && parts[1]) msg.expiry = parts[1];
      this.ws.send(JSON.stringify(msg));
    }

    if (this.subscriptions.size > 0) {
      console.log(`[ws-feed] Re-subscribed to ${this.subscriptions.size} channel(s)`);
    }
  }

  private _startHeartbeatMonitor(): void {
    this._clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastMessageTs;
      if (elapsed > this.heartbeatTimeoutMs) {
        console.warn(`[ws-feed] No message for ${(elapsed / 1000).toFixed(0)}s — reconnecting`);
        if (this.ws) {
          try { this.ws.close(); } catch {}
        }
      }
    }, 30_000);
  }

  private _scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[ws-feed] Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`);
      this.running = false;
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
    console.log(`[ws-feed] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this._connect();
    }, delay);
  }

  private _clearTimers(): void {
    this._clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _subKey(channel: string, symbol?: string, expiry?: string): string {
    if (channel === 'contract' && symbol) return `contract:${symbol}`;
    if (channel === 'chain' && expiry) return `chain:${expiry}`;
    return channel;
  }
}

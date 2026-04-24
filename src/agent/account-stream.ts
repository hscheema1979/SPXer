/**
 * Tradier Account Event Stream — real-time order fill notifications.
 *
 * Connects to wss://ws.tradier.com/v1/accounts/events and receives
 * order lifecycle events (pending, filled, rejected, canceled).
 *
 * The position manager uses this instead of polling waitForFill().
 */

import WebSocket from 'ws';
import axios from 'axios';
import { config } from '../config';

const TRADIER_BASE = 'https://api.tradier.com/v1';
const WS_URL = 'wss://ws.tradier.com/v1/accounts/events';

export interface AccountOrderEvent {
  id: number;
  event: 'order';
  status: 'pending' | 'open' | 'filled' | 'partial' | 'rejected' | 'canceled' | 'expired';
  type: string;
  price: number;
  stop_price: number;
  avg_fill_price: number;
  executed_quantity: number;
  last_fill_quantity: number;
  remaining_quantity: number;
  transaction_date: string;
  create_date: string;
  account: string;
  option_symbol?: string;
  side?: string;
  class?: string;
}

export type AccountEventCallback = (event: AccountOrderEvent) => void;

export class AccountStream {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private callback: AccountEventCallback | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTs = 0;
  private accountId: string;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  onEvent(cb: AccountEventCallback): void {
    this.callback = cb;
  }

  get lastActivity(): number {
    return this.lastMessageTs;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  private async createSession(): Promise<string | null> {
    try {
      const resp = await axios.post(
        `${TRADIER_BASE}/accounts/events/session`,  // Generic endpoint (account-specific doesn't exist)
        null,
        {
          headers: {
            Authorization: `Bearer ${config.tradierToken}`,
            Accept: 'application/json',
          },
          timeout: 10000,
        },
      );
      const sid = resp.data?.stream?.sessionid;
      if (sid) console.log(`[account-stream] Session: ${sid.slice(0, 12)}...`);
      return sid ?? null;
    } catch (e: any) {
      console.error(`[account-stream] Session creation failed: ${e.message}`);
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    this.sessionId = await this.createSession();
    if (!this.sessionId) {
      console.error('[account-stream] No session ID — cannot connect');
      this.scheduleReconnect();
      return;
    }

    this.ws = new WebSocket(WS_URL);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('ws null'));

      const timeout = setTimeout(() => reject(new Error('connect timeout')), 10_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.ws!.send(JSON.stringify({
          events: ['order'],
          sessionid: this.sessionId,
          linebreak: true,  // Tradier requires this for proper message formatting
        }));
        console.log('[account-stream] Connected — listening for order events');
        this.reconnectAttempts = 0;
        this.startHeartbeatMonitor();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.lastMessageTs = Date.now();
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        console.log(`[account-stream] Disconnected: ${code} ${reason}`);
        if (this.running) this.scheduleReconnect();
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[account-stream] Error: ${err.message}`);
        reject(err);
      });
    });
  }

  private handleMessage(raw: string): void {
    try {
      const lines = raw.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const msg = JSON.parse(trimmed);

        if (msg.event === 'order' && msg.status && msg.id) {
          const event: AccountOrderEvent = {
            id: msg.id,
            event: 'order',
            status: msg.status,
            type: msg.type || '',
            price: parseFloat(msg.price) || 0,
            stop_price: parseFloat(msg.stop_price) || 0,
            avg_fill_price: parseFloat(msg.avg_fill_price) || 0,
            executed_quantity: parseFloat(msg.executed_quantity) || 0,
            last_fill_quantity: parseFloat(msg.last_fill_quantity) || 0,
            remaining_quantity: parseFloat(msg.remaining_quantity) || 0,
            transaction_date: msg.transaction_date || '',
            create_date: msg.create_date || '',
            account: msg.account || '',
            option_symbol: msg.option_symbol,
            side: msg.side,
            class: msg.class,
          };

          if (this.callback) this.callback(event);
        }
      }
    } catch {
    }
  }

  private startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const staleMs = Date.now() - this.lastMessageTs;
      if (this.lastMessageTs > 0 && staleMs > 300_000) {
        console.warn(`[account-stream] No messages for ${(staleMs / 1000).toFixed(0)}s — reconnecting`);
        this.ws?.close();
      }
    }, 60_000);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[account-stream] Max reconnects (${this.maxReconnectAttempts}) — giving up`);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    console.log(`[account-stream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

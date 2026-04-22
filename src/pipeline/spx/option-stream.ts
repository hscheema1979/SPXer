/**
 * WebSocket Streaming Client for Options Contracts
 *
 * Opens a WebSocket connection to wss://ws.tradier.com/v1/markets/events
 * for real-time trade/quote updates on options contracts. Unlike the HTTP
 * streaming PriceStream, WebSocket allows symbol updates without reconnection.
 *
 * Usage:
 *   const stream = new OptionStream();
 *   stream.onTick((tick) => candleBuilder.processTick(...));
 *   const pool = OptionStream.buildContractPool(6500, 100, 5, ['2026-04-01', '2026-04-02']);
 *   await stream.start(pool);
 *   // later (no reconnect needed):
 *   stream.updateSymbols(newPool);
 *   // when done:
 *   stream.stop();
 *
 * Architecture:
 *   1. POST /v1/markets/events/session → get sessionId (5-min TTL)
 *   2. Connect wss://ws.tradier.com/v1/markets/events
 *   3. Send subscription: { symbols, sessionid, filter: ['trade','quote'], linebreak: true }
 *   4. Parse JSON lines, fire onTick callback for each trade/quote
 *   5. Auto-reconnect with exponential backoff (max 20 attempts)
 *   6. Heartbeat monitor — reconnect if no messages for 60s during RTH
 */

import WebSocket from 'ws';
import { config } from '../../config';

const TRADIER_BASE = 'https://api.tradier.com/v1';
const WS_URL = 'wss://ws.tradier.com/v1/markets/events';

export interface StreamTick {
  type: 'trade' | 'quote';
  symbol: string;
  price?: number;    // trade: last price
  size?: number;     // trade: volume
  bid?: number;      // quote: bid price
  ask?: number;      // quote: ask price
  ts: number;        // unix ms
}

type TickCallback = (tick: StreamTick) => void;

export class OptionStream {
  private connections: Array<{
    ws: WebSocket | null;
    sessionId: string | null;
    symbols: string[];
    heartbeatTimer: NodeJS.Timeout | null;
    lastMessageTs: number;
  }> = [];
  private symbols: string[] = [];
  private callback: TickCallback | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Max symbols per Tradier WS session — their server silently drops extras above this */
  private static readonly BATCH_SIZE = 50;

  /** Per-symbol latest tick price cache */
  private prices = new Map<string, { last: number; bid: number; ask: number; ts: number }>();

  /** Register callback for tick events */
  onTick(cb: TickCallback): void {
    this.callback = cb;
  }

  /** Get cached latest price for a symbol */
  getPrice(symbol: string): { last: number; bid: number; ask: number } | null {
    return this.prices.get(symbol) ?? null;
  }

  /**
   * Build the contract pool centered on a price.
   *
   * Generates OCC-format option symbols for all strikes within ±band of centerPrice,
   * at the given interval, for both calls and puts, across all provided expiries.
   *
   * @param centerPrice — price to center the pool on (e.g., estimated SPX from ES)
   * @param band — points above and below center to include (default: 100)
   * @param interval — strike interval in dollars (default: 5)
   * @param expiries — expiry dates as 'YYYY-MM-DD' strings
   * @param optionPrefix — symbol prefix (default: 'SPXW')
   * @returns array of OCC option symbols
   */
  static buildContractPool(
    centerPrice: number,
    band: number = 100,
    interval: number = 5,
    expiries: string[] = [],
    optionPrefix: string = 'SPXW',
  ): string[] {
    if (expiries.length === 0) return [];
    if (interval <= 0) return [];

    const center = Math.round(centerPrice / interval) * interval;
    const symbols: string[] = [];

    for (const expiry of expiries) {
      // Convert 'YYYY-MM-DD' → 'YYMMDD'
      const expiryCode = expiry.replace(/-/g, '').slice(2); // '2026-04-01' → '260401'

      for (let strike = center - band; strike <= center + band; strike += interval) {
        if (strike <= 0) continue;
        const strikeCode = String(strike * 1000).padStart(8, '0');
        symbols.push(`${optionPrefix}${expiryCode}C${strikeCode}`); // call
        symbols.push(`${optionPrefix}${expiryCode}P${strikeCode}`); // put
      }
    }

    return symbols;
  }

  /** Start streaming for the given symbols (batched into ≤50 per WS connection) */
  async start(symbols: string[]): Promise<void> {
    this.symbols = symbols;
    this.running = true;
    this.reconnectAttempts = 0;
    await this.connectAll();
  }

  /**
   * Update subscription — rebatches symbols into ≤50-per-connection groups.
   * Connections whose symbol set changed send a new subscription payload;
   * excess connections are torn down; missing connections are created.
   */
  updateSymbols(symbols: string[]): void {
    this.symbols = symbols;
    const batches = this.buildBatches(symbols);
    // Match existing connections to new batches by index
    while (this.connections.length > batches.length) {
      const conn = this.connections.pop()!;
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
      if (conn.ws) conn.ws.close();
    }
    for (let i = 0; i < batches.length; i++) {
      if (i < this.connections.length) {
        const conn = this.connections[i];
        conn.symbols = batches[i];
        if (conn.ws?.readyState === WebSocket.OPEN && conn.sessionId) {
          conn.ws.send(JSON.stringify({
            symbols: conn.symbols,
            sessionid: conn.sessionId,
            filter: ['trade', 'quote'],
            linebreak: true,
            validOnly: true,
          }));
        }
      } else {
        // New batch needed — start a new connection
        this.startConnection(batches[i], this.connections.length);
      }
    }
    console.log(`[option-stream] Updated subscription: ${symbols.length} symbols across ${batches.length} connections`);
  }

  /** Stop streaming and clean up all connections */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const conn of this.connections) {
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
      if (conn.ws) conn.ws.close();
    }
    this.connections = [];
    this.prices.clear();
    console.log('[option-stream] Stopped');
  }

  /** Whether at least one WebSocket connection is currently connected */
  isConnected(): boolean {
    return this.connections.some(c => c.ws?.readyState === WebSocket.OPEN);
  }

  /** Total number of symbols currently subscribed across all connections */
  get symbolCount(): number {
    return this.connections.reduce((sum, c) => sum + c.symbols.length, 0);
  }

  /** Timestamp of the last received message across all connections */
  get lastActivity(): number {
    return Math.max(0, ...this.connections.map(c => c.lastMessageTs));
  }

  /** Split symbols into batches of ≤BATCH_SIZE */
  private buildBatches(symbols: string[]): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < symbols.length; i += OptionStream.BATCH_SIZE) {
      batches.push(symbols.slice(i, i + OptionStream.BATCH_SIZE));
    }
    return batches;
  }

  private async connectAll(): Promise<void> {
    if (!this.running || this.symbols.length === 0) return;
    const batches = this.buildBatches(this.symbols);
    this.connections = [];
    const promises = batches.map((batch, idx) => this.startConnection(batch, idx));
    await Promise.allSettled(promises);
  }

  /** Start a single WS connection for a batch of symbols. Returns when connected or failed. */
  private async startConnection(symbols: string[], batchIndex: number): Promise<void> {
    if (!this.running) return;

    const conn: typeof this.connections[0] = {
      ws: null,
      sessionId: null,
      symbols,
      heartbeatTimer: null,
      lastMessageTs: 0,
    };
    this.connections[batchIndex] = conn;

    try {
      conn.sessionId = await this.createSession();
      if (!conn.sessionId) return;

      conn.ws = new WebSocket(WS_URL);

      await new Promise<void>((resolve, reject) => {
        if (!conn.ws) return reject(new Error('ws null'));

        conn.ws.on('open', () => {
          conn.ws!.send(JSON.stringify({
            symbols: conn.symbols,
            sessionid: conn.sessionId,
            filter: ['trade', 'quote'],
            linebreak: true,
            validOnly: true,
          }));
          console.log(`[option-stream] Batch ${batchIndex}: connected — ${conn.symbols.length} symbols`);
          resolve();
        });

        conn.ws.on('message', (data: Buffer) => {
          conn.lastMessageTs = Date.now();
          const raw = data.toString();
          const lines = raw.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.handleMessage(trimmed);
          }
        });

        conn.ws.on('close', (code, reason) => {
          console.log(`[option-stream] Batch ${batchIndex}: disconnected: ${code} ${reason}`);
          if (this.running) this.scheduleReconnect();
        });

        conn.ws.on('error', (err) => {
          console.error(`[option-stream] Batch ${batchIndex}: error: ${err.message}`);
          reject(err);
        });

        setTimeout(() => reject(new Error('connect timeout')), 10_000);
      });

      this.reconnectAttempts = 0;
      this.startHeartbeatMonitor(conn, batchIndex);
    } catch (e: any) {
      console.error(`[option-stream] Batch ${batchIndex}: connect failed: ${e.message}`);
      if (this.running) this.scheduleReconnect();
    }
  }

  /** Parse incoming JSON messages and dispatch to callback + price cache */
  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'trade' || msg.type === 'timesale') {
        const price = parseFloat(msg.price || msg.last) || 0;
        const size = parseInt(msg.size) || 0;
        const ts = parseInt(msg.date) || Date.now();

        if (price > 0) {
          // Update price cache
          const existing = this.prices.get(msg.symbol);
          this.prices.set(msg.symbol, {
            last: price,
            bid: existing?.bid ?? price,
            ask: existing?.ask ?? price,
            ts,
          });

          // Fire callback
          if (this.callback) {
            this.callback({
              type: 'trade',
              symbol: msg.symbol,
              price,
              size,
              ts,
            });
          }
        }
      } else if (msg.type === 'quote') {
        const bid = parseFloat(msg.bid) || 0;
        const ask = parseFloat(msg.ask) || 0;
        const ts = parseInt(msg.biddate || msg.askdate) || Date.now();

        if (bid > 0 || ask > 0) {
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask);
          const existing = this.prices.get(msg.symbol);
          this.prices.set(msg.symbol, {
            last: existing?.last ?? mid,
            bid,
            ask,
            ts,
          });

          // Fire callback
          if (this.callback) {
            this.callback({
              type: 'quote',
              symbol: msg.symbol,
              bid,
              ask,
              ts,
            });
          }
        }
      }
      // Ignore heartbeats and other message types silently
    } catch {
      // Malformed JSON — skip
    }
  }

  /** Create a Tradier streaming session (5-min TTL to connect) */
  private async createSession(): Promise<string | null> {
    try {
      const resp = await fetch(`${TRADIER_BASE}/markets/events/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.tradierToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const data = (await resp.json()) as any;
      const sid = data?.stream?.sessionid;
      if (sid) {
        console.log(`[option-stream] Session: ${sid.slice(0, 12)}...`);
      }
      return sid ?? null;
    } catch (e: any) {
      console.error(`[option-stream] Session creation failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Heartbeat monitor — detect stale streams on a single connection.
   * If no messages for 60s during RTH, force reconnect on that batch.
   */
  private startHeartbeatMonitor(conn: typeof this.connections[0], batchIndex: number): void {
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
    conn.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const staleMs = Date.now() - conn.lastMessageTs;
      if (staleMs > 60_000) {
        console.warn(
          `[option-stream] Batch ${batchIndex}: no data for ${(staleMs / 1000).toFixed(0)}s — reconnecting`,
        );
        conn.ws?.close();
      }
    }, 15_000);
  }

  /** Schedule a reconnection with exponential backoff — reconnects all batches */
  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(
        `[option-stream] Max reconnects (${this.maxReconnectAttempts}) — falling back to polling`,
      );
      this.running = false;
      return; // caller should detect this and activate pollOptions() fallback
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    console.log(
      `[option-stream] Reconnecting all batches in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => this.connectAll(), delay);
  }
}

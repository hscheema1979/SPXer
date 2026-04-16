/**
 * HTTP Streaming Price Feed from Tradier
 *
 * Opens a long-lived HTTP connection to stream.tradier.com for real-time
 * quote/trade updates on specific symbols. Used by agents to monitor
 * TP/SL on open positions without polling gaps.
 *
 * Usage:
 *   const stream = new PriceStream();
 *   stream.onPrice((symbol, price, bid, ask) => { ... });
 *   await stream.start(['SPXW260331C06460000', 'SPX']);
 *   // later:
 *   await stream.updateSymbols(['SPXW260331P06420000', 'SPX']);
 *   // when done:
 *   stream.stop();
 *
 * Architecture:
 *   1. POST /markets/events/session → get sessionId
 *   2. GET stream.tradier.com/v1/markets/events?sessionid=X&symbols=Y&filter=quote,trade
 *   3. Parse JSON lines as they arrive
 *   4. Call onPrice callback with latest price
 *   5. Auto-reconnect on disconnect
 */

import { config } from '../config';

const TRADIER_BASE = 'https://api.tradier.com/v1';
const STREAM_BASE = 'https://stream.tradier.com/v1';

type PriceCallback = (symbol: string, last: number, bid: number, ask: number) => void;

export class PriceStream {
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private callback: PriceCallback | null = null;
  private symbols: string[] = [];
  private running = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private prices = new Map<string, { last: number; bid: number; ask: number; ts: number }>();

  /** Register callback for price updates */
  onPrice(cb: PriceCallback): void {
    this.callback = cb;
  }

  /** Get latest cached price for a symbol */
  getPrice(symbol: string): { last: number; bid: number; ask: number } | null {
    return this.prices.get(symbol) ?? null;
  }

  /** Is the stream currently connected and receiving data? */
  isConnected(): boolean {
    return this.running && !this.reconnecting;
  }

  /** Start streaming for the given symbols */
  async start(symbols: string[]): Promise<void> {
    this.symbols = symbols;
    this.running = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /** Update the symbol list — requires reconnect for HTTP streaming */
  async updateSymbols(symbols: string[]): Promise<void> {
    if (this.arraysEqual(this.symbols, symbols)) return;
    this.symbols = symbols;
    console.log(`[stream] Updating symbols: ${symbols.join(', ')}`);
    // HTTP streaming can't update symbols on the fly — must reconnect
    this.disconnect();
    if (this.running) {
      await this.connect();
    }
  }

  /** Stop streaming */
  stop(): void {
    this.running = false;
    this.disconnect();
    this.prices.clear();
    console.log('[stream] Stopped');
  }

  private disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || this.symbols.length === 0) return;

    try {
      // Step 1: Create streaming session
      this.sessionId = await this.createSession();
      if (!this.sessionId) {
        console.error('[stream] Failed to create session');
        this.scheduleReconnect();
        return;
      }

      // Step 2: Open HTTP stream
      this.abortController = new AbortController();
      const params = new URLSearchParams({
        sessionid: this.sessionId,
        symbols: this.symbols.join(','),
        filter: 'quote,trade',
        linebreak: 'true',
        validOnly: 'true',
      });

      const url = `${STREAM_BASE}/markets/events?${params}`;
      console.log(`[stream] Connecting: ${this.symbols.join(', ')}`);

      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: this.abortController.signal,
      });

      if (!response.ok || !response.body) {
        console.error(`[stream] HTTP ${response.status}: ${response.statusText}`);
        this.scheduleReconnect();
        return;
      }

      this.reconnecting = false;
      this.reconnectAttempts = 0;
      console.log('[stream] Connected — receiving prices');

      // Step 3: Read stream line by line
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleMessage(trimmed);
        }
      }

      reader.releaseLock();
    } catch (e: any) {
      if (e.name === 'AbortError') {
        // Intentional disconnect
        return;
      }
      console.error(`[stream] Error: ${e.message}`);
    }

    // If we get here and still running, reconnect
    if (this.running) {
      this.scheduleReconnect();
    }
  }

  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line);

      if (msg.type === 'quote') {
        const bid = parseFloat(msg.bid) || 0;
        const ask = parseFloat(msg.ask) || 0;
        const mid = (bid + ask) / 2;
        this.prices.set(msg.symbol, { last: mid, bid, ask, ts: Date.now() });
        if (this.callback) {
          this.callback(msg.symbol, mid, bid, ask);
        }
      } else if (msg.type === 'trade' || msg.type === 'timesale') {
        const price = parseFloat(msg.price || msg.last) || 0;
        if (price > 0) {
          const existing = this.prices.get(msg.symbol);
          this.prices.set(msg.symbol, {
            last: price,
            bid: existing?.bid ?? price,
            ask: existing?.ask ?? price,
            ts: Date.now(),
          });
          if (this.callback) {
            this.callback(msg.symbol, price, existing?.bid ?? price, existing?.ask ?? price);
          }
        }
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  private async createSession(): Promise<string | null> {
    try {
      const response = await fetch(`${TRADIER_BASE}/markets/events/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.tradierToken}`,
          Accept: 'application/json',
        },
      });
      const data = await response.json() as any;
      const sessionId = data?.stream?.sessionid;
      if (sessionId) {
        console.log(`[stream] Session created: ${sessionId.slice(0, 12)}...`);
      }
      return sessionId ?? null;
    } catch (e: any) {
      console.error(`[stream] Session creation failed: ${e.message}`);
      return null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnecting = true;
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[stream] Max reconnect attempts (${this.maxReconnectAttempts}) — giving up`);
      this.running = false;
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`[stream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }
}

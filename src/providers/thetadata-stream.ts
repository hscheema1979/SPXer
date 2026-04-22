/**
 * ThetaData WebSocket streaming client for options contracts.
 *
 * Connects to the locally-running ThetaTerminal at ws://127.0.0.1:25520/v1/events
 * and delivers tick-level trade + quote events for a dynamic pool of SPXW option
 * symbols. Tick format matches the existing `OptionStream.StreamTick` shape so
 * this can be a drop-in alternative upstream of `OptionCandleBuilder`.
 *
 * Protocol (from https://http-docs.thetadata.us/Streaming/US-Options/):
 *   Endpoint:  ws://127.0.0.1:25520/v1/events   (SINGLE connection — cannot multiplex)
 *   Subscribe: { msg_type:"STREAM", sec_type:"OPTION", req_type:"TRADE"|"QUOTE",
 *                add: true, id: <incrementing>,
 *                contract: { root, expiration:YYYYMMDD, strike:×1000, right:"C"|"P" } }
 *   Unsub:     same payload with add:false
 *   Incoming trade: { header:{type:"TRADE"}, contract, trade:{ms_of_day, price, size, date, ...} }
 *   Incoming quote: { header:{type:"QUOTE"}, contract, quote:{ms_of_day, bid, ask, date, ...} }
 *   Status:    { header:{status:"CONNECTED", type:"STATUS"} } every ~1s (keepalive)
 *
 * Notes
 *   - Must send TWO subscriptions per contract (TRADE + QUOTE). Each must have a
 *     unique incrementing id.
 *   - Strike returns in thousandths-of-a-dollar (6500000 = $6500), same as our
 *     canonical symbol's strike1000.
 *   - ms_of_day + date are ET-wall-clock; we convert to Unix ms using the same
 *     ET-offset logic that lives in thetadata.ts.
 */

import WebSocket from 'ws';
import { parseOptionSymbol } from './thetadata';

/**
 * Build the full ThetaTerminal WS URL.
 * Accepts env values with or without a trailing path — always ensures `/v1/events`.
 */
function resolveWsUrl(): string {
  const raw = process.env.THETADATA_WS_URL || 'ws://127.0.0.1:25520';
  // If the URL already includes a path beyond "/", respect it. Otherwise append /v1/events.
  try {
    const u = new URL(raw);
    if (u.pathname && u.pathname !== '/' && u.pathname !== '') return raw;
    return raw.replace(/\/+$/, '') + '/v1/events';
  } catch {
    return raw.replace(/\/+$/, '') + '/v1/events';
  }
}
const WS_URL = resolveWsUrl();

/** Tick event — matches the shape emitted by src/pipeline/option-stream.ts */
export interface StreamTick {
  type: 'trade' | 'quote';
  symbol: string;
  price?: number;
  size?: number;
  bid?: number;
  ask?: number;
  ts: number; // Unix ms
}

type TickCallback = (tick: StreamTick) => void;

/** Convert ThetaData (date=YYYYMMDD, ms_of_day=ms since ET midnight) → Unix ms. */
export function thetaTsToUnixMs(date: number, msOfDay: number): number {
  const y = Math.floor(date / 10000);
  const m = Math.floor((date % 10000) / 100);
  const d = date % 100;
  const utcMidnight = Date.UTC(y, m - 1, d);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  });
  const etHourAtNoonUTC = parseInt(etFormatter.format(noon), 10); // 7 EDT or 8 EST
  const etOffsetMs = (12 - etHourAtNoonUTC) * 3_600_000;
  return utcMidnight + etOffsetMs + msOfDay;
}

/** Build the ThetaData subscription contract from an OCC symbol, or null if unparseable. */
function symbolToContract(symbol: string): { root: string; expiration: number; strike: number; right: 'C' | 'P' } | null {
  const p = parseOptionSymbol(symbol);
  if (!p) return null;
  return { root: p.root, expiration: p.expYYYYMMDD, strike: p.strike1000, right: p.right };
}

/** Rebuild an OCC symbol from the ThetaData contract payload. */
function contractToSymbol(c: { root: string; expiration: number; strike: number; right: string }): string {
  const yymmdd = String(c.expiration).slice(2); // 20240315 → "240315"
  const strikeCode = String(c.strike).padStart(8, '0');
  return `${c.root}${yymmdd}${c.right}${strikeCode}`;
}

export class ThetaDataStream {
  private ws: WebSocket | null = null;
  private symbols = new Set<string>();
  private callback: TickCallback | null = null;
  private running = false;
  private connected = false;
  private nextReqId = 1;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Any frame, including STATUS keepalives — used to detect dead connections. */
  private lastFrameTs = 0;
  /** Real market data only (TRADE or QUOTE) — used for `lastActivity` primary-source check. */
  private lastDataTs = 0;

  /** Per-symbol latest tick price cache. */
  private prices = new Map<string, { last: number; bid: number; ask: number; ts: number; size: number }>();

  /** Register callback for tick events. */
  onTick(cb: TickCallback): void {
    this.callback = cb;
  }

  /** Get cached latest price for a symbol. */
  getPrice(symbol: string): { last: number; bid: number; ask: number } | null {
    const p = this.prices.get(symbol);
    return p ? { last: p.last, bid: p.bid, ask: p.ask } : null;
  }

  /** Whether the WebSocket is currently connected. */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Number of symbols currently subscribed. */
  get symbolCount(): number {
    return this.symbols.size;
  }

  /** Timestamp of the last market data frame (TRADE or QUOTE). */
  get lastActivity(): number {
    return this.lastDataTs;
  }

  /** Start streaming for the given symbols. */
  async start(symbols: string[]): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    for (const s of symbols) this.symbols.add(s);
    await this.connect();
  }

  /**
   * Update the subscribed symbol set. Sends per-contract add/remove messages
   * for the diff — no reconnect needed.
   */
  updateSymbols(symbols: string[]): void {
    const next = new Set(symbols);
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const s of next) if (!this.symbols.has(s)) toAdd.push(s);
    for (const s of this.symbols) if (!next.has(s)) toRemove.push(s);

    if (this.ws?.readyState === WebSocket.OPEN) {
      for (const s of toRemove) this.sendSubscription(s, false);
      for (const s of toAdd) this.sendSubscription(s, true);
    }

    this.symbols = next;
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log(`[thetadata-stream] Updated subscription: +${toAdd.length} / -${toRemove.length} (total ${this.symbols.size})`);
    }
  }

  /** Stop streaming and clean up. */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.prices.clear();
    console.log('[thetadata-stream] Stopped');
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastFrameTs = Date.now();
        console.log(`[thetadata-stream] Connected to ${WS_URL} — subscribing to ${this.symbols.size} symbols`);
        // Send one TRADE + one QUOTE subscription per symbol
        for (const s of this.symbols) this.sendSubscription(s, true);
        this.startHeartbeatMonitor();
        this.startPingKeepalive();
      });

      this.ws.on('message', (data: Buffer) => {
        this.lastFrameTs = Date.now(); // any frame (incl. STATUS) keeps the connection "alive"
        const raw = data.toString();
        // ThetaData sends newline-delimited JSON frames
        const lines = raw.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleMessage(trimmed);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        console.log(`[thetadata-stream] Disconnected: ${code} ${reason?.toString?.() ?? ''}`);
        if (this.running) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[thetadata-stream] Error: ${err.message}`);
      });
    } catch (e: any) {
      console.error(`[thetadata-stream] Connect failed: ${e.message}`);
      this.scheduleReconnect();
    }
  }

  /** Send a TRADE+QUOTE subscribe (or unsubscribe) for one symbol. */
  private sendSubscription(symbol: string, add: boolean): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const contract = symbolToContract(symbol);
    if (!contract) {
      console.warn(`[thetadata-stream] Unparseable symbol: ${symbol}`);
      return;
    }
    for (const req_type of ['TRADE', 'QUOTE'] as const) {
      const payload = {
        msg_type: 'STREAM',
        sec_type: 'OPTION',
        req_type,
        add,
        id: this.nextReqId++,
        contract,
      };
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e: any) {
        console.error(`[thetadata-stream] send failed for ${symbol} ${req_type}: ${e.message}`);
      }
    }
  }

  /** Parse one incoming JSON frame. */
  private handleMessage(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const type = msg?.header?.type;
    if (!type || type === 'STATUS') return;

    const c = msg.contract;
    if (!c) return;
    const symbol = contractToSymbol(c);

    if (type === 'TRADE') {
      const t = msg.trade;
      if (!t) return;
      const price = Number(t.price);
      const size = Number(t.size) || 0;
      if (!(price > 0)) return;
      const ts = thetaTsToUnixMs(Number(t.date), Number(t.ms_of_day));

      // Stale-tick guard: reject ticks with backward timestamps.
      // ThetaTerminal can replay historical ticks or send out-of-order on reconnect.
      const existing = this.prices.get(symbol);
      if (existing && ts < existing.ts - 1000) {
        // Allow 1s tolerance for clock drift — beyond that, the tick is stale.
        return;
      }

      // Frozen-price guard: if we see the exact same price+size repeatedly,
      // ThetaTerminal may be replaying a stuck tick. Allow it through but
      // don't reset lastDataTs — this keeps thetaIsPrimary() honest.
      const isFrozen = existing && price === existing.last && size === existing.size && size > 0;
      if (!isFrozen) {
        this.lastDataTs = Date.now();
      }

      this.prices.set(symbol, {
        last: price,
        bid: existing?.bid ?? price,
        ask: existing?.ask ?? price,
        ts,
        size,
      });

      this.callback?.({ type: 'trade', symbol, price, size, ts });
    } else if (type === 'QUOTE') {
      const q = msg.quote;
      if (!q) return;
      const bid = Number(q.bid) || 0;
      const ask = Number(q.ask) || 0;
      if (!(bid > 0 || ask > 0)) return;
      const ts = thetaTsToUnixMs(Number(q.date), Number(q.ms_of_day));

      // Stale-tick guard for quotes too
      const existing = this.prices.get(symbol);
      if (existing && ts < existing.ts - 1000) {
        return;
      }

      this.lastDataTs = Date.now();
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask);
      this.prices.set(symbol, {
        last: existing?.last ?? mid,
        bid,
        ask,
        ts,
        size: existing?.size ?? 0,
      });

      this.callback?.({ type: 'quote', symbol, bid, ask, ts });
    }
  }

  /** Heartbeat monitor — force reconnect if no messages for 60s. */
  private startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const staleMs = Date.now() - this.lastFrameTs;
      if (staleMs > 60_000) {
        console.warn(`[thetadata-stream] No frames for ${(staleMs / 1000).toFixed(0)}s — reconnecting`);
        try { this.ws?.close(); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  /**
   * Send a WebSocket-level ping every 30s while connected. ThetaTerminal's WS
   * server replies with a pong automatically (standard ws protocol). This both
   *   1. Keeps the loopback link "active" for any idle-timeout intermediary.
   *   2. Surfaces broken half-open connections via the ws library's internal
   *      error/close path before the 60s heartbeat-monitor window elapses.
   * Suspect cause of observed ~5-15min 1006 disconnects while the terminal
   * process itself is healthy.
   */
  private startPingKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.running) return;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch { /* ignore — close handler will reconnect */ }
    }, 30_000);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[thetadata-stream] Max reconnects (${this.maxReconnectAttempts}) exceeded — giving up`);
      this.running = false;
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    console.log(`[thetadata-stream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

// Exposed for tests
export const __testing__ = { symbolToContract, contractToSymbol };

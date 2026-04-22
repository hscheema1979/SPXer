/**
 * Unit tests for ThetaDataStream.
 *
 * Covers symbol/contract round-tripping, timestamp conversion (ET → UTC),
 * and message parsing via a stubbed WebSocket. The real ws.WebSocket is not
 * used — we shim it with a controllable emitter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThetaDataStream, thetaTsToUnixMs, __testing__ } from '../../src/providers/thetadata-stream';

const { symbolToContract, contractToSymbol } = __testing__;

// ── Symbol ↔ contract round-trip ─────────────────────────────────────────────
describe('ThetaData symbol ↔ contract', () => {
  it('parses a canonical SPXW OCC symbol into a ThetaData contract', () => {
    const c = symbolToContract('SPXW260319C06610000');
    expect(c).toEqual({ root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' });
  });

  it('parses a put', () => {
    const c = symbolToContract('SPXW260319P06500000');
    expect(c).toEqual({ root: 'SPXW', expiration: 20260319, strike: 6500000, right: 'P' });
  });

  it('rebuilds the OCC symbol from a ThetaData contract payload', () => {
    const sym = contractToSymbol({ root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' });
    expect(sym).toBe('SPXW260319C06610000');
  });

  it('returns null for an unparseable symbol', () => {
    expect(symbolToContract('not-a-symbol')).toBeNull();
  });

  it('round-trips calls and puts across strikes', () => {
    const samples = [
      'SPXW260319C06610000',
      'SPXW260319P06500000',
      'SPXW260401C07000000',
      'SPXW260401P00500000',
    ];
    for (const sym of samples) {
      const c = symbolToContract(sym)!;
      expect(contractToSymbol(c)).toBe(sym);
    }
  });
});

// ── Timestamp conversion ─────────────────────────────────────────────────────
describe('thetaTsToUnixMs', () => {
  it('converts ET 09:30 on an EDT date to the correct UTC Unix ms', () => {
    // 2026-03-19 is EDT (UTC-4). 09:30 ET = 13:30 UTC.
    // ms_of_day = 9*3600_000 + 30*60_000 = 34_200_000
    const ts = thetaTsToUnixMs(20260319, 34_200_000);
    expect(new Date(ts).toISOString()).toBe('2026-03-19T13:30:00.000Z');
  });

  it('converts ET 09:30 on an EST date to the correct UTC Unix ms', () => {
    // 2026-01-15 is EST (UTC-5). 09:30 ET = 14:30 UTC.
    const ts = thetaTsToUnixMs(20260115, 34_200_000);
    expect(new Date(ts).toISOString()).toBe('2026-01-15T14:30:00.000Z');
  });

  it('handles the DST boundary (first EDT day, March 8 2026)', () => {
    // 2026-03-08 is the first EDT day. 12:00 ET = 16:00 UTC.
    const ts = thetaTsToUnixMs(20260308, 12 * 3600_000);
    expect(new Date(ts).toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });
});

// ── Stream lifecycle (with mocked ws) ────────────────────────────────────────
//
// `vi.mock` factories are hoisted above imports, so they cannot reference
// outer-scope variables directly. We stash the latest WebSocket instance on
// globalThis so tests can reach it.

vi.mock('ws', () => {
  const WebSocket: any = function (this: any) {
    const inst: any = {
      readyState: 1, // OPEN
      handlers: new Map<string, (...args: any[]) => void>(),
      send: vi.fn(),
      close: vi.fn(function (this: any) {
        this.readyState = 3;
        this.handlers.get('close')?.(1000, Buffer.from('test'));
      }),
      on(ev: string, cb: (...args: any[]) => void) { this.handlers.set(ev, cb); return this; },
      emit(ev: string, ...args: any[]) { this.handlers.get(ev)?.(...args); },
    };
    (globalThis as any).__mockWs = inst;
    queueMicrotask(() => inst.emit('open'));
    return inst;
  };
  WebSocket.OPEN = 1;
  WebSocket.CLOSED = 3;
  return { default: WebSocket };
});

function getMockWs(): any {
  return (globalThis as any).__mockWs;
}

describe('ThetaDataStream lifecycle', () => {
  beforeEach(() => {
    (globalThis as any).__mockWs = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a TRADE + QUOTE subscription per symbol on connect', async () => {
    const stream = new ThetaDataStream();
    await stream.start(['SPXW260319C06610000', 'SPXW260319P06500000']);
    // Wait one microtask for the mocked 'open' to fire
    await new Promise((r) => setImmediate(r));

    expect(getMockWs().send).toHaveBeenCalled();
    // 2 symbols × 2 req_types (TRADE + QUOTE) = 4 sends
    expect(getMockWs().send.mock.calls.length).toBe(4);

    const payloads = getMockWs().send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    const reqTypes = payloads.map((p: any) => p.req_type).sort();
    expect(reqTypes).toEqual(['QUOTE', 'QUOTE', 'TRADE', 'TRADE']);
    expect(payloads[0]).toMatchObject({
      msg_type: 'STREAM',
      sec_type: 'OPTION',
      add: true,
      contract: { root: 'SPXW', right: 'C' },
    });
    // Each subscription has a unique incrementing id
    const ids = payloads.map((p: any) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    stream.stop();
  });

  it('emits trade ticks when TRADE messages arrive', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    // Emit a trade message
    const tradeMsg = {
      header: { status: 'CONNECTED', type: 'TRADE' },
      contract: { security_type: 'OPTION', root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' },
      trade: { ms_of_day: 34_200_000, sequence: 1, size: 5, condition: 18, price: 1.25, exchange: 31, date: 20260319 },
    };
    getMockWs().emit('message', Buffer.from(JSON.stringify(tradeMsg)));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      type: 'trade',
      symbol: 'SPXW260319C06610000',
      price: 1.25,
      size: 5,
    });
    expect(new Date(ticks[0].ts).toISOString()).toBe('2026-03-19T13:30:00.000Z');

    // Price cache populated
    expect(stream.getPrice('SPXW260319C06610000')).toMatchObject({ last: 1.25 });

    stream.stop();
  });

  it('emits quote ticks and updates bid/ask cache', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    const quoteMsg = {
      header: { status: 'CONNECTED', type: 'QUOTE' },
      contract: { security_type: 'OPTION', root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' },
      quote: { ms_of_day: 34_200_000, bid: 1.20, ask: 1.30, bid_size: 10, ask_size: 10, date: 20260319 },
    };
    getMockWs().emit('message', Buffer.from(JSON.stringify(quoteMsg)));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ type: 'quote', bid: 1.20, ask: 1.30 });
    expect(stream.getPrice('SPXW260319C06610000')).toEqual(expect.objectContaining({ bid: 1.20, ask: 1.30 }));

    stream.stop();
  });

  it('ignores STATUS keepalive messages', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    const statusMsg = { header: { status: 'CONNECTED', type: 'STATUS' } };
    getMockWs().emit('message', Buffer.from(JSON.stringify(statusMsg)));

    expect(ticks).toHaveLength(0);
    stream.stop();
  });

  it('drops trades with non-positive price', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    const badTrade = {
      header: { type: 'TRADE' },
      contract: { root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' },
      trade: { ms_of_day: 100, price: 0, size: 1, date: 20260319 },
    };
    getMockWs().emit('message', Buffer.from(JSON.stringify(badTrade)));
    expect(ticks).toHaveLength(0);

    stream.stop();
  });

  it('updateSymbols sends diff subscriptions without reconnect', async () => {
    const stream = new ThetaDataStream();
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));
    // Initial 2 sends (TRADE + QUOTE for 1 symbol)
    expect(getMockWs().send.mock.calls.length).toBe(2);

    stream.updateSymbols(['SPXW260319C06610000', 'SPXW260319P06500000']);
    // +1 symbol added → 2 more sends. No unsubscribes.
    expect(getMockWs().send.mock.calls.length).toBe(4);
    const lastTwo = getMockWs().send.mock.calls.slice(2).map((c: any[]) => JSON.parse(c[0]));
    for (const p of lastTwo) {
      expect(p.add).toBe(true);
      expect(p.contract.root).toBe('SPXW');
      expect(p.contract.right).toBe('P');
    }

    // Now remove one
    stream.updateSymbols(['SPXW260319P06500000']);
    // -1 symbol → 2 unsub sends
    expect(getMockWs().send.mock.calls.length).toBe(6);
    const unsubs = getMockWs().send.mock.calls.slice(4).map((c: any[]) => JSON.parse(c[0]));
    for (const p of unsubs) {
      expect(p.add).toBe(false);
      expect(p.contract.right).toBe('C');
    }

    stream.stop();
  });

  it('parses multiple newline-delimited JSON frames in one message', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    const m1 = {
      header: { type: 'TRADE' },
      contract: { root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' },
      trade: { ms_of_day: 100, price: 1.0, size: 1, date: 20260319 },
    };
    const m2 = {
      header: { type: 'TRADE' },
      contract: { root: 'SPXW', expiration: 20260319, strike: 6610000, right: 'C' },
      trade: { ms_of_day: 200, price: 1.1, size: 2, date: 20260319 },
    };
    getMockWs().emit('message', Buffer.from(JSON.stringify(m1) + '\n' + JSON.stringify(m2)));
    expect(ticks).toHaveLength(2);
    expect(ticks.map((t) => t.price)).toEqual([1.0, 1.1]);

    stream.stop();
  });

  it('tolerates malformed JSON frames without throwing', async () => {
    const stream = new ThetaDataStream();
    const ticks: any[] = [];
    stream.onTick((t) => ticks.push(t));
    await stream.start(['SPXW260319C06610000']);
    await new Promise((r) => setImmediate(r));

    expect(() => getMockWs().emit('message', Buffer.from('not-json'))).not.toThrow();
    expect(ticks).toHaveLength(0);
    stream.stop();
  });

  it('reports symbolCount and isConnected correctly', async () => {
    const stream = new ThetaDataStream();
    expect(stream.isConnected()).toBe(false);
    expect(stream.symbolCount).toBe(0);

    await stream.start(['SPXW260319C06610000', 'SPXW260319P06500000']);
    await new Promise((r) => setImmediate(r));
    expect(stream.isConnected()).toBe(true);
    expect(stream.symbolCount).toBe(2);

    stream.stop();
    expect(stream.isConnected()).toBe(false);
  });
});

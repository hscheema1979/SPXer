/**
 * Test script: Stream options tick data via Tradier HTTP streaming.
 * 
 * Run during market hours (9:30-4:15 ET):
 *   npx tsx scripts/test-options-stream.ts
 *
 * What it does:
 *   1. Gets current SPX price from the data service
 *   2. Builds a ±100 point strike pool around SPX (calls + puts, $5 intervals)
 *   3. Opens HTTP stream for all those contracts + SPX
 *   4. Builds 1m candles from tick data
 *   5. Reports stats every 30s: messages/sec, symbols seen, candle counts
 *   6. After 5 minutes, compares tick-built candles vs poll-built candles
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { config } from '../src/config';
import { todayET, nowET } from '../src/utils/et-time';

const TRADIER_BASE = 'https://api.tradier.com/v1';
const STREAM_BASE = 'https://stream.tradier.com/v1';
const SPXER_BASE = 'http://localhost:3600';

// ── Build the contract pool ────────────────────────────────────────────

function buildSymbolPool(spxPrice: number, expiry: string): string[] {
  const rounded = Math.round(spxPrice / 5) * 5;
  const symbols: string[] = [];
  
  // ±100 points in $5 increments = 40 strikes × 2 sides = ~80 contracts per expiry
  for (let offset = -100; offset <= 100; offset += 5) {
    const strike = rounded + offset;
    const strikeStr = (strike * 1000).toString().padStart(8, '0');
    const dateStr = expiry.replace(/-/g, '').slice(2); // 2026-04-02 → 260402
    symbols.push(`SPXW${dateStr}C${strikeStr}`);
    symbols.push(`SPXW${dateStr}P${strikeStr}`);
  }
  
  return symbols;
}

// ── Candle builder ──────────────────────────────────────────────────────

interface Candle {
  minuteTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
}

const candles = new Map<string, Candle>(); // symbol → current forming candle
const closedCandles = new Map<string, Candle[]>(); // symbol → completed candles

function handleTick(symbol: string, price: number): void {
  if (price <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const minuteTs = now - (now % 60);
  
  let candle = candles.get(symbol);
  if (!candle || candle.minuteTs !== minuteTs) {
    // Close previous candle
    if (candle && candle.ticks > 0) {
      if (!closedCandles.has(symbol)) closedCandles.set(symbol, []);
      closedCandles.get(symbol)!.push({ ...candle });
    }
    // Start new candle
    candle = { minuteTs, open: price, high: price, low: price, close: price, ticks: 0 };
    candles.set(symbol, candle);
  }
  
  if (price > candle.high) candle.high = price;
  if (price < candle.low) candle.low = price;
  candle.close = price;
  candle.ticks++;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { h, m } = nowET();
  console.log(`\nCurrent ET time: ${h}:${String(m).padStart(2, '0')}`);
  
  if (h < 9 || (h === 9 && m < 30) || h >= 16) {
    console.log('⚠️  Market is closed. Run this during RTH (9:30-4:15 ET) for meaningful results.\n');
  }

  // 1. Get SPX price
  const snapResp = await fetch(`${SPXER_BASE}/spx/snapshot`);
  const snap = await snapResp.json() as any;
  const spxPrice = snap.close || snap.last || 0;
  console.log(`SPX price: $${spxPrice.toFixed(2)}`);

  // 2. Build symbol pool
  const today = todayET();
  // Next trading day for 1DTE
  const d = new Date(today + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  
  const todaySymbols = buildSymbolPool(spxPrice, today);
  const tomorrowSymbols = buildSymbolPool(spxPrice, tomorrow);
  const allOptionSymbols = [...todaySymbols, ...tomorrowSymbols];
  const allSymbols = ['SPX', ...allOptionSymbols];
  
  console.log(`Strike range: ${Math.round(spxPrice / 5) * 5 - 100} to ${Math.round(spxPrice / 5) * 5 + 100}`);
  console.log(`Today (${today}): ${todaySymbols.length} contracts`);
  console.log(`Tomorrow (${tomorrow}): ${tomorrowSymbols.length} contracts`);
  console.log(`Total symbols to stream: ${allSymbols.length}`);

  // 3. Create streaming session
  const sessionResp = await fetch(`${TRADIER_BASE}/markets/events/session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.tradierToken}`,
      Accept: 'application/json',
    },
  });
  const sessionData = await sessionResp.json() as any;
  const sessionId = sessionData?.stream?.sessionid;
  if (!sessionId) {
    console.error('Failed to create streaming session');
    process.exit(1);
  }
  console.log(`Session: ${sessionId.slice(0, 16)}...`);

  // 4. Open HTTP stream
  const params = new URLSearchParams({
    sessionid: sessionId,
    symbols: allSymbols.join(','),
    filter: 'trade,quote',
    linebreak: 'true',
    validOnly: 'true',
  });

  const controller = new AbortController();
  const RUN_SECONDS = 300; // 5 minutes
  setTimeout(() => controller.abort(), RUN_SECONDS * 1000);

  console.log(`\nStreaming for ${RUN_SECONDS}s...\n`);
  const startTime = Date.now();
  let messageCount = 0;
  let tradeCount = 0;
  let quoteCount = 0;
  const symbolsSeen = new Set<string>();
  const optionSymbolsSeen = new Set<string>();

  // Stats reporter
  const statsInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const totalClosed = [...closedCandles.values()].reduce((s, arr) => s + arr.length, 0);
    console.log(
      `[${elapsed}s] ${messageCount} msgs (${tradeCount} trades, ${quoteCount} quotes) | ` +
      `${symbolsSeen.size} symbols seen (${optionSymbolsSeen.size} options) | ` +
      `${totalClosed} closed candles | ${(messageCount / (Number(elapsed) || 1)).toFixed(1)} msg/s`
    );
  }, 30000);

  try {
    const resp = await fetch(`${STREAM_BASE}/markets/events?${params}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!resp.ok || !resp.body) {
      console.error(`Stream failed: HTTP ${resp.status}`);
      process.exit(1);
    }

    console.log('Connected!\n');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        try {
          const msg = JSON.parse(trimmed);
          messageCount++;
          
          if (msg.symbol) {
            symbolsSeen.add(msg.symbol);
            if (msg.symbol !== 'SPX') optionSymbolsSeen.add(msg.symbol);
          }
          
          if (msg.type === 'trade') {
            tradeCount++;
            handleTick(msg.symbol, parseFloat(msg.price || msg.last));
          } else if (msg.type === 'quote') {
            quoteCount++;
            const mid = ((parseFloat(msg.bid) || 0) + (parseFloat(msg.ask) || 0)) / 2;
            if (mid > 0) handleTick(msg.symbol, mid);
          }
          
          // Log first few messages
          if (messageCount <= 10) {
            const price = msg.price || msg.last || msg.bid || '?';
            console.log(`  [${messageCount}] ${msg.type} ${msg.symbol} $${price}`);
          }
        } catch {}
      }
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      console.log(`\n${RUN_SECONDS}s elapsed — stopping.\n`);
    } else {
      console.error('Stream error:', e.message);
    }
  }

  clearInterval(statsInterval);

  // 5. Final report
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalClosed = [...closedCandles.values()].reduce((s, arr) => s + arr.length, 0);
  
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  STREAM TEST RESULTS (${elapsed}s)`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Messages:     ${messageCount} (${tradeCount} trades, ${quoteCount} quotes)`);
  console.log(`  Rate:         ${(messageCount / Number(elapsed)).toFixed(1)} msg/s`);
  console.log(`  Symbols:      ${symbolsSeen.size} total (${optionSymbolsSeen.size} options + SPX)`);
  console.log(`  Coverage:     ${optionSymbolsSeen.size}/${allOptionSymbols.length} option symbols had data (${(optionSymbolsSeen.size / allOptionSymbols.length * 100).toFixed(1)}%)`);
  console.log(`  Candles:      ${totalClosed} completed 1m candles across ${closedCandles.size} symbols`);
  console.log(`  No data:      ${allOptionSymbols.length - optionSymbolsSeen.size} option symbols silent`);
  
  // Show top 10 most active symbols
  const activity = [...closedCandles.entries()]
    .map(([sym, candles]) => ({ sym, candles: candles.length, ticks: candles.reduce((s, c) => s + c.ticks, 0) }))
    .sort((a, b) => b.ticks - a.ticks);
  
  if (activity.length > 0) {
    console.log('\n  Top 10 most active:');
    for (const a of activity.slice(0, 10)) {
      console.log(`    ${a.sym.padEnd(25)} ${a.candles} candles, ${a.ticks} ticks`);
    }
  }

  // Compare a sample candle with what the data service has
  if (activity.length > 0) {
    const sample = activity[0];
    const sampleCandles = closedCandles.get(sample.sym)!;
    console.log(`\n  Sample candle comparison (${sample.sym}):`);
    for (const c of sampleCandles.slice(-3)) {
      const ts = new Date(c.minuteTs * 1000).toISOString().slice(11, 16);
      console.log(`    ${ts} UTC — O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} (${c.ticks} ticks)`);
    }
  }
  
  console.log('═══════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

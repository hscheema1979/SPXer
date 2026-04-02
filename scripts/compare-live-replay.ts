#!/usr/bin/env tsx
/**
 * Compare Live Agent vs Replay — Side-by-side trade comparison tool.
 *
 * Usage:
 *   npx tsx scripts/compare-live-replay.ts <date> [--config=<configId>] [--audit=<path>]
 *
 * Examples:
 *   npx tsx scripts/compare-live-replay.ts 2026-04-01
 *   npx tsx scripts/compare-live-replay.ts 2026-04-01 --config=hma3x17-undhma-otm15-tp14x-sl70
 *   npx tsx scripts/compare-live-replay.ts 2026-04-01 --audit=logs/agent-audit.jsonl
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ReplayStore } from '../src/replay/store';
import { getETOffsetMs } from '../src/utils/et-time';

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dateArg = args.find(a => !a.startsWith('--'));
if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Usage: npx tsx scripts/compare-live-replay.ts <YYYY-MM-DD> [--config=<id>] [--audit=<path>]');
  process.exit(1);
}

function getFlag(name: string, defaultVal: string): string {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split('=').slice(1).join('=') : defaultVal;
}

const targetDate = dateArg;
const configId = getFlag('config', 'hma3x17-undhma-otm15-tp14x-sl70');
const auditPath = getFlag('audit', 'logs/agent-audit.jsonl');

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveTrade {
  entryTs: number;       // ms
  exitTs: number;        // ms
  symbol: string;
  side: string;
  strike: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  reason: string;
  pnl: number;
  holdTimeSec: number;
  highPrice?: number;
  lowPrice?: number;
}

interface ReplayTrade {
  symbol: string;
  side: string;
  strike: number;
  qty: number;
  entryTs: number;       // unix seconds
  entryET: string;
  entryPrice: number;
  exitTs: number;         // unix seconds
  exitET: string;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  'pnl$': number;
  signalType: string;
}

interface MatchedTrade {
  live: LiveTrade;
  replay: ReplayTrade;
  entryTimeDiffSec: number;
  exitTimeDiffSec: number;
  entryPriceDiff: number;
  exitPriceDiff: number;
  pnlDiff: number;
  reasonMatch: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tsToET(tsMs: number): string {
  const dt = new Date(tsMs);
  return dt.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function tsToETDate(tsMs: number): string {
  const dt = new Date(tsMs);
  return dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function pad(s: string, len: number, right = false): string {
  if (right) return s.padEnd(len);
  return s.padStart(len);
}

function fmtPrice(p: number): string {
  return '$' + p.toFixed(2);
}

function fmtPnl(p: number): string {
  const sign = p >= 0 ? '+' : '';
  return sign + '$' + p.toFixed(2);
}

function fmtPct(p: number): string {
  const sign = p >= 0 ? '+' : '';
  return sign + p.toFixed(1) + '%';
}

function normalizeReason(r: string): string {
  // Normalize reason strings across live/replay
  const map: Record<string, string> = {
    'signal_reversal': 'reversal',
    'scannerReverse': 'reversal',
    'stop_loss': 'SL',
    'take_profit': 'TP',
    'time_exit': 'time',
  };
  return map[r] || r;
}

// ── Parse live audit log ─────────────────────────────────────────────────────

function parseLiveTrades(filePath: string, date: string): LiveTrade[] {
  if (!existsSync(filePath)) {
    console.error(`Audit log not found: ${filePath}`);
    return [];
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // First pass: collect all entries (opens) and closes for the target date
  const entries: Array<{
    ts: number; symbol: string; side: string; strike: number;
    fillPrice: number; qty: number;
  }> = [];
  const closes: Array<{
    ts: number; symbol: string; side: string; strike: number;
    entryPrice: number; closePrice: number; qty: number;
    reason: string; pnl: number; holdTimeSec: number;
    highPrice?: number; lowPrice?: number;
  }> = [];

  for (const line of lines) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }

    const ts = d.ts || 0;
    const tsMs = ts > 1e12 ? ts : ts * 1000;
    const entryDate = tsToETDate(tsMs);
    if (entryDate !== date) continue;

    if (d.type === 'position_close') {
      closes.push({
        ts: tsMs,
        symbol: d.symbol,
        side: d.side || parseSymbolSide(d.symbol),
        strike: d.strike || parseSymbolStrike(d.symbol),
        entryPrice: d.entryPrice,
        closePrice: d.closePrice,
        qty: d.quantity || 1,
        reason: d.reason,
        pnl: d.pnl,
        holdTimeSec: d.holdTimeSec || 0,
        highPrice: d.highPrice,
        lowPrice: d.lowPrice,
      });
    } else if (d.signal && d.execution?.fillPrice && d.decision?.action === 'buy') {
      entries.push({
        ts: tsMs,
        symbol: d.signal.symbol,
        side: d.signal.side,
        strike: d.signal.strike,
        fillPrice: d.execution.fillPrice,
        qty: d.decision.positionSize || 1,
      });
    }
  }

  // Match entries to closes by symbol + entryPrice
  const trades: LiveTrade[] = [];
  const usedEntries = new Set<number>();

  for (const close of closes) {
    // Find the best matching entry
    let bestIdx = -1;
    let bestTimeDiff = Infinity;
    for (let i = 0; i < entries.length; i++) {
      if (usedEntries.has(i)) continue;
      const entry = entries[i];
      if (entry.symbol !== close.symbol) continue;
      if (Math.abs(entry.fillPrice - close.entryPrice) > 0.5) continue;
      if (entry.ts > close.ts) continue;
      const diff = close.ts - entry.ts;
      if (diff < bestTimeDiff) {
        bestTimeDiff = diff;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedEntries.add(bestIdx);
      trades.push({
        entryTs: entries[bestIdx].ts,
        exitTs: close.ts,
        symbol: close.symbol,
        side: close.side,
        strike: close.strike,
        entryPrice: close.entryPrice,
        exitPrice: close.closePrice,
        qty: close.qty,
        reason: close.reason,
        pnl: close.pnl,
        holdTimeSec: close.holdTimeSec,
        highPrice: close.highPrice,
        lowPrice: close.lowPrice,
      });
    } else {
      // No matching entry found — create trade from close data only
      const estEntryTs = close.ts - (close.holdTimeSec || 60) * 1000;
      trades.push({
        entryTs: estEntryTs,
        exitTs: close.ts,
        symbol: close.symbol,
        side: close.side,
        strike: close.strike,
        entryPrice: close.entryPrice,
        exitPrice: close.closePrice,
        qty: close.qty,
        reason: close.reason,
        pnl: close.pnl,
        holdTimeSec: close.holdTimeSec,
        highPrice: close.highPrice,
        lowPrice: close.lowPrice,
      });
    }
  }

  trades.sort((a, b) => a.entryTs - b.entryTs);
  return trades;
}

function parseSymbolSide(symbol: string): string {
  // SPXW260401C06615000 → call/put
  const m = symbol.match(/[CP]\d{8}$/);
  if (!m) return '?';
  return m[0][0] === 'C' ? 'call' : 'put';
}

function parseSymbolStrike(symbol: string): number {
  // SPXW260401C06615000 → 6615
  const m = symbol.match(/[CP](\d{8})$/);
  if (!m) return 0;
  return parseInt(m[1]) / 1000;
}

// ── Parse replay results ─────────────────────────────────────────────────────

function parseReplayTrades(store: ReplayStore, config: string, date: string): ReplayTrade[] {
  const results = store.getResultsByConfig(config);
  const dayResult = results.find(r => r.date === date);

  if (!dayResult) {
    console.error(`No replay results found for config='${config}' date='${date}'`);
    console.error(`Available dates for this config: ${results.map(r => r.date).join(', ')}`);
    return [];
  }

  try {
    const trades: ReplayTrade[] = JSON.parse(dayResult.trades_json);
    trades.sort((a, b) => a.entryTs - b.entryTs);
    return trades;
  } catch (e) {
    console.error(`Failed to parse trades_json: ${e}`);
    return [];
  }
}

// ── Match trades ─────────────────────────────────────────────────────────────

function matchTrades(
  liveTrades: LiveTrade[],
  replayTrades: ReplayTrade[],
): { matched: MatchedTrade[]; unmatchedLive: LiveTrade[]; unmatchedReplay: ReplayTrade[] } {
  const matched: MatchedTrade[] = [];
  const usedReplay = new Set<number>();
  const unmatchedLive: LiveTrade[] = [];

  for (const live of liveTrades) {
    // Find best replay match: same side + strike within ±2 minutes of entry time
    let bestIdx = -1;
    let bestTimeDiff = Infinity;

    for (let i = 0; i < replayTrades.length; i++) {
      if (usedReplay.has(i)) continue;
      const replay = replayTrades[i];

      // Must match side and strike
      if (live.side !== replay.side) continue;
      if (live.strike !== replay.strike) continue;

      // Entry time within ±2 minutes (120 sec)
      const liveEntrySec = live.entryTs / 1000;
      const timeDiff = Math.abs(liveEntrySec - replay.entryTs);
      if (timeDiff > 120) continue;

      if (timeDiff < bestTimeDiff) {
        bestTimeDiff = timeDiff;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedReplay.add(bestIdx);
      const replay = replayTrades[bestIdx];
      const liveEntrySec = live.entryTs / 1000;
      const liveExitSec = live.exitTs / 1000;
      const replayPnl = replay['pnl$'];

      matched.push({
        live,
        replay,
        entryTimeDiffSec: Math.round(liveEntrySec - replay.entryTs),
        exitTimeDiffSec: Math.round(liveExitSec - replay.exitTs),
        entryPriceDiff: live.entryPrice - replay.entryPrice,
        exitPriceDiff: live.exitPrice - replay.exitPrice,
        pnlDiff: live.pnl - replayPnl,
        reasonMatch: normalizeReason(live.reason) === normalizeReason(replay.reason),
      });
    } else {
      unmatchedLive.push(live);
    }
  }

  const unmatchedReplay = replayTrades.filter((_, i) => !usedReplay.has(i));
  return { matched, unmatchedLive, unmatchedReplay };
}

// ── Bar quality analysis ─────────────────────────────────────────────────────

interface BarQuality {
  totalBars: number;
  syntheticBars: number;
  syntheticPct: number;
  totalSymbols: number;
  avgVolumePerBar: number;
}

function analyzeBarQuality(date: string): BarQuality | null {
  const dbPath = path.resolve(process.cwd(), 'data/spxer.db');
  if (!existsSync(dbPath)) return null;

  const db = new Database(dbPath, { readonly: true });

  try {
    // Determine the unix timestamp range for this date in ET
    // Use a wide UTC range that covers the full ET day
    const dayStart = new Date(date + 'T00:00:00Z').getTime() / 1000;
    const dayEnd = dayStart + 86400 + 18000; // +5h to cover EST offset

    const result = db.prepare(`
      SELECT 
        COUNT(*) as totalBars,
        SUM(CASE WHEN synthetic = 1 THEN 1 ELSE 0 END) as syntheticBars,
        COUNT(DISTINCT symbol) as totalSymbols,
        AVG(volume) as avgVolume
      FROM bars 
      WHERE timeframe = '1m' 
        AND ts >= ? AND ts < ?
        AND symbol LIKE 'SPXW%'
    `).get(dayStart, dayEnd) as any;

    if (!result || result.totalBars === 0) return null;

    return {
      totalBars: result.totalBars,
      syntheticBars: result.syntheticBars || 0,
      syntheticPct: ((result.syntheticBars || 0) / result.totalBars) * 100,
      totalSymbols: result.totalSymbols,
      avgVolumePerBar: result.avgVolume || 0,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ── Output formatting ────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function colorPnl(pnl: number): string {
  if (pnl > 0) return `${GREEN}${fmtPnl(pnl)}${RESET}`;
  if (pnl < 0) return `${RED}${fmtPnl(pnl)}${RESET}`;
  return fmtPnl(pnl);
}

function colorDiff(diff: number, unit = '$'): string {
  const sign = diff >= 0 ? '+' : '';
  const val = unit === '%' ? `${sign}${diff.toFixed(1)}%` : `${sign}$${Math.abs(diff).toFixed(2)}`;
  if (Math.abs(diff) < 0.01) return `${DIM}${val}${RESET}`;
  if (diff > 0) return `${GREEN}${val}${RESET}`;
  return `${RED}${val}${RESET}`;
}

function printHeader(title: string): void {
  console.log('');
  console.log(`${BOLD}${'═'.repeat(100)}${RESET}`);
  console.log(`${BOLD}  ${title}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(100)}${RESET}`);
}

function printSubHeader(title: string): void {
  console.log('');
  console.log(`${CYAN}── ${title} ${'─'.repeat(Math.max(0, 94 - title.length))}${RESET}`);
}

function printMatchedTrades(matched: MatchedTrade[]): void {
  if (matched.length === 0) {
    console.log(`  ${DIM}No matched trades${RESET}`);
    return;
  }

  // Header
  console.log(`  ${DIM}${pad('Time(ET)', 10)} ${pad('Side', 5)} ${pad('Strike', 7)} │ ${pad('Replay Entry', 13)} ${pad('Live Entry', 11)} ${pad('Δ Entry', 9)} │ ${pad('Replay Exit', 12)} ${pad('Live Exit', 10)} ${pad('Δ Exit', 9)} │ ${pad('Reason', 10)} │ ${pad('Replay P&L', 11)} ${pad('Live P&L', 10)} ${pad('Δ P&L', 10)}${RESET}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(5)} ${'─'.repeat(7)} ┼ ${'─'.repeat(13)} ${'─'.repeat(11)} ${'─'.repeat(9)} ┼ ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(9)} ┼ ${'─'.repeat(10)} ┼ ${'─'.repeat(11)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (const m of matched) {
    const timeET = tsToET(m.replay.entryTs * 1000);
    const side = m.live.side.toUpperCase().slice(0, 4);
    const strike = m.live.strike.toString();
    const replayPnl = m.replay['pnl$'];
    const reasonIcon = m.reasonMatch ? `${DIM}${normalizeReason(m.live.reason).slice(0, 10)}${RESET}` : `${YELLOW}${normalizeReason(m.live.reason).slice(0, 5)}/${normalizeReason(m.replay.reason).slice(0, 5)}${RESET}`;

    console.log(
      `  ${pad(timeET, 10)} ${pad(side, 5)} ${pad(strike, 7)} │` +
      ` ${pad(fmtPrice(m.replay.entryPrice), 13)} ${pad(fmtPrice(m.live.entryPrice), 11)} ${colorDiff(m.entryPriceDiff).padStart(20)} │` +
      ` ${pad(fmtPrice(m.replay.exitPrice), 12)} ${pad(fmtPrice(m.live.exitPrice), 10)} ${colorDiff(m.exitPriceDiff).padStart(20)} │` +
      ` ${pad('', 10)}${reasonIcon}` +
      ` │ ${colorPnl(replayPnl).padStart(22)} ${colorPnl(m.live.pnl).padStart(21)} ${colorDiff(m.pnlDiff).padStart(21)}`
    );
  }
}

function printUnmatchedTrades(label: string, trades: Array<LiveTrade | ReplayTrade>, isLive: boolean): void {
  if (trades.length === 0) return;

  console.log(`  ${YELLOW}${label} (${trades.length}):${RESET}`);
  for (const t of trades) {
    if (isLive) {
      const lt = t as LiveTrade;
      console.log(`    ${tsToET(lt.entryTs)} ${lt.side.toUpperCase().slice(0, 4)} ${lt.strike} @ ${fmtPrice(lt.entryPrice)} → ${fmtPrice(lt.exitPrice)} ${normalizeReason(lt.reason)} ${colorPnl(lt.pnl)}`);
    } else {
      const rt = t as ReplayTrade;
      console.log(`    ${rt.entryET || tsToET(rt.entryTs * 1000)} ${rt.side.toUpperCase().slice(0, 4)} ${rt.strike} @ ${fmtPrice(rt.entryPrice)} → ${fmtPrice(rt.exitPrice)} ${normalizeReason(rt.reason)} ${colorPnl(rt['pnl$'])}`);
    }
  }
}

function printSummary(
  liveTrades: LiveTrade[],
  replayTrades: ReplayTrade[],
  matched: MatchedTrade[],
  unmatchedLive: LiveTrade[],
  unmatchedReplay: ReplayTrade[],
): void {
  const liveTotal = liveTrades.reduce((s, t) => s + t.pnl, 0);
  const replayTotal = replayTrades.reduce((s, t) => s + t['pnl$'], 0);
  const liveWins = liveTrades.filter(t => t.pnl > 0).length;
  const replayWins = replayTrades.filter(t => t['pnl$'] > 0).length;
  const liveWR = liveTrades.length > 0 ? (liveWins / liveTrades.length) * 100 : 0;
  const replayWR = replayTrades.length > 0 ? (replayWins / replayTrades.length) * 100 : 0;
  const pnlDivergence = replayTotal !== 0 ? ((liveTotal - replayTotal) / Math.abs(replayTotal)) * 100 : 0;

  // Matched trade stats
  const matchedEntrySlippage = matched.length > 0
    ? matched.reduce((s, m) => s + Math.abs(m.entryPriceDiff), 0) / matched.length
    : 0;
  const matchedExitSlippage = matched.length > 0
    ? matched.reduce((s, m) => s + Math.abs(m.exitPriceDiff), 0) / matched.length
    : 0;
  const reasonMatches = matched.filter(m => m.reasonMatch).length;

  console.log('');
  console.log(`  ${BOLD}Metric                   Replay              Live                 Diff${RESET}`);
  console.log(`  ${'─'.repeat(75)}`);
  console.log(`  Total Trades            ${pad(replayTrades.length.toString(), 5)}               ${pad(liveTrades.length.toString(), 5)}                ${pad((liveTrades.length - replayTrades.length).toString(), 5)}`);
  console.log(`  Wins                    ${pad(replayWins.toString(), 5)}               ${pad(liveWins.toString(), 5)}                ${pad((liveWins - replayWins).toString(), 5)}`);
  console.log(`  Win Rate                ${pad(replayWR.toFixed(1) + '%', 6)}              ${pad(liveWR.toFixed(1) + '%', 6)}               ${colorDiff(liveWR - replayWR, '%')}`);
  console.log(`  Total P&L               ${colorPnl(replayTotal).padStart(22)}        ${colorPnl(liveTotal).padStart(22)}          ${colorDiff(liveTotal - replayTotal)}`);
  console.log(`  P&L Divergence                                                       ${colorDiff(pnlDivergence, '%')}`);
  console.log('');
  console.log(`  Matched Trades          ${matched.length}/${Math.max(liveTrades.length, replayTrades.length)}`);
  console.log(`  Unmatched Live          ${unmatchedLive.length}`);
  console.log(`  Unmatched Replay        ${unmatchedReplay.length}`);
  if (matched.length > 0) {
    console.log(`  Avg Entry Slippage      ${fmtPrice(matchedEntrySlippage)}`);
    console.log(`  Avg Exit Slippage       ${fmtPrice(matchedExitSlippage)}`);
    console.log(`  Exit Reason Match       ${reasonMatches}/${matched.length} (${((reasonMatches / matched.length) * 100).toFixed(0)}%)`);
  }
}

function printBarQuality(quality: BarQuality | null): void {
  if (!quality) {
    console.log(`  ${DIM}No bar data available for this date${RESET}`);
    return;
  }

  console.log(`  Option 1m Bars          ${quality.totalBars.toLocaleString()}`);
  console.log(`  Synthetic Bars          ${quality.syntheticBars.toLocaleString()} (${quality.syntheticPct.toFixed(2)}%)`);
  console.log(`  Real Bars               ${(quality.totalBars - quality.syntheticBars).toLocaleString()} (${(100 - quality.syntheticPct).toFixed(2)}%)`);
  console.log(`  Tracked Symbols         ${quality.totalSymbols}`);
  console.log(`  Avg Volume/Bar          ${quality.avgVolumePerBar.toFixed(1)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  printHeader(`Live vs Replay Comparison — ${targetDate} — config: ${configId}`);

  // 1. Parse live trades
  printSubHeader('Loading live audit log');
  const liveTrades = parseLiveTrades(auditPath, targetDate);
  console.log(`  Found ${liveTrades.length} live trades for ${targetDate}`);
  if (liveTrades.length > 0) {
    console.log(`  Time range: ${tsToET(liveTrades[0].entryTs)} – ${tsToET(liveTrades[liveTrades.length - 1].exitTs)} ET`);
  }

  // 2. Parse replay trades
  printSubHeader('Loading replay results');
  const store = new ReplayStore();
  const replayTrades = parseReplayTrades(store, configId, targetDate);
  console.log(`  Found ${replayTrades.length} replay trades for config '${configId}' on ${targetDate}`);
  if (replayTrades.length > 0) {
    console.log(`  Time range: ${replayTrades[0].entryET} – ${replayTrades[replayTrades.length - 1].exitET} ET`);
  }
  store.close();

  if (liveTrades.length === 0 && replayTrades.length === 0) {
    console.log(`\n  ${YELLOW}No trades found in either source. Nothing to compare.${RESET}`);
    process.exit(0);
  }

  // 3. Match trades
  printSubHeader('Trade-by-Trade Comparison');
  const { matched, unmatchedLive, unmatchedReplay } = matchTrades(liveTrades, replayTrades);
  printMatchedTrades(matched);

  // 4. Unmatched trades
  if (unmatchedLive.length > 0 || unmatchedReplay.length > 0) {
    printSubHeader('Unmatched Trades');
    printUnmatchedTrades('Live only (no replay match)', unmatchedLive, true);
    printUnmatchedTrades('Replay only (no live match)', unmatchedReplay, false);
  }

  // 5. Summary
  printSubHeader('Summary');
  printSummary(liveTrades, replayTrades, matched, unmatchedLive, unmatchedReplay);

  // 6. Bar quality
  printSubHeader('Bar Quality (Option Contracts)');
  const quality = analyzeBarQuality(targetDate);
  printBarQuality(quality);

  console.log('');
  console.log(`${BOLD}${'═'.repeat(100)}${RESET}`);
}

main();

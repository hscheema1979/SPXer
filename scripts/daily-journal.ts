#!/usr/bin/env npx tsx
/**
 * Daily Trading Journal Generator
 *
 * Generates a detailed post-session report from broker data (source of truth).
 * Includes: account balance, per-trade breakdown with P&L, per-symbol summary,
 * signal timing from agent audit log, and performance analysis.
 *
 * Usage:
 *   npx tsx scripts/daily-journal.ts                  # today (or last trading day)
 *   npx tsx scripts/daily-journal.ts 2026-04-20       # specific date
 *   npx tsx scripts/daily-journal.ts --days=5         # last 5 trading days
 *
 * Output: logs/journals/YYYY-MM-DD.md (one file per day)
 *
 * Designed to run automatically via PM2 cron after market close.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { todayET } from '../src/utils/et-time';

const TRADIER_TOKEN = process.env.TRADIER_TOKEN!;
const TRADIER_BASE = 'https://api.tradier.com/v1';
const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
const JOURNAL_DIR = path.join(process.cwd(), 'logs', 'journals');

function headers() {
  return {
    Authorization: `Bearer ${TRADIER_TOKEN}`,
    Accept: 'application/json',
  };
}

// ── Tradier API Helpers ──────────────────────────────────────────────────────

interface TradeFill {
  symbol: string;
  qty: number;       // positive = buy, negative = sell
  price: number;     // broker fill price
  commission: number;
  amount: number;    // net cash impact
}

interface AccountBalance {
  totalEquity: number;
  optionBuyingPower: number;
  cash: number;
  accountType: string;
}

async function fetchTradeHistory(date: string): Promise<TradeFill[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/accounts/${ACCOUNT_ID}/history`, {
    headers: headers(),
    timeout: 15000,
    params: { type: 'trade', start: date, end: date, limit: 300 },
  });

  const raw = data?.history?.event;
  if (!raw || raw === 'null') return [];
  const events = Array.isArray(raw) ? raw : [raw];

  return events.map((evt: any) => ({
    symbol: evt.trade?.symbol || '',
    qty: evt.trade?.quantity || 0,
    price: evt.trade?.price || 0,
    commission: evt.trade?.commission || 0,
    amount: evt.amount || 0,
  }));
}

async function fetchBalance(): Promise<AccountBalance | null> {
  try {
    const { data } = await axios.get(`${TRADIER_BASE}/accounts/${ACCOUNT_ID}/balances`, {
      headers: headers(),
      timeout: 10000,
    });
    const b = data?.balances;
    if (!b) return null;
    return {
      totalEquity: b.total_equity ?? b.total_cash ?? 0,
      optionBuyingPower: b.pdt?.option_buying_power ?? b.option_buying_power ?? 0,
      cash: b.total_cash ?? 0,
      accountType: b.account_type || 'unknown',
    };
  } catch { return null; }
}

async function fetchGainloss(date: string): Promise<Array<{ symbol: string; pnl: number; cost: number; proceeds: number; qty: number }>> {
  try {
    const { data } = await axios.get(`${TRADIER_BASE}/accounts/${ACCOUNT_ID}/gainloss`, {
      headers: headers(),
      timeout: 10000,
      params: { count: 200 },
    });
    const raw = data?.gainloss?.closed_position;
    if (!raw || raw === 'null') return [];
    const positions = Array.isArray(raw) ? raw : [raw];
    return positions
      .filter((p: any) => (p.close_date || '').startsWith(date))
      .map((p: any) => ({
        symbol: p.symbol,
        pnl: p.gain_loss ?? 0,
        cost: p.cost ?? 0,
        proceeds: p.proceeds ?? 0,
        qty: p.quantity ?? 0,
      }));
  } catch { return []; }
}

// ── Agent Tag Resolution ────────────────────────────────────────────────────

/**
 * Resolve agent tag to a short human-readable label.
 * Tags come from Tradier orders or audit log filenames.
 */
function agentLabel(tag: string): string {
  if (!tag || tag === '(none)') return 'unknown';
  if (tag === 'spx') return 'SPX';
  // Basket agents: extract the suffix after the last '-'
  // e.g. "spx-hma3x12-itm5-basket-3strike-...-itm5" → "ITM5"
  if (tag.endsWith('-itm5')) return 'ITM5';
  if (tag.endsWith('-atm')) return 'ATM';
  if (tag.endsWith('-otm5')) return 'OTM5';
  // Generic: take the last segment
  const parts = tag.split('-');
  return parts[parts.length - 1].toUpperCase();
}

/**
 * Extract agentId from an audit log filename.
 * e.g. "agent-audit-spx.jsonl" → "spx"
 * e.g. "agent-audit-spx-hma3x12-...-itm5.jsonl" → "spx-hma3x12-...-itm5"
 */
function agentIdFromFilename(filename: string): string {
  return filename.replace(/^agent-audit-/, '').replace(/\.jsonl$/, '');
}

/**
 * Build a map of (executed symbol) → agentId by scanning all audit log files.
 * Each agent writes to its own file, so we know which agent traded which symbol.
 * Returns { symbol → { agentId, agentLabel, tsMs } }
 */
function buildSymbolAgentMap(date: string, accountId: string): Map<string, { agentId: string; label: string; tsMs: number }> {
  const logsDir = path.join(process.cwd(), 'logs');
  const map = new Map<string, { agentId: string; label: string; tsMs: number }>();

  if (!fs.existsSync(logsDir)) return map;

  const auditFiles = fs.readdirSync(logsDir).filter(f =>
    (f.startsWith('agent-audit-') || f === 'agent-audit.jsonl') && f.endsWith('.jsonl')
  );

  for (const file of auditFiles) {
    // Legacy agent-audit.jsonl = single SPX agent before per-agent split
    const agentId = file === 'agent-audit.jsonl' ? 'spx' : agentIdFromFilename(file);
    const label = agentLabel(agentId);
    const filePath = path.join(logsDir, file);

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (!e.execution?.executedSymbol) continue;

          const tsMs = e.ts;
          const d = new Date(tsMs);
          const etStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (etStr !== date) continue;

          const sym = e.execution.executedSymbol;
          // If multiple agents traded the same symbol, keep the first (most recent entry wins for timing)
          if (!map.has(sym)) {
            map.set(sym, { agentId, label, tsMs });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable file */ }
  }

  return map;
}

/**
 * Fetch order tags from Tradier orders endpoint (works for current/recent day).
 * Returns { symbol → tag } from orders that have a tag field.
 */
async function fetchOrderTags(date: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data } = await axios.get(`${TRADIER_BASE}/accounts/${ACCOUNT_ID}/orders`, {
      headers: headers(),
      timeout: 10000,
      params: { includeTags: 'true' },
    });
    const orders = data?.orders?.order;
    if (!orders || orders === 'null') return map;
    const list = Array.isArray(orders) ? orders : [orders];

    for (const o of list) {
      if (!o.tag) continue;
      const orderDate = (o.create_date || o.transaction_date || '').slice(0, 10);
      if (orderDate !== date) continue;

      // OTOCO: extract from legs
      if (o.leg && Array.isArray(o.leg)) {
        for (const leg of o.leg) {
          if (leg.option_symbol) {
            map.set(leg.option_symbol, o.tag);
          }
        }
      }
      // Single order
      if (o.option_symbol) {
        map.set(o.option_symbol, o.tag);
      }
    }
  } catch { /* orders endpoint may fail for historical dates */ }
  return map;
}

// ── Signal Log ───────────────────────────────────────────────────────────────

interface SignalEntry {
  timeET: string;
  symbol: string;
  side: string;
  price: number;
  tsMs: number;
  agentId: string;
  agentLabel: string;
}

function loadSignals(date: string, symbolAgentMap: Map<string, { agentId: string; label: string; tsMs: number }>): SignalEntry[] {
  // Scan all audit log files for signals on this date
  const logsDir = path.join(process.cwd(), 'logs');
  const signals: SignalEntry[] = [];

  if (!fs.existsSync(logsDir)) return signals;

  // Read from all agent-specific audit files AND the legacy file
  const auditFiles = fs.readdirSync(logsDir).filter(f =>
    (f.startsWith('agent-audit-') || f === 'agent-audit.jsonl') && f.endsWith('.jsonl')
  );

  // Deduplicate by tsMs+symbol to avoid double-counting from legacy + agent-specific files
  const seen = new Set<string>();

  for (const file of auditFiles) {
    const agentId = file === 'agent-audit.jsonl' ? '' : agentIdFromFilename(file);
    const filePath = path.join(logsDir, file);

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          const sig = e.signal;
          if (!sig) continue;

          const tsMs = e.ts;
          const d = new Date(tsMs);
          const etStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (etStr !== date) continue;

          const sym = e.execution?.executedSymbol || sig.symbol;
          const key = `${tsMs}:${sym}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const timeET = d.toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });

          // Resolve agent: prefer the agent-specific file, fall back to symbol map
          let resolvedAgent = agentId;
          let resolvedLabel = agentId ? agentLabel(agentId) : '';
          if (!resolvedAgent && symbolAgentMap.has(sym)) {
            const mapped = symbolAgentMap.get(sym)!;
            resolvedAgent = mapped.agentId;
            resolvedLabel = mapped.label;
          }
          if (!resolvedLabel) resolvedLabel = agentLabel(resolvedAgent);

          signals.push({
            timeET,
            symbol: sym,
            side: sig.side,
            price: sig.currentPrice,
            tsMs,
            agentId: resolvedAgent || 'unknown',
            agentLabel: resolvedLabel || 'unknown',
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  return signals.sort((a, b) => a.tsMs - b.tsMs);
}

// ── Activity Log ─────────────────────────────────────────────────────────────

function loadActivitySummary(date: string): { firstCycle: string; lastCycle: string; totalCycles: number; closeEntry: any } | null {
  const actPath = path.join(process.cwd(), 'logs', 'agent-activity.jsonl');
  if (!fs.existsSync(actPath)) return null;

  const lines = fs.readFileSync(actPath, 'utf-8').split('\n').filter(Boolean);
  let firstCycle = '';
  let lastCycle = '';
  let totalCycles = 0;
  let closeEntry: any = null;

  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const d = new Date(e.ts);
      const etDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (etDate !== date) continue;

      if (e.event === 'cycle') {
        totalCycles++;
        if (!firstCycle) firstCycle = e.timeET || '';
        lastCycle = e.timeET || '';
      }
      if (e.event === 'close') closeEntry = e;
    } catch { /* skip */ }
  }

  if (totalCycles === 0) return null;
  return { firstCycle, lastCycle, totalCycles, closeEntry };
}

// ── P&L Computation from History ─────────────────────────────────────────────

interface SymbolPnl {
  symbol: string;
  shortSymbol: string;
  side: string;      // 'call' or 'put'
  strike: number;
  buyQty: number;
  sellQty: number;
  buyCost: number;     // includes commission
  sellProceeds: number; // net of commission
  pnl: number;
  avgBuy: number;
  avgSell: number;
  agentId: string;
  agentLabel: string;
}

function computeSymbolPnl(fills: TradeFill[], symbolAgentMap: Map<string, { agentId: string; label: string; tsMs: number }>): SymbolPnl[] {
  const bySymbol = new Map<string, { buyCost: number; buyQty: number; sellProceeds: number; sellQty: number }>();

  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) {
      bySymbol.set(f.symbol, { buyCost: 0, buyQty: 0, sellProceeds: 0, sellQty: 0 });
    }
    const entry = bySymbol.get(f.symbol)!;
    if (f.qty > 0) {
      entry.buyCost += (f.price * f.qty * 100) + f.commission;
      entry.buyQty += f.qty;
    } else {
      const absQty = Math.abs(f.qty);
      entry.sellProceeds += (f.price * absQty * 100) - f.commission;
      entry.sellQty += absQty;
    }
  }

  const results: SymbolPnl[] = [];
  for (const [symbol, e] of bySymbol) {
    const closedQty = Math.min(e.buyQty, e.sellQty);
    if (closedQty <= 0) continue;

    const costPerUnit = e.buyCost / e.buyQty;
    const procPerUnit = e.sellProceeds / e.sellQty;
    const pnl = (procPerUnit - costPerUnit) * closedQty;

    // Parse symbol: SPXW260420C07110000
    const match = symbol.match(/([CP])(\d{8})$/);
    const side = match?.[1] === 'C' ? 'call' : 'put';
    const strike = match ? parseInt(match[2]) / 1000 : 0;

    // Resolve agent from symbol map
    const agentInfo = symbolAgentMap.get(symbol);

    results.push({
      symbol,
      shortSymbol: symbol.slice(-12),
      side,
      strike,
      buyQty: e.buyQty,
      sellQty: e.sellQty,
      buyCost: e.buyCost,
      sellProceeds: e.sellProceeds,
      pnl,
      avgBuy: costPerUnit / 100,
      avgSell: procPerUnit / 100,
      agentId: agentInfo?.agentId || 'unknown',
      agentLabel: agentInfo?.label || 'unknown',
    });
  }

  return results.sort((a, b) => b.pnl - a.pnl);
}

// ── Trade Reconstruction ─────────────────────────────────────────────────────

interface ReconstructedTrade {
  entryTime: string;
  exitTime: string;
  durationMin: number;
  symbol: string;
  shortSymbol: string;
  side: string;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  pnl: number;
  agentId: string;
  agentLabel: string;
}

function reconstructTrades(signals: SignalEntry[], fills: TradeFill[]): ReconstructedTrade[] {
  if (signals.length === 0 || fills.length === 0) return [];

  // Build fill queues per symbol
  const buyFills = new Map<string, Array<{ qty: number; price: number; comm: number }>>();
  const sellFills = new Map<string, Array<{ qty: number; price: number; comm: number }>>();

  for (const f of fills) {
    if (f.qty > 0) {
      if (!buyFills.has(f.symbol)) buyFills.set(f.symbol, []);
      buyFills.get(f.symbol)!.push({ qty: f.qty, price: f.price, comm: f.commission });
    } else {
      if (!sellFills.has(f.symbol)) sellFills.set(f.symbol, []);
      sellFills.get(f.symbol)!.push({ qty: Math.abs(f.qty), price: f.price, comm: f.commission });
    }
  }

  const trades: ReconstructedTrade[] = [];

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const exitTime = i + 1 < signals.length ? signals[i + 1].timeET : '16:00:00';

    const entryParts = sig.timeET.split(':').map(Number);
    const exitParts = exitTime.split(':').map(Number);
    const durMin = (exitParts[0] * 60 + exitParts[1]) - (entryParts[0] * 60 + entryParts[1]);

    const match = sig.symbol.match(/([CP])(\d{8})$/);
    const side = match?.[1] === 'C' ? 'call' : 'put';

    const bq = buyFills.get(sig.symbol);
    const sq = sellFills.get(sig.symbol);
    const buy = bq?.shift();
    const sell = sq?.shift();

    const qty = buy?.qty || 0;
    const buyPrice = buy?.price || sig.price;
    const sellPrice = sell?.price || 0;

    let pnl = 0;
    if (buy && sell) {
      const minQty = Math.min(buy.qty, sell.qty);
      pnl = ((sell.price * 100 - sell.comm / sell.qty) - (buy.price * 100 + buy.comm / buy.qty)) * minQty;
    }

    trades.push({
      entryTime: sig.timeET.slice(0, 5),
      exitTime: exitTime.slice(0, 5),
      durationMin: durMin,
      symbol: sig.symbol,
      shortSymbol: sig.symbol.slice(-12),
      side,
      qty,
      buyPrice,
      sellPrice,
      pnl,
      agentId: sig.agentId,
      agentLabel: sig.agentLabel,
    });
  }

  return trades;
}

// ── Markdown Generator ───────────────────────────────────────────────────────

function generateJournal(
  date: string,
  fills: TradeFill[],
  balance: AccountBalance | null,
  signals: SignalEntry[],
  activity: ReturnType<typeof loadActivitySummary>,
  gainloss: Awaited<ReturnType<typeof fetchGainloss>>,
  symbolAgentMap: Map<string, { agentId: string; label: string; tsMs: number }> = new Map(),
): string {
  const symbolPnl = computeSymbolPnl(fills, symbolAgentMap);
  const trades = reconstructTrades(signals, fills);

  const totalPnl = symbolPnl.reduce((s, p) => s + p.pnl, 0);
  const totalComm = fills.reduce((s, f) => s + f.commission, 0);
  const totalBought = fills.filter(f => f.qty > 0).reduce((s, f) => s + Math.abs(f.qty), 0);
  const totalSold = fills.filter(f => f.qty < 0).reduce((s, f) => s + Math.abs(f.qty), 0);
  const totalFills = fills.length;
  const winningSymbols = symbolPnl.filter(p => p.pnl > 0);
  const losingSymbols = symbolPnl.filter(p => p.pnl < 0);

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl <= 0);
  const avgWin = winningTrades.length > 0 ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? losingTrades.reduce((s, t) => s + t.pnl, 0) / losingTrades.length : 0;
  const avgDuration = trades.length > 0 ? trades.reduce((s, t) => s + t.durationMin, 0) / trades.length : 0;
  const longestWin = winningTrades.sort((a, b) => b.durationMin - a.durationMin)[0];
  const biggestWin = [...winningTrades].sort((a, b) => b.pnl - a.pnl)[0];
  const biggestLoss = [...losingTrades].sort((a, b) => a.pnl - b.pnl)[0];

  const dayOfWeek = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const lines: string[] = [];
  const ln = (s = '') => lines.push(s);

  // Header
  ln(`# Trading Journal — ${date} (${dayOfWeek})`);
  ln();
  ln(`**Account**: ${ACCOUNT_ID} | **Mode**: LIVE | **Config**: spx-hma3x12-itm5-tp125x-sl25-3m`);
  if (activity) {
    ln(`**Session**: ${activity.firstCycle} → ${activity.lastCycle} ET | ${activity.totalCycles} cycles`);
  }
  ln();

  // P&L Summary
  ln(`## Summary`);
  ln();
  ln(`| Metric | Value |`);
  ln(`|--------|-------|`);
  ln(`| **Net P&L** | **$${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}** |`);
  ln(`| Total fills | ${totalFills} (${totalBought} bought, ${totalSold} sold) |`);
  ln(`| Symbols traded | ${symbolPnl.length} |`);
  ln(`| Commissions | $${totalComm.toFixed(2)} |`);
  if (trades.length > 0) {
    ln(`| Signals | ${signals.length} |`);
    ln(`| Win rate | ${(winningTrades.length / trades.length * 100).toFixed(1)}% (${winningTrades.length}W / ${losingTrades.length}L) |`);
    ln(`| Avg win | $${avgWin >= 0 ? '+' : ''}${avgWin.toFixed(0)} |`);
    ln(`| Avg loss | $${avgLoss.toFixed(0)} |`);
    ln(`| Avg hold time | ${avgDuration.toFixed(1)} min |`);
  }
  if (balance) {
    ln(`| Account equity | $${balance.totalEquity.toLocaleString()} |`);
    ln(`| Option buying power | $${balance.optionBuyingPower.toLocaleString()} |`);
  }
  ln();

  // Per-Symbol Breakdown
  ln(`## Per-Symbol P&L`);
  ln();
  ln(`| Symbol | Side | Contracts | Avg Buy | Avg Sell | P&L | % |`);
  ln(`|--------|------|-----------|---------|----------|-----|---|`);
  for (const sp of symbolPnl) {
    const pct = sp.buyCost > 0 ? (sp.pnl / sp.buyCost * 100) : 0;
    const emoji = sp.pnl > 0 ? '+' : '';
    ln(`| ${sp.shortSymbol} | ${sp.side} | ${sp.buyQty} | $${sp.avgBuy.toFixed(2)} | $${sp.avgSell.toFixed(2)} | $${emoji}${sp.pnl.toFixed(0)} | ${emoji}${pct.toFixed(1)}% |`);
  }
  ln();

  // Trade-by-Trade
  if (trades.length > 0) {
    ln(`## Trade Log`);
    ln();
    ln(`| # | Entry | Exit | Dur | Symbol | Side | Qty | Buy | Sell | P&L |`);
    ln(`|---|-------|------|-----|--------|------|-----|-----|------|-----|`);
    let running = 0;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      running += t.pnl;
      const emoji = t.pnl > 0 ? '+' : '';
      ln(`| ${i + 1} | ${t.entryTime} | ${t.exitTime} | ${t.durationMin}m | ${t.shortSymbol} | ${t.side} | ${t.qty} | $${t.buyPrice.toFixed(2)} | $${t.sellPrice.toFixed(2)} | $${emoji}${t.pnl.toFixed(0)} |`);
    }
    ln();
  }

  // Analysis
  ln(`## Analysis`);
  ln();

  if (biggestWin) {
    ln(`**Biggest win**: $+${biggestWin.pnl.toFixed(0)} — ${biggestWin.shortSymbol} ${biggestWin.side} (${biggestWin.entryTime}→${biggestWin.exitTime}, ${biggestWin.durationMin}m hold)`);
  }
  if (biggestLoss) {
    ln(`**Biggest loss**: $${biggestLoss.pnl.toFixed(0)} — ${biggestLoss.shortSymbol} ${biggestLoss.side} (${biggestLoss.entryTime}→${biggestLoss.exitTime}, ${biggestLoss.durationMin}m hold)`);
  }
  if (longestWin) {
    ln(`**Longest winning hold**: ${longestWin.durationMin}m — ${longestWin.shortSymbol} $+${longestWin.pnl.toFixed(0)}`);
  }
  ln();

  // Win duration vs loss duration
  if (winningTrades.length > 0 && losingTrades.length > 0) {
    const avgWinDur = winningTrades.reduce((s, t) => s + t.durationMin, 0) / winningTrades.length;
    const avgLossDur = losingTrades.reduce((s, t) => s + t.durationMin, 0) / losingTrades.length;
    ln(`**Hold time pattern**: Winners avg ${avgWinDur.toFixed(0)}m, losers avg ${avgLossDur.toFixed(0)}m`);
    if (avgWinDur > avgLossDur * 1.5) {
      ln(`> Winners held significantly longer than losers — patience pays.`);
    } else if (avgLossDur > avgWinDur * 1.5) {
      ln(`> Losers held longer than winners — cut losses faster.`);
    }
    ln();
  }

  // Whipsaw detection
  const shortHolds = trades.filter(t => t.durationMin <= 5);
  if (shortHolds.length > trades.length * 0.4) {
    ln(`**Whipsaw warning**: ${shortHolds.length}/${trades.length} trades (${(shortHolds.length / trades.length * 100).toFixed(0)}%) held 5 min or less.`);
    const shortPnl = shortHolds.reduce((s, t) => s + t.pnl, 0);
    ln(`> Short-hold P&L: $${shortPnl >= 0 ? '+' : ''}${shortPnl.toFixed(0)} — ${shortPnl < 0 ? 'HMA too twitchy for this session' : 'managed to profit despite churn'}.`);
    ln();
  }

  // Gainloss cross-check (if available)
  if (gainloss.length > 0) {
    const brokerTotal = gainloss.reduce((s, p) => s + p.pnl, 0);
    ln(`## Broker Cross-Check (Tradier Gainloss)`);
    ln();
    ln(`Tradier gainloss endpoint reports **$${brokerTotal >= 0 ? '+' : ''}${brokerTotal.toFixed(2)}** for ${gainloss.length} closed positions.`);
    const diff = Math.abs(brokerTotal - totalPnl);
    if (diff > 50) {
      ln(`> History-computed P&L differs by $${diff.toFixed(0)} — likely rounding or commission treatment.`);
    }
    ln();
  }

  ln(`---`);
  ln(`*Generated ${new Date().toISOString()} by scripts/daily-journal.ts*`);

  return lines.join('\n');
}

// ── Analysis Observations Builder ────────────────────────────────────────────

function buildObservations(trades: ReconstructedTrade[]): string[] {
  const obs: string[] = [];

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl < 0);

  // Biggest win/loss
  const biggestWin = [...winningTrades].sort((a, b) => b.pnl - a.pnl)[0];
  const biggestLoss = [...losingTrades].sort((a, b) => a.pnl - b.pnl)[0];
  if (biggestWin) {
    obs.push(`Biggest win: $+${biggestWin.pnl.toFixed(0)} on ${biggestWin.shortSymbol} ${biggestWin.side} (${biggestWin.entryTime}\u2192${biggestWin.exitTime}, ${biggestWin.durationMin}m hold)`);
  }
  if (biggestLoss) {
    obs.push(`Biggest loss: $${biggestLoss.pnl.toFixed(0)} on ${biggestLoss.shortSymbol} ${biggestLoss.side} (${biggestLoss.entryTime}\u2192${biggestLoss.exitTime}, ${biggestLoss.durationMin}m hold)`);
  }

  // Longest winning hold
  const longestWin = [...winningTrades].sort((a, b) => b.durationMin - a.durationMin)[0];
  if (longestWin) {
    obs.push(`Longest winning hold: ${longestWin.durationMin}m on ${longestWin.shortSymbol} ($+${longestWin.pnl.toFixed(0)})`);
  }

  // Hold time pattern
  if (winningTrades.length > 0 && losingTrades.length > 0) {
    const avgWinDur = winningTrades.reduce((s, t) => s + t.durationMin, 0) / winningTrades.length;
    const avgLossDur = losingTrades.reduce((s, t) => s + t.durationMin, 0) / losingTrades.length;
    obs.push(`Hold time pattern: winners avg ${avgWinDur.toFixed(0)}m, losers avg ${avgLossDur.toFixed(0)}m`);
    if (avgWinDur > avgLossDur * 1.5) {
      obs.push(`Winners held significantly longer than losers \u2014 patience pays`);
    } else if (avgLossDur > avgWinDur * 1.5) {
      obs.push(`Losers held longer than winners \u2014 cut losses faster`);
    }
  }

  // Whipsaw detection
  const shortHolds = trades.filter(t => t.durationMin <= 5);
  if (shortHolds.length > trades.length * 0.4 && trades.length > 2) {
    const shortPnl = shortHolds.reduce((s, t) => s + t.pnl, 0);
    obs.push(`Whipsaw warning: ${shortHolds.length}/${trades.length} trades (${(shortHolds.length / trades.length * 100).toFixed(0)}%) held 5 min or less`);
    obs.push(`Short-hold P&L: $${shortPnl >= 0 ? '+' : ''}${shortPnl.toFixed(0)} \u2014 ${shortPnl < 0 ? 'HMA too twitchy for this session' : 'managed to profit despite churn'}`);
  }

  // Consecutive losses streak
  let maxStreak = 0, curStreak = 0;
  for (const t of trades) {
    if (t.pnl < 0) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
    else { curStreak = 0; }
  }
  if (maxStreak >= 3) {
    obs.push(`Max losing streak: ${maxStreak} trades in a row`);
  }

  // Call vs put performance
  const callPnl = trades.filter(t => t.side === 'call').reduce((s, t) => s + t.pnl, 0);
  const putPnl = trades.filter(t => t.side === 'put').reduce((s, t) => s + t.pnl, 0);
  const callCount = trades.filter(t => t.side === 'call').length;
  const putCount = trades.filter(t => t.side === 'put').length;
  if (callCount > 0 && putCount > 0) {
    obs.push(`Calls: ${callCount} trades, $${callPnl >= 0 ? '+' : ''}${callPnl.toFixed(0)} | Puts: ${putCount} trades, $${putPnl >= 0 ? '+' : ''}${putPnl.toFixed(0)}`);
  }

  return obs;
}

// ── JSON Data Builder ───────────────────────────────────────────────────────

function buildJsonData(
  date: string,
  fills: TradeFill[],
  balance: AccountBalance | null,
  signals: SignalEntry[],
  activity: ReturnType<typeof loadActivitySummary>,
  gainloss: Awaited<ReturnType<typeof fetchGainloss>>,
  symbolAgentMap: Map<string, { agentId: string; label: string; tsMs: number }>,
) {
  const symbolPnl = computeSymbolPnl(fills, symbolAgentMap);
  const trades = reconstructTrades(signals, fills);
  const computedPnl = symbolPnl.reduce((s, p) => s + p.pnl, 0);
  const totalComm = fills.reduce((s, f) => s + f.commission, 0);

  // Broker gainloss is the source of truth for daily P&L
  const brokerPnl = gainloss.length > 0
    ? gainloss.reduce((s, p) => s + p.pnl, 0)
    : null;
  // Use broker P&L when available, fall back to computed
  const dailyPnl = brokerPnl !== null ? brokerPnl : computedPnl;

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl <= 0 && t.pnl !== 0);
  const avgWinDur = winningTrades.length > 0 ? winningTrades.reduce((s, t) => s + t.durationMin, 0) / winningTrades.length : 0;
  const avgLossDur = losingTrades.length > 0 ? losingTrades.reduce((s, t) => s + t.durationMin, 0) / losingTrades.length : 0;

  // Build running P&L on trades
  let running = 0;
  const tradesWithRunning = trades.map((t, i) => {
    running += t.pnl;
    return { ...t, num: i + 1, runningPnl: running, isWin: t.pnl > 0 };
  });

  // Build observations
  const observations = buildObservations(trades);

  // Build per-agent summary
  const agentMap = new Map<string, { label: string; trades: number; wins: number; pnl: number; symbols: Set<string> }>();
  for (const t of trades) {
    const key = t.agentId || 'unknown';
    if (!agentMap.has(key)) {
      agentMap.set(key, { label: t.agentLabel || 'unknown', trades: 0, wins: 0, pnl: 0, symbols: new Set() });
    }
    const a = agentMap.get(key)!;
    a.trades++;
    if (t.pnl > 0) a.wins++;
    a.pnl += t.pnl;
    a.symbols.add(t.shortSymbol);
  }
  const agentSummary = Object.fromEntries(
    [...agentMap.entries()].map(([id, a]) => [id, {
      agentId: id,
      label: a.label,
      trades: a.trades,
      wins: a.wins,
      losses: a.trades - a.wins,
      winRate: a.trades > 0 ? Math.round(a.wins / a.trades * 1000) / 10 : 0,
      pnl: Math.round(a.pnl * 100) / 100,
      symbols: [...a.symbols],
    }])
  );

  // Detect distinct agents for multi-agent flag
  const distinctAgents = [...agentMap.keys()].filter(k => k !== 'unknown');

  return {
    date,
    accountId: ACCOUNT_ID,
    configId: process.env.AGENT_CONFIG_ID || 'unknown',
    mode: process.env.AGENT_PAPER === 'true' ? 'paper' : 'live',
    multiAgent: distinctAgents.length > 1,
    agents: distinctAgents.map(id => ({ id, label: agentMap.get(id)!.label })),
    equity: balance?.totalEquity ?? null,
    optionBuyingPower: balance?.optionBuyingPower ?? null,
    totalTrades: trades.length,
    wins: winningTrades.length,
    losses: losingTrades.length,
    // winRate stored as percentage 0-100 (not decimal)
    winRate: trades.length > 0 ? Math.round(winningTrades.length / trades.length * 1000) / 10 : 0,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    computedPnl: Math.round(computedPnl * 100) / 100,
    avgPnl: trades.length > 0 ? Math.round(dailyPnl / trades.length * 100) / 100 : 0,
    biggestWin: winningTrades.length > 0 ? Math.round(Math.max(...winningTrades.map(t => t.pnl)) * 100) / 100 : 0,
    biggestLoss: losingTrades.length > 0 ? Math.round(Math.min(...losingTrades.map(t => t.pnl)) * 100) / 100 : 0,
    totalCommissions: Math.round(totalComm * 100) / 100,
    totalFills: fills.length,
    avgWinDurationMin: Math.round(avgWinDur),
    avgLossDurationMin: Math.round(avgLossDur),
    session: activity ? {
      firstCycle: activity.firstCycle,
      lastCycle: activity.lastCycle,
      totalCycles: activity.totalCycles,
    } : null,
    // Broker cross-check
    brokerCrossCheck: gainloss.length > 0 ? {
      brokerPnl: Math.round((brokerPnl ?? 0) * 100) / 100,
      brokerPositions: gainloss.length,
      computedPnl: Math.round(computedPnl * 100) / 100,
      discrepancy: Math.round(Math.abs((brokerPnl ?? 0) - computedPnl) * 100) / 100,
      positions: gainloss.map(p => ({
        symbol: p.symbol,
        pnl: Math.round(p.pnl * 100) / 100,
        cost: Math.round(p.cost * 100) / 100,
        proceeds: Math.round(p.proceeds * 100) / 100,
        qty: p.qty,
      })),
    } : null,
    trades: tradesWithRunning,
    // symbolSummary as a keyed object { shortSymbol: { ... } } for easier rendering
    symbolSummary: Object.fromEntries(symbolPnl.map(sp => [sp.shortSymbol, {
      symbol: sp.symbol,
      shortSymbol: sp.shortSymbol,
      side: sp.side,
      strike: sp.strike,
      totalBought: sp.buyQty,
      totalSold: sp.sellQty,
      avgBuy: Math.round(sp.avgBuy * 100) / 100,
      avgSell: Math.round(sp.avgSell * 100) / 100,
      pnl: Math.round(sp.pnl * 100) / 100,
      agentId: sp.agentId,
      agentLabel: sp.agentLabel,
    }])),
    agentSummary,
    observations,
    generatedAt: new Date().toISOString(),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function generateForDate(date: string): Promise<void> {
  console.log(`[journal] Generating report for ${date}...`);

  const [fills, balance, gainloss] = await Promise.all([
    fetchTradeHistory(date),
    fetchBalance(),
    fetchGainloss(date),
  ]);

  if (fills.length === 0 && gainloss.length === 0) {
    console.log(`[journal] No trades found for ${date} — skipping`);
    return;
  }

  // Build symbol → agent mapping from audit logs + order tags
  const symbolAgentMap = buildSymbolAgentMap(date, ACCOUNT_ID);
  const orderTags = await fetchOrderTags(date);
  // Order tags override audit log (more authoritative for current day)
  for (const [sym, tag] of orderTags) {
    symbolAgentMap.set(sym, { agentId: tag, label: agentLabel(tag), tsMs: 0 });
  }
  console.log(`[journal] Agent map: ${symbolAgentMap.size} symbols mapped to agents`);

  const signals = loadSignals(date, symbolAgentMap);
  const activity = loadActivitySummary(date);

  const markdown = generateJournal(date, fills, balance, signals, activity, gainloss, symbolAgentMap);
  const jsonData = buildJsonData(date, fills, balance, signals, activity, gainloss, symbolAgentMap);

  // Write both formats
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  const mdPath = path.join(JOURNAL_DIR, `${date}.md`);
  const jsonPath = path.join(JOURNAL_DIR, `${date}.json`);
  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`[journal] Written: ${mdPath} + ${jsonPath}`);

  // Also print to stdout for immediate viewing
  console.log('\n' + markdown);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --days=N flag
  const daysFlag = args.find(a => a.startsWith('--days='));
  if (daysFlag) {
    const n = parseInt(daysFlag.split('=')[1], 10);
    const today = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      const dateStr = d.toISOString().slice(0, 10);
      await generateForDate(dateStr);
    }
    return;
  }

  // Specific date or today
  const date = args[0] || todayET();
  await generateForDate(date);
}

main().catch(e => {
  console.error('[journal] Fatal:', e.message);
  process.exit(1);
});

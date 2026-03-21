/**
 * replay-full.ts — Full-day replay of March 19 2026
 *
 * Iterates every 1m SPX bar, applies the same escalation logic as the live agent,
 * calls actual judge models at trigger points, simulates position management,
 * and produces a complete P&L timeline.
 *
 * Pre-filter (deterministic, no model calls):
 *   - RSI < 20 or RSI > 80  → ESCALATE (extreme — judge fires)
 *   - Open position          → monitor for exit (rule-based, no judge)
 *   - Otherwise              → skip
 *
 * Judge: Haiku (fast) + Opus (high accuracy) called sequentially at escalation points.
 * Position: stop-loss=30%, take-profit=200%, time-exit=15m before close.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { getJudgeConfigs, askModel } from './src/agent/model-clients';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');

// ── Epoch helpers ────────────────────────────────────────────────────────────

/** 09:30 ET on 2026-03-19 */
const SESSION_START = 1773927000;
/** 16:00 ET on 2026-03-19 */
const SESSION_END   = SESSION_START + 390 * 60;
const CLOSE_CUTOFF  = SESSION_END - 15 * 60; // 15:45 ET — no new entries

function etLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}

function minutesToClose(ts: number): number {
  return Math.max(0, Math.floor((SESSION_END - ts) / 60));
}

// ── DB helpers ───────────────────────────────────────────────────────────────

interface Bar {
  ts: number;
  open: number; high: number; low: number; close: number; volume: number;
  indicators: Record<string, number | null>;
}

interface ContractBar {
  symbol: string; type: string; strike: number;
  close: number; volume: number; high: number; low: number;
}

function getDb() { return new Database(DB_PATH, { readonly: true }); }

function getSpxBars(db: Database.Database, atTs: number, n = 25): Bar[] {
  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM bars WHERE symbol='SPX' AND timeframe='1m' AND ts <= ?
    ORDER BY ts DESC LIMIT ?
  `).all(atTs, n) as any[];
  return rows.reverse().map(r => ({ ...r, indicators: JSON.parse(r.indicators || '{}') }));
}

function get0dteContracts(db: Database.Database, atTs: number, spxPrice: number): ContractBar[] {
  return (db.prepare(`
    SELECT b.symbol, c.type, c.strike, b.close, b.volume, b.high, b.low
    FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE '%260319%'
      AND b.timeframe = '1m'
      AND b.ts = (SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe='1m' AND b2.ts<=?)
      AND c.strike BETWEEN ? AND ?
    ORDER BY c.type, c.strike
  `).all(atTs, spxPrice - 50, spxPrice + 50) as any[]);
}

/** Parse call/put and strike from a judge-returned symbol string.
 *  Handles formats: SPXW260319C06600000, SPXW260319C6600, SPXW260319 C6600, etc. */
function parseOptionSymbol(sym: string): { isCall: boolean; strike: number } | null {
  const s = sym.replace(/\s+/g, '');
  // Look for C or P followed by digits (with optional leading zeros and trailing 000)
  const m = s.match(/([CP])0*(\d{4,5})(?:000)?$/i);
  if (!m) return null;
  return { isCall: m[1].toUpperCase() === 'C', strike: parseInt(m[2]) };
}

/** All SPX 1m bar timestamps for the session */
function getSessionTimestamps(db: Database.Database): number[] {
  const rows = db.prepare(`
    SELECT ts FROM bars WHERE symbol='SPX' AND timeframe='1m'
      AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(SESSION_START, SESSION_END) as any[];
  return rows.map(r => r.ts);
}

// ── Judge system prompt ──────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a senior 0DTE SPX options trader making the final call.

Multiple junior analysts have been scanning the market and flagged potential setups.
You now review their assessments alongside the FULL market data to decide whether to act.

Your edge is reading flow AND technicals together:
- Multi-timeframe alignment (2+ TFs) is ideal but NOT required when macro flow
  provides a clear thesis (e.g., delta unwind into close, gamma squeeze, pin risk).
- 0DTE's biggest moves happen in the LAST 60 minutes. Do NOT avoid late-day trades.
  Entries with 15-60 minutes left are valid if the thesis is strong.
- Theta accelerates into close — but so do gamma moves. A $2 option can go to $10
  in 20 minutes on a gamma squeeze. Factor both sides.
- When you DO trade, define a clear stop-loss (20-40% of option price).
- Be DECISIVE. If 2+ scanners flag a setup AND flow supports it, ACT. Waiting for
  perfect confirmation on 0DTE means watching the move happen without you.
- RSI extremes on SPX (<20 = extreme oversold, >80 = extreme overbought) are
  high-probability mean-reversion signals on 0DTE. RSI <15 is an emergency signal —
  OTM calls/puts can go 10-50x from these levels in under 30 minutes. ACT.

CONTRACT SELECTION for RSI extremes:
- PREFER OTM options (1-3 strikes out of the money, priced $0.50-$5.00).
- An OTM call/put at $1-3 can go to $20-40 on a mean-reversion move (+1000-2000%).
- ITM options priced >$10 will only move 50-100% even if the thesis is correct.
- The entire point of trading RSI extremes on 0DTE is the LEVERAGE of OTM options.
- Example: RSI=8 oversold → BUY OTM calls 15-30 pts above current SPX price.

TAKE-PROFIT targets for RSI extremes:
- Minimum target: 3x entry price (200% gain) — RSI extremes rarely give small moves.
- Emergency signals (RSI <15 or >85): target 5x-10x entry (400-900% gain).
- Set stop_loss at 30-40% below entry (e.g., entry=$2.00 → stop=$1.30).
- Set take_profit at minimum 3x entry (e.g., entry=$2.00 → tp=$6.00).
- NEVER set take_profit within 100% of entry — that is leaving massive money on table.

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "action": "buy" | "wait",
  "target_symbol": "<full option symbol or null>",
  "confidence": <0.0-1.0>,
  "stop_loss": <price or null>,
  "take_profit": <price or null>,
  "reasoning": "<concise reason>"
}`;

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  ts: number, spxBars: Bar[], contracts: ContractBar[],
  escalationReason: string, openPosition: SimPosition | null,
): string {
  const spx = spxBars[spxBars.length - 1];
  const rsi = spx.indicators.rsi14?.toFixed(1) ?? '-';
  const ema9 = spx.indicators.ema9?.toFixed(2) ?? '-';
  const ema21 = spx.indicators.ema21?.toFixed(2) ?? '-';
  const prev3 = spxBars.slice(-3);
  const trend = prev3.length >= 3 ? (prev3[2].close > prev3[0].close ? 'bullish' : 'bearish') : 'neutral';

  const calls = contracts.filter(c => c.type === 'call').sort((a, b) => a.strike - b.strike);
  const puts  = contracts.filter(c => c.type === 'put').sort((a, b) => a.strike - b.strike);

  const callBlock = calls.map(c => {
    const tag = c.strike < spx.close ? 'ITM' : `OTM+${(c.strike - spx.close).toFixed(0)}`;
    return `  C${c.strike}: $${c.close.toFixed(2)} (${tag}) vol=${c.volume}`;
  }).join('\n');

  const putBlock = puts.slice().reverse().map(c => {
    const tag = c.strike > spx.close ? 'ITM' : `OTM-${(spx.close - c.strike).toFixed(0)}`;
    return `  P${c.strike}: $${c.close.toFixed(2)} (${tag}) vol=${c.volume}`;
  }).join('\n');

  const posBlock = openPosition
    ? `  OPEN: ${openPosition.symbol} x${openPosition.qty} @ $${openPosition.entryPrice.toFixed(2)} | stop=$${openPosition.stopLoss.toFixed(2)} tp=$${openPosition.takeProfit.toFixed(2)}`
    : '  None';

  return `${escalationReason}

TIME: ${etLabel(ts)} ET | ${minutesToClose(ts)}m to close

SPX: ${spx.close.toFixed(2)} [trend:${trend}] RSI=${rsi} EMA9=${ema9} EMA21=${ema21}

OPEN POSITION:
${posBlock}

RISK: Paper mode | Daily loss limit: $500 | Max risk/trade: $250

CALLS (SPXW260319):
${callBlock || '  none in range'}

PUTS (SPXW260319):
${putBlock || '  none in range'}

---
Systematic rule-based scanners escalated because: ${escalationReason}
Make the call.`;
}

// ── Simulation state ─────────────────────────────────────────────────────────

interface SimPosition {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTs: number;
  entryET: string;
}

interface Trade {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  entryTs: number; entryET: string; entryPrice: number;
  exitTs: number;  exitET: string;  exitPrice: number;
  reason: 'stop_loss' | 'take_profit' | 'time_exit' | 'judge_close';
  pnlPct: number;
  pnl$: number;
  qty: number;
}

interface EscalationEvent {
  ts: number; et: string;
  rsi: number;
  direction: 'oversold' | 'overbought';
  judgeDecision: 'buy' | 'wait';
  judgeConfidence: number;
  targetSymbol: string | null;
  entryPrice: number | null;
  reasoning: string;
}

// ── Main replay loop ─────────────────────────────────────────────────────────

function extractJSON(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

async function main() {
  const db = getDb();
  const timestamps = getSessionTimestamps(db);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  SPXer Full-Day Replay — March 19 2026`);
  console.log(`  ${timestamps.length} bars | ${etLabel(timestamps[0])}→${etLabel(timestamps[timestamps.length-1])} ET`);
  console.log('═'.repeat(72));

  // Use only Haiku + Opus as replay judges (fast + accurate)
  const allJudges = getJudgeConfigs();
  const replayJudges = allJudges.filter(j => ['haiku', 'opus'].includes(j.id));
  console.log(`  Judges: ${replayJudges.map(j => j.label).join(', ')}\n`);

  const trades: Trade[] = [];
  const escalations: EscalationEvent[] = [];
  let openPos: SimPosition | null = null;
  let lastEscalationTs = 0;
  const COOLDOWN_MINS = 10; // don't re-escalate within 10 min of last escalation

  // Track RSI to detect when we cross thresholds
  const RSI_EXTREME_OVERSOLD  = 20;
  const RSI_EXTREME_OVERBOUGHT = 80;

  for (const ts of timestamps) {
    const spxBars = getSpxBars(db, ts);
    if (spxBars.length < 5) continue;
    const spx = spxBars[spxBars.length - 1];
    const rsi = spx.indicators.rsi14 ?? null;
    const timeLabel = etLabel(ts);

    // ── Position monitoring (always, rule-based) ─────────────────────────────
    if (openPos) {
      const contracts = get0dteContracts(db, ts, spx.close);
      const key = `${openPos.side}_${openPos.strike}`;
      const curBar = contracts.find(c => `${c.type}_${c.strike}` === key);
      const curPrice = curBar?.close ?? null;

      if (curPrice !== null) {
        let closeReason: Trade['reason'] | null = null;
        let closePrice = curPrice;

        if (curPrice <= openPos.stopLoss) {
          closeReason = 'stop_loss';
        } else if (curPrice >= openPos.takeProfit) {
          closeReason = 'take_profit';
        } else if (ts >= CLOSE_CUTOFF) {
          closeReason = 'time_exit';
          // Use next available bar for time exit price
          const nextBars = get0dteContracts(db, ts + 60, spx.close);
          const nb = nextBars.find(c => `${c.type}_${c.strike}` === key);
          closePrice = nb?.close ?? curPrice;
        }

        if (closeReason) {
          const pnlPct = ((closePrice - openPos.entryPrice) / openPos.entryPrice) * 100;
          const pnl$ = (closePrice - openPos.entryPrice) * openPos.qty * 100;
          const trade: Trade = {
            symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
            entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
            exitTs: ts, exitET: timeLabel, exitPrice: closePrice,
            reason: closeReason, pnlPct, pnl$,
          };
          trades.push(trade);
          const emoji = pnlPct >= 0 ? '✅' : '❌';
          console.log(`  ${emoji} CLOSE [${timeLabel}] ${openPos.symbol} ${closeReason.toUpperCase()}`);
          console.log(`     Entry=$${openPos.entryPrice.toFixed(2)} Exit=$${closePrice.toFixed(2)} → ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}% ($${pnl$.toFixed(0)})`);
          openPos = null;
        }
      }
    }

    // ── Pre-filter: should we escalate to judges? ─────────────────────────────
    if (rsi === null) continue;
    if (ts >= CLOSE_CUTOFF) continue; // no new entries after 15:45
    if (openPos !== null) continue;    // already in a position

    const isOversold   = rsi < RSI_EXTREME_OVERSOLD;
    const isOverbought = rsi > RSI_EXTREME_OVERBOUGHT;
    if (!isOversold && !isOverbought) continue;

    // Cooldown: don't spam judges if RSI stays extreme for multiple bars
    if (ts - lastEscalationTs < COOLDOWN_MINS * 60) continue;

    const direction = isOversold ? 'oversold' : 'overbought';
    const severity  = (rsi < 15 || rsi > 85) ? 'EMERGENCY' : 'EXTREME';
    const escalationReason = `⚡ ${severity}: SPX RSI=${rsi.toFixed(1)} — ${direction.toUpperCase()} — high-probability mean-reversion signal`;

    console.log(`\n⚡ [${timeLabel}] RSI=${rsi.toFixed(1)} ${severity} ${direction} | ${minutesToClose(ts)}m to close`);

    lastEscalationTs = ts;

    // ── Call judges ───────────────────────────────────────────────────────────
    const contracts = get0dteContracts(db, ts, spx.close);
    const prompt = buildPrompt(ts, spxBars, contracts, escalationReason, openPos);
    const contractMap = new Map(contracts.map(c => [`${c.type}_${c.strike}`, c]));

    let judgeAction: 'buy' | 'wait' = 'wait';
    let judgeConf = 0;
    let judgeTarget: string | null = null;
    let judgeReasoning = '';
    let judgeStopLoss: number | null = null;
    let judgeTakeProfit: number | null = null;

    for (const cfg of replayJudges) {
      try {
        const text = await askModel(cfg, JUDGE_SYSTEM, prompt, 90000);
        const parsed = JSON.parse(extractJSON(text));
        console.log(`  [${cfg.id}] ${(parsed.action||'wait').toUpperCase()} conf=${((parsed.confidence||0)*100).toFixed(0)}% ${parsed.target_symbol ?? ''}`);
        console.log(`     → ${String(parsed.reasoning||'').slice(0, 120)}`);

        // Take the most decisive judge's decision (highest confidence buy)
        if (parsed.action === 'buy' && (parsed.confidence || 0) > judgeConf) {
          judgeAction = 'buy';
          judgeConf = parseFloat(parsed.confidence) || 0;
          judgeTarget = parsed.target_symbol || null;
          judgeStopLoss = parsed.stop_loss ? parseFloat(parsed.stop_loss) : null;
          judgeTakeProfit = parsed.take_profit ? parseFloat(parsed.take_profit) : null;
          judgeReasoning = String(parsed.reasoning || '');
        }
      } catch (e) {
        console.log(`  [${cfg.id}] ERROR: ${(e as Error).message.slice(0, 60)}`);
      }
    }

    // ── Record escalation event ───────────────────────────────────────────────
    let entryPrice: number | null = null;
    let parsedSym: { isCall: boolean; strike: number } | null = null;
    if (judgeAction === 'buy' && judgeTarget) {
      parsedSym = parseOptionSymbol(String(judgeTarget));
      if (parsedSym) {
        const key = `${parsedSym.isCall ? 'call' : 'put'}_${parsedSym.strike}`;
        entryPrice = contractMap.get(key)?.close ?? null;
      }
    }

    escalations.push({
      ts, et: timeLabel, rsi, direction,
      judgeDecision: judgeAction,
      judgeConfidence: judgeConf,
      targetSymbol: judgeTarget,
      entryPrice,
      reasoning: judgeReasoning,
    });

    // ── Open position if judge says buy ──────────────────────────────────────
    if (judgeAction === 'buy' && judgeTarget && entryPrice !== null && parsedSym) {
      const { isCall, strike } = parsedSym;

      if (entryPrice > 0) {
        // Sanity-check judge stop/TP — judges sometimes return SPX price not option price
        const rawStop = judgeStopLoss;
        const rawTp   = judgeTakeProfit;
        const stopLoss   = (rawStop  && rawStop  < entryPrice && rawStop  > entryPrice * 0.3) ? rawStop  : entryPrice * 0.50;
        const takeProfit = (rawTp    && rawTp    > entryPrice && rawTp    < entryPrice * 30)  ? rawTp    : entryPrice * 10.0;
        const qty = Math.floor(250 / (entryPrice * 100)) || 1;    // ~$250 risk

        openPos = {
          symbol: judgeTarget, side: isCall ? 'call' : 'put', strike,
          qty, entryPrice, stopLoss, takeProfit,
          entryTs: ts, entryET: timeLabel,
        };
        console.log(`  📈 ENTER ${judgeTarget} x${qty} @ $${entryPrice.toFixed(2)} | stop=$${stopLoss.toFixed(2)} tp=$${takeProfit.toFixed(2)}`);
      }
    }
  }

  // Force-close any remaining position at end of day
  if (openPos) {
    const finalTs = timestamps[timestamps.length - 1];
    const finalBars = getSpxBars(db, finalTs);
    const finalContracts = get0dteContracts(db, finalTs, finalBars[finalBars.length-1].close);
    const key = `${openPos.side}_${openPos.strike}`;
    const curPrice = finalContracts.find(c => `${c.type}_${c.strike}` === key)?.close ?? openPos.entryPrice;
    const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
    const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
    trades.push({
      symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
      entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
      exitTs: finalTs, exitET: etLabel(finalTs), exitPrice: curPrice,
      reason: 'time_exit', pnlPct, pnl$,
    });
    console.log(`\n  ⏱ EOD CLOSE ${openPos.symbol} @ $${curPrice.toFixed(2)} → ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`);
    openPos = null;
  }

  // ── Final report ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  FULL-DAY REPLAY RESULTS');
  console.log('═'.repeat(72));

  console.log(`\n📊 ESCALATION EVENTS (${escalations.length} total):`);
  for (const e of escalations) {
    const action = e.judgeDecision === 'buy'
      ? `BUY ${e.targetSymbol ?? '?'} @ $${e.entryPrice?.toFixed(2) ?? '?'} (conf=${(e.judgeConfidence*100).toFixed(0)}%)`
      : `WAIT`;
    console.log(`  [${e.et}] RSI=${e.rsi.toFixed(1)} ${e.direction.toUpperCase()} → ${action}`);
  }

  console.log(`\n💼 TRADES (${trades.length} total):`);
  let totalPnl = 0;
  let wins = 0;
  for (const t of trades) {
    totalPnl += t.pnl$;
    if (t.pnlPct > 0) wins++;
    const emoji = t.pnlPct >= 0 ? '✅' : '❌';
    console.log(`  ${emoji} ${t.side.toUpperCase()} ${t.strike} | Entry ${t.entryET}@$${t.entryPrice.toFixed(2)} → Exit ${t.exitET}@$${t.exitPrice.toFixed(2)}`);
    console.log(`     ${t.reason.toUpperCase()} | ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(0)}% | $${t.pnl$.toFixed(0)}`);
  }

  console.log(`\n📈 SUMMARY:`);
  console.log(`  Escalations triggered : ${escalations.length}`);
  console.log(`  Trades taken          : ${trades.length}`);
  console.log(`  Win rate              : ${trades.length ? ((wins/trades.length)*100).toFixed(0) : 0}%`);
  console.log(`  Total P&L             : $${totalPnl.toFixed(0)}`);
  console.log(`  Bars scanned          : ${timestamps.length}`);

  console.log(`\n🎯 BEST POSSIBLE (reference):`);
  console.log(`  14:34→15:07: C06600 $1.62→$33.82 = +1,986% ($3,220 on 2 contracts)`);
  console.log(`  13:14→13:30: C06575 $5.30→$15.50 = +192%   ($2,040 on 2 contracts)`);
  console.log(`  15:07→15:30: P06620 $8.80→$18.00 = +105%   ($920 on 1 contract)`);

  db.close();
}

main().catch(console.error);

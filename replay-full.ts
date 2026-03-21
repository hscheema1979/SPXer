/**
 * replay-full.ts — Full-day replay of March 20 2026 (CORRECTED)
 *
 * ACTUAL live system escalation logic:
 *   1. CONTRACT SIGNALS (primary): detectSignals() finds RSI/EMA/HMA crossovers on 0DTE options
 *   2. SPX SIGNALS (secondary): price-action confluence + RSI extremes on underlying
 *   3. REGIME GATE: blocks trades that don't fit the current market structure
 *
 * Key insight: When contract signals + SPX signals conflict, regime decides direction.
 * Example: SPX RSI=11.7 oversold + P6525 HMA bullish → in TRENDING_DOWN, puts are momentum.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { getJudgeConfigs, askModel } from './src/agent/model-clients';
import { initSession as initRegimeSession, classify, getSignalGate, formatRegimeContext } from './src/agent/regime-classifier';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');

const SESSION_START  = 1774013400;
const SESSION_END    = SESSION_START + 390 * 60;
const CLOSE_CUTOFF   = SESSION_END - 15 * 60;
const PRIOR_CLOSE    = 6606.49;

const RSI_OVERSOLD_EXTREME   = 20;
const RSI_OVERBOUGHT_EXTREME = 80;
const ESCALATION_COOLDOWN    = 10 * 60;

function etLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

interface Bar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
  indicators: Record<string, number | null>;
}

interface ContractBar {
  symbol: string; type: string; strike: number;
  close: number; volume: number; high: number; low: number;
  indicators: Record<string, number | null>;
}

interface OptionSignal {
  symbol: string; type: 'call' | 'put'; strike: number;
  signalType: 'RSI_CROSS' | 'EMA_CROSS' | 'HMA_CROSS';
  direction: 'bullish' | 'bearish';
  rsi?: number; ema9?: number; ema21?: number; hma5?: number; hma19?: number;
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

function get0dteContractBars(db: Database.Database, atTs: number, spxPrice: number, n = 3): Map<string, Bar[]> {
  const rows = db.prepare(`
    SELECT b.symbol, b.ts, b.open, b.high, b.low, b.close, b.volume, b.indicators
    FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE '%260320%' AND b.timeframe = '1m' AND b.ts <= ?
      AND c.strike BETWEEN ? AND ?
    ORDER BY b.symbol, b.ts DESC
  `).all(atTs, spxPrice - 60, spxPrice + 60) as any[];

  const bySymbol = new Map<string, Bar[]>();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push({
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      indicators: JSON.parse(r.indicators || '{}'),
    });
  }
  // Reverse each to chronological order and limit to n
  for (const [, bars] of bySymbol) {
    bars.reverse();
    if (bars.length > n) bars.splice(0, bars.length - n);
  }
  return bySymbol;
}

/** Detect option contract signals (RSI/EMA/HMA crosses on individual 0DTE options) */
function detectOptionSignals(contractBars: Map<string, Bar[]>, spxPrice: number): OptionSignal[] {
  const signals: OptionSignal[] = [];

  for (const [symbol, bars] of contractBars) {
    if (bars.length < 2) continue;

    const curr = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const ind = curr.indicators;
    const prevInd = prev.indicators;

    if (!ind.rsi14 || !prevInd.rsi14) continue;

    // Extract strike and type (FIXED: regex must properly parse SPXW260320P06525000 → strike=6525, not 65250)
    const match = symbol.match(/([CP])(\d{4,5})(?:000)?$/);
    if (!match) continue;
    const [, type, strikeStr] = match;
    const strike = parseInt(strikeStr);
    const isCall = type === 'C';

    // Signal 1: RSI crossed below 30 (oversold on option)
    if (prevInd.rsi14! >= 30 && ind.rsi14! < 30) {
      signals.push({
        symbol,
        type: isCall ? 'call' : 'put',
        strike,
        signalType: 'RSI_CROSS',
        direction: 'bullish', // option is getting cheaper / oversold
        rsi: ind.rsi14,
      });
    }

    // Signal 2: RSI crossed above 70 (overbought on option)
    if (prevInd.rsi14! <= 70 && ind.rsi14! > 70) {
      signals.push({
        symbol,
        type: isCall ? 'call' : 'put',
        strike,
        signalType: 'RSI_CROSS',
        direction: 'bearish', // option is getting expensive / overbought
        rsi: ind.rsi14,
      });
    }

    // Signal 3: HMA5 crossed above HMA19 (bullish momentum on option)
    if (prevInd.hma5 && prevInd.hma19 && ind.hma5 && ind.hma19 &&
        prevInd.hma5 < prevInd.hma19 && ind.hma5 >= ind.hma19) {
      signals.push({
        symbol,
        type: isCall ? 'call' : 'put',
        strike,
        signalType: 'HMA_CROSS',
        direction: 'bullish',
        hma5: ind.hma5,
        hma19: ind.hma19,
      });
    }

    // Signal 4: HMA5 crossed below HMA19 (bearish momentum on option)
    if (prevInd.hma5 && prevInd.hma19 && ind.hma5 && ind.hma19 &&
        prevInd.hma5 >= prevInd.hma19 && ind.hma5 < ind.hma19) {
      signals.push({
        symbol,
        type: isCall ? 'call' : 'put',
        strike,
        signalType: 'HMA_CROSS',
        direction: 'bearish',
        hma5: ind.hma5,
        hma19: ind.hma19,
      });
    }
  }

  return signals;
}

function getSessionTimestamps(db: Database.Database): number[] {
  return (db.prepare(`
    SELECT ts FROM bars WHERE symbol='SPX' AND timeframe='1m'
    AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(SESSION_START, SESSION_END) as any[]).map((r: any) => r.ts);
}

function parseOptionSymbol(sym: string): { isCall: boolean; strike: number } | null {
  const s = sym.replace(/\s+/g, '');
  const m = s.match(/([CP])(\d{4,5})(?:000)?$/i);
  if (!m) return null;
  return { isCall: m[1].toUpperCase() === 'C', strike: parseInt(m[2]) };
}

function getPosPrice(db: Database.Database, side: string, strike: number, atTs: number): number | null {
  const rows = db.prepare(`
    SELECT b.close FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE c.type = ? AND c.strike = ? AND b.symbol LIKE '%260320%'
      AND b.timeframe = '1m' AND b.ts <= ?
    ORDER BY b.ts DESC LIMIT 1
  `).all(side, strike, atTs) as any[];
  return rows.length ? rows[0].close : null;
}

const JUDGE_SYSTEM = `You are a senior 0DTE SPX trader. Option contract signals (HMA/EMA crosses on P6525, C6500, etc.) are PRIMARY.
Judge whether to enter based on:
- Option contract momentum (which direction is the option itself trending?)
- SPX regime (does it support that direction?)
- Time to expiry + leverage potential

Be AGGRESSIVE on option momentum signals — they fire infrequently and are high-probability.
Respond ONLY with JSON: {"action": "buy"|"wait", "target_symbol": "...", "confidence": 0-1, "stop_loss": null|price, "take_profit": null|price, "reasoning": "..."}`;

function buildPrompt(ts: number, spxBars: Bar[], optionSignals: OptionSignal[], regime: string, regimeContext: string): string {
  const spx = spxBars[spxBars.length - 1];
  const signalDesc = optionSignals.map(s => 
    `${s.symbol}: ${s.signalType} ${s.direction.toUpperCase()} (RSI=${s.rsi?.toFixed(1) ?? '?'})`
  ).join('\n  ');

  return `${regimeContext}

⚡ OPTION CONTRACT SIGNALS DETECTED:
${signalDesc || '  (none)'}

SPX: ${spx.close.toFixed(2)} RSI=${spx.indicators.rsi14?.toFixed(1) ?? '?'}

TIME: ${etLabel(ts)} ET | ${Math.max(0, Math.floor((SESSION_END - ts) / 60))}m to close

---
Option contract signals are primary escalation triggers.
Determine which signal to trade based on regime fit.
In ${regime}: calls ${getSignalGate(regime as any).allowOversoldFade ? 'ALLOWED' : 'BLOCKED'}, puts ${getSignalGate(regime as any).allowOverboughtFade ? 'ALLOWED' : 'BLOCKED'}.`;
}

interface SimPosition {
  id: string;
  symbol: string; side: 'call' | 'put'; strike: number; qty: number;
  entryPrice: number; stopLoss: number; takeProfit: number;
  entryTs: number; entryET: string;
}

interface Trade {
  symbol: string; side: 'call' | 'put'; strike: number; qty: number;
  entryTs: number; entryET: string; entryPrice: number;
  exitTs: number; exitET: string; exitPrice: number;
  reason: 'stop_loss' | 'take_profit' | 'time_exit';
  pnlPct: number; pnl$: number;
  signalType: string;
}

function extractJSON(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

async function main() {
  const db = getDb();
  const timestamps = getSessionTimestamps(db);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  SPXer Full-Day Replay — March 20 2026 (SIGNAL-DETECTOR BASED)`);
  console.log(`  ${timestamps.length} bars | Option contract signals PRIMARY`);
  console.log('═'.repeat(72));

  const allJudges = getJudgeConfigs();
  const replayJudges = allJudges.filter(j => ['haiku', 'opus'].includes(j.id));
  console.log(`  Judges: ${replayJudges.map(j => j.label).join(', ')}\n`);

  initRegimeSession(PRIOR_CLOSE);

  const trades: Trade[] = [];
  const openPositions = new Map<string, SimPosition>();
  let lastEscalationTs = 0;

  for (const ts of timestamps) {
    const spxBars = getSpxBars(db, ts);
    if (spxBars.length < 5) continue;
    const spx = spxBars[spxBars.length - 1];

    // ── Position monitoring (check ALL open positions) ────────────────────────
    for (const [posId, openPos] of openPositions.entries()) {
      const curPrice = getPosPrice(db, openPos.side, openPos.strike, ts);
      if (curPrice !== null) {
        let closeReason: Trade['reason'] | null = null;
        if (curPrice <= openPos.stopLoss) {
          closeReason = 'stop_loss';
        } else if (curPrice >= openPos.takeProfit) {
          closeReason = 'take_profit';
        } else if (ts >= CLOSE_CUTOFF) {
          closeReason = 'time_exit';
        }

        if (closeReason) {
          const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
          const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
          trades.push({
            symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
            entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
            exitTs: ts, exitET: etLabel(ts), exitPrice: curPrice,
            reason: closeReason, pnlPct, pnl$, signalType: '',
          });
          const emoji = pnlPct >= 0 ? '✅' : '❌';
          console.log(`  ${emoji} CLOSE [${etLabel(ts)}] ${openPos.symbol} ${closeReason}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`);
          openPositions.delete(posId);
        }
      }
    }

    // ── Detect option contract signals (PRIMARY) ────────────────────────────
    const contractBars = get0dteContractBars(db, ts, spx.close);
    const optionSignals = detectOptionSignals(contractBars, spx.close);

    // ── Regime classification ────────────────────────────────────────────────
    const regimeState = classify({ close: spx.close, high: spx.high, low: spx.low, ts });
    const regimeContext = formatRegimeContext(regimeState);

    // ── Check for escalation ─────────────────────────────────────────────────
    if (ts >= CLOSE_CUTOFF) continue;
    if (ts - lastEscalationTs < ESCALATION_COOLDOWN) continue;
    if (optionSignals.length === 0) continue;

    console.log(`\n⚡ [${etLabel(ts)}] ${optionSignals.length} OPTION SIGNALS | regime=${regimeState.regime}`);
    for (const sig of optionSignals) {
      console.log(`   ${sig.symbol}: ${sig.signalType} ${sig.direction.toUpperCase()}`);
    }

    // ── Call judges ──────────────────────────────────────────────────────────
    const prompt = buildPrompt(ts, spxBars, optionSignals, regimeState.regime, regimeContext);

    let judgeAction: 'buy' | 'wait' = 'wait';
    let judgeConf = 0;
    let judgeTarget: string | null = null;
    let judgeStop: number | null = null;
    let judgeTp: number | null = null;

    for (const cfg of replayJudges) {
      try {
        const text = await askModel(cfg, JUDGE_SYSTEM, prompt, 90000);
        const parsed = JSON.parse(extractJSON(text));
        console.log(`  [${cfg.id}] ${(parsed.action || 'wait').toUpperCase()} conf=${((parsed.confidence || 0) * 100).toFixed(0)}% ${parsed.target_symbol ?? ''}`);

        if (parsed.action === 'buy' && (parsed.confidence || 0) > judgeConf) {
          judgeAction = 'buy';
          judgeConf = parseFloat(parsed.confidence) || 0;
          judgeTarget = parsed.target_symbol || null;
          judgeStop = parsed.stop_loss;
          judgeTp = parsed.take_profit;
        }
      } catch (e) {
        console.log(`  [${cfg.id}] ERROR`);
      }
    }

    // ── Regime gate final check ──────────────────────────────────────────────
    if (judgeAction === 'buy' && judgeTarget) {
      const isCall = judgeTarget.includes('C');
      const gate = getSignalGate(regimeState.regime as any);
      const allowed = isCall ? gate.allowOversoldFade : gate.allowOverboughtFade;
      if (!allowed) {
        console.log(`  🚫 REGIME BLOCKED`);
        judgeAction = 'wait';
      }
    }

    // ── Open position (allow multiple positions) ───────────────────────────
    if (judgeAction === 'buy' && judgeTarget) {
      // Don't open duplicate position on same symbol
      if (!openPositions.has(judgeTarget)) {
        const parsed = parseOptionSymbol(judgeTarget);
        if (parsed) {
          // Get entry price from most recent bar for this contract
          const bars = contractBars.get(judgeTarget);
          const entryPrice = bars?.[bars.length - 1]?.close ?? null;

          if (entryPrice && entryPrice > 0) {
            const stopLoss = judgeStop && judgeStop > 0 && judgeStop < entryPrice ? judgeStop : entryPrice * 0.50;
            const takeProfit = judgeTp && judgeTp > entryPrice ? judgeTp : entryPrice * 10;
            const qty = Math.floor(250 / (entryPrice * 100)) || 1;

            const posId = `${judgeTarget}_${ts}`;
            openPositions.set(posId, {
              id: posId,
              symbol: judgeTarget,
              side: parsed.isCall ? 'call' : 'put',
              strike: parsed.strike,
              qty,
              entryPrice,
              stopLoss,
              takeProfit,
              entryTs: ts,
              entryET: etLabel(ts),
            });
            console.log(`  📈 ENTER ${judgeTarget} x${qty} @ $${entryPrice.toFixed(2)} | stop=$${stopLoss.toFixed(2)} tp=$${takeProfit.toFixed(2)}`);
          }
        }
      }
    }
  }

  // ── EOD close (all remaining positions) ──────────────────────────────────────
  const finalTs = timestamps[timestamps.length - 1];
  for (const [, openPos] of openPositions.entries()) {
    const curPrice = getPosPrice(db, openPos.side, openPos.strike, finalTs) ?? openPos.entryPrice;
    const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
    const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
    trades.push({
      symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
      entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
      exitTs: finalTs, exitET: etLabel(finalTs), exitPrice: curPrice,
      reason: 'time_exit', pnlPct, pnl$, signalType: '',
    });
    console.log(`  ⏱ EOD CLOSE ${openPos.symbol} @ $${curPrice.toFixed(2)} → ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`);
  }

  // ── Final report ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  REPLAY RESULTS`);
  console.log('═'.repeat(72));

  console.log(`\n💼 TRADES (${trades.length} total):`);
  let totalPnl = 0, wins = 0;
  for (const t of trades) {
    totalPnl += t.pnl$;
    if (t.pnlPct > 0) wins++;
    const emoji = t.pnlPct >= 0 ? '✅' : '❌';
    console.log(`  ${emoji} ${t.side.toUpperCase()} ${t.strike} | ${t.entryET}@$${t.entryPrice.toFixed(2)} → ${t.exitET}@$${t.exitPrice.toFixed(2)} | ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(0)}% ($${t.pnl$.toFixed(0)})`);
  }

  console.log(`\n📈 SUMMARY:`);
  console.log(`  Trades: ${trades.length} | Win rate: ${trades.length ? ((wins / trades.length) * 100).toFixed(0) : 0}%`);
  console.log(`  Total P&L: $${totalPnl.toFixed(0)}`);

  db.close();
}

main().catch(console.error);

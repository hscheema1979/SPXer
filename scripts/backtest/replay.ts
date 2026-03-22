/**
 * replay.ts — Post-market judge comparison replay
 *
 * Reconstructs the 4 key RSI-extreme moments from today's session
 * and feeds each to Sonnet, Opus, Kimi, and GLM judges in parallel.
 * Scores each judge against actual price outcomes.
 *
 * Usage: npx ts-node replay.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { getJudgeConfigs, askModel } from '../../src/agent/model-clients';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');

// ── DB helpers ──────────────────────────────────────────────────────────────

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, number | null>;
}

interface ContractBar {
  symbol: string;
  type: string;
  strike: number;
  close: number;
  volume: number;
  high: number;
  low: number;
}

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

/** Epoch for a given ET hour:minute on today (2026-03-19, EDT=UTC-4) */
function etEpoch(h: number, m: number): number {
  // 09:30 ET = 1773927000 (calibrated from DB)
  return 1773927000 + (h - 9) * 3600 + (m - 30) * 60;
}

function getSpxBars(db: Database.Database, atTs: number, n = 25): Bar[] {
  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM bars WHERE symbol = 'SPX' AND timeframe = '1m' AND ts <= ?
    ORDER BY ts DESC LIMIT ?
  `).all(atTs, n) as any[];
  return rows.reverse().map(r => ({
    ...r,
    indicators: JSON.parse(r.indicators || '{}'),
  }));
}

function get0dteContracts(db: Database.Database, atTs: number, spxPrice: number): ContractBar[] {
  const rows = db.prepare(`
    SELECT b.symbol, c.type, c.strike, b.close, b.volume, b.high, b.low
    FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE '%260319%'
      AND b.timeframe = '1m'
      AND b.ts = (
        SELECT MAX(b2.ts) FROM bars b2
        WHERE b2.symbol = b.symbol AND b2.timeframe = '1m' AND b2.ts <= ?
      )
      AND c.strike BETWEEN ? AND ?
    ORDER BY c.type, c.strike
  `).all(atTs, spxPrice - 60, spxPrice + 60) as any[];
  return rows;
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function formatBars(bars: Bar[]): string {
  return bars.slice(-5).map(b => {
    const rsi = b.indicators.rsi14?.toFixed(1) ?? '-';
    const ema9 = b.indicators.ema9?.toFixed(2) ?? '-';
    return `  [${new Date((b.ts) * 1000).toISOString().slice(11, 16)}Z] C=${b.close.toFixed(2)} RSI=${rsi} EMA9=${ema9} Vol=${b.volume}`;
  }).join('\n');
}

function buildReplayPrompt(
  timeET: string,
  minutesToClose: number,
  spxBars: Bar[],
  contracts: ContractBar[],
  scannerReads: string,
): string {
  const spx = spxBars[spxBars.length - 1];
  const ind = spx.indicators;
  const rsi = ind.rsi14?.toFixed(1) ?? '-';
  const ema9 = ind.ema9?.toFixed(2) ?? '-';
  const ema21 = ind.ema21?.toFixed(2) ?? '-';

  // Build trend from last 3 bars
  const prev3 = spxBars.slice(-3);
  const trend = prev3.length >= 3
    ? (prev3[2].close > prev3[0].close ? 'bullish' : prev3[2].close < prev3[0].close ? 'bearish' : 'neutral')
    : 'neutral';

  // 3m/5m aggregated close
  const bars3m = spxBars.slice(-3);
  const bars5m = spxBars.slice(-5);
  const rsi3m = bars3m[bars3m.length - 1]?.indicators.rsi14?.toFixed(1) ?? '-';
  const rsi5m = bars5m[bars5m.length - 1]?.indicators.rsi14?.toFixed(1) ?? '-';

  const calls = contracts.filter(c => c.type === 'call').sort((a, b) => a.strike - b.strike);
  const puts  = contracts.filter(c => c.type === 'put').sort((a, b) => a.strike - b.strike);

  const callBlock = calls.map(c => {
    const tag = c.strike < spx.close ? 'ITM' : `OTM+${(c.strike - spx.close).toFixed(0)}`;
    return `  SPXW260319C${String(c.strike * 1000).padStart(8,'0')} K=${c.strike} (${tag}): $${c.close.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} vol=${c.volume}`;
  }).join('\n');

  const putBlock = puts.reverse().map(c => {
    const tag = c.strike > spx.close ? 'ITM' : `OTM-${(spx.close - c.strike).toFixed(0)}`;
    return `  SPXW260319P${String(c.strike * 1000).padStart(8,'0')} K=${c.strike} (${tag}): $${c.close.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} vol=${c.volume}`;
  }).join('\n');

  return `TIME: ${timeET} | ${minutesToClose}m to close | Mode: rth

SPX UNDERLYING:
  Price: ${spx.close.toFixed(2)}
  1m [trend:${trend}]: close=${spx.close.toFixed(2)} rsi=${rsi} ema9=${ema9} ema21=${ema21}
  3m rsi=${rsi3m} | 5m rsi=${rsi5m}

  Last 5 bars:
${formatBars(spxBars)}

OPEN POSITIONS (0/3 max):
  None

RISK:
  Daily P&L: $0.00 | Daily loss limit: $500 | Max risk/trade: $250 | Paper mode: true

TRACKED 0DTE CONTRACTS (SPXW260319, sorted by strike):
CALLS:
${callBlock}

PUTS:
${putBlock}

SPY FLOW: Unavailable (replay mode)

---
SCANNER ASSESSMENTS:
${scannerReads}

---
Review the scanner flags alongside the full data. Make the call.`;
}

const JUDGE_SYSTEM = `You are a senior 0DTE SPX options trader making the final call.

Multiple junior analysts have been scanning the market and flagged potential setups.
You now review their assessments alongside the FULL market data to decide whether to act.

Your edge is reading flow AND technicals together:
- Multi-timeframe alignment (2+ TFs) is ideal but NOT required when macro flow
  provides a clear thesis (e.g., delta unwind into close, gamma squeeze, pin risk).
- SPY put/call ratio, volume flow, and Greeks data tell you WHERE institutions are
  positioned. When flow says "forced buying/selling ahead", that IS the signal —
  don't wait for lagging indicators to confirm what flow already tells you.
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

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "market_read": "<your senior assessment>",
  "scanner_agreement": "<do the juniors agree? what did they miss?>",
  "action": "buy" | "sell_to_close" | "wait",
  "target_symbol": "<full option symbol or null>",
  "confidence": <0.0-1.0>,
  "position_size": <contracts, 0 if wait>,
  "stop_loss": <price or null>,
  "take_profit": <price or null>,
  "reasoning": "<why this action or why waiting>",
  "concerns": ["<concern>"],
  "next_check_secs": <15-60>
}`;

// ── Replay moments ──────────────────────────────────────────────────────────

const MOMENTS = [
  {
    label: '11:30 ET — RSI=19.3 (extreme oversold, first drop)',
    ts: etEpoch(11, 30),
    minutesToClose: 270,
    outcomeTs: etEpoch(12, 0),   // +30m outcome
    outcomeDesc: 'SPX rallied +7pts (6579→6586) then flat — modest bounce',
    scannerReads: `  KIMI says: "SPX RSI 19.3 — extreme oversold on 1m. Price broke below EMA21. Watching for mean-reversion trigger."
    - SPXW260319C06580: RSI_divergence_setup (conf=0.55, urgency=building) — if RSI turns up from here, ATM calls cheap at $7-9

  GLM says: "Oversold but no volume confirmation. 3m RSI also compressed. Could bounce or continue lower."
    - No setups above threshold

  HAIKU says: "SPX RSI 19 with EMA21 break. 0DTE calls at support level. Tight risk available."
    - SPXW260319C06580: mean_reversion_entry (conf=0.52, urgency=building) — RSI <20 historically bounces within 10 bars`,
  },
  {
    label: '13:14 ET — RSI=20.1 (session low 6566, pre-recovery)',
    ts: etEpoch(13, 14),
    minutesToClose: 166,
    outcomeTs: etEpoch(13, 30),  // +16m outcome
    outcomeDesc: 'SPX ripped from 6566→6582 (+16pts) then 6582→6582 → held gains. RSI hit 89-92!',
    scannerReads: `  KIMI says: "NEW SESSION LOW. SPX at 6566, RSI 20.1 — this is the cleanest oversold read of the day. Last time RSI was here (11:30) we got a bounce. Volume picking up on puts = capitulation. CALLS NOW."
    - SPXW260319C06570: extreme_oversold_reversal (conf=0.72, urgency=now) — RSI <21 + new low + put volume peak
    - SPXW260319C06575: extreme_oversold_reversal (conf=0.68, urgency=now) — tight stop at $2.50

  GLM says: "Session low 6566, RSI 20. Institutional put buying may be exhausted. Risk/reward favors calls."
    - SPXW260319C06570: mean_reversion (conf=0.61, urgency=building) — watch for RSI curl

  HAIKU says: "SPX RSI 20 at session low. ATM calls $4-6. 166 minutes to close. Strong mean-reversion setup."
    - SPXW260319C06575: rsi_extreme_bounce (conf=0.65, urgency=now) — enter on next green 1m candle`,
  },
  {
    label: '14:34 ET — RSI=8.4!!! (extreme EXTREME oversold — biggest of day)',
    ts: etEpoch(14, 34),
    minutesToClose: 86,
    outcomeTs: etEpoch(15, 7),   // +33m outcome
    outcomeDesc: 'SPX RIPPED from 6579→6634 (+55pts!) in 33 minutes. RSI hit 94.2. C06600 went $1.62→$33.82 (+1,986%). C06615 went $0.55→$23.20 (+4,118%).',
    scannerReads: `  KIMI says: "RSI 8.4 — I have NEVER seen this. This is not a condition, this is a signal. Every mean-reversion system would be screaming BUY CALLS right now. SPX at 6579, OTM calls are priced as if SPX never moves again. C06600 at $1.62 is a lottery ticket at RSI=8. If SPX bounces even 15 points, that's 10x."
    - SPXW260319C06600: rsi_extreme_emergency (conf=0.90, urgency=now) — RSI=8.4 is 3-sigma oversold. Entry $1.62 stop $0.80
    - SPXW260319C06610: gamma_squeeze_setup (conf=0.75, urgency=now) — $0.73 entry with 86m left, stop at $0.35
    - SPXW260319C06590: rsi_bounce_entry (conf=0.80, urgency=now) — $3.80 entry, stop $1.90

  GLM says: "RSI 8.4 is statistically anomalous. In 0DTE, this extreme means one of two things: (1) catastrophic news event (none) or (2) forced selling that is nearly exhausted. No news event = forced selling = buy calls aggressively."
    - SPXW260319C06600: statistical_extreme (conf=0.82, urgency=now) — RSI=8 is >3σ. High probability bounce.
    - SPXW260319C06605: gamma_play (conf=0.70, urgency=now) — entry $1.10, stop $0.55

  HAIKU says: "SPX RSI 8.4. 86 minutes to close. OTM calls extremely cheap. This is the entry."
    - SPXW260319C06595: extreme_oversold (conf=0.75, urgency=now) — $2.49 entry stop $1.20
    - SPXW260319C06600: extreme_oversold (conf=0.78, urgency=now) — $1.62 entry stop $0.80`,
  },
  {
    label: '15:07 ET — RSI=93.1 (extreme overbought — flip to puts?)',
    ts: etEpoch(15, 7),
    minutesToClose: 53,
    outcomeTs: etEpoch(15, 30),  // +23m outcome
    outcomeDesc: 'SPX pulled back from 6624→6607 (-17pts). P06620 went $8.80→$18+ (reversal play).',
    scannerReads: `  KIMI says: "RSI 93.1 — mirror of the 8.4 situation. Extreme overbought after a 55-point rip. Take profits on calls. Put entry setup forming. P06620 at $8.80 with RSI >90."
    - SPXW260319P06620: rsi_overbought_reversal (conf=0.72, urgency=now) — flip to puts, tight stop
    - SPXW260319P06625: sell_calls_buy_puts (conf=0.65, urgency=building)

  GLM says: "53 minutes to close, RSI 93 after 55-point rally. Mean reversion likely. OTM puts offer leverage."
    - SPXW260319P06620: overbought_fade (conf=0.68, urgency=now)

  HAIKU says: "RSI 93 = overbought extreme. Puts now. 53 minutes gives enough time for reversal."
    - SPXW260319P06615: rsi_extreme_fade (conf=0.70, urgency=now)`,
  },
];

// ── Scoring ──────────────────────────────────────────────────────────────────

interface JudgeDecision {
  judgeId: string;
  action: string;
  targetSymbol: string | null;
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reasoning: string;
  error?: string;
}

interface ReplayResult {
  momentLabel: string;
  outcomeDesc: string;
  decisions: JudgeDecision[];
  scores: { judgeId: string; pnlPct: number | null; correct: boolean; reason: string }[];
}

function extractJSON(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

async function replayMoment(
  db: Database.Database,
  moment: typeof MOMENTS[0],
): Promise<ReplayResult> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`REPLAYING: ${moment.label}`);
  console.log('═'.repeat(70));

  const spxBars = getSpxBars(db, moment.ts);
  const spx = spxBars[spxBars.length - 1];
  const contracts = get0dteContracts(db, moment.ts, spx.close);

  console.log(`  SPX=${spx.close.toFixed(1)} RSI=${spx.indicators.rsi14?.toFixed(1)} | ${contracts.length} contracts | ${moment.minutesToClose}m to close`);

  const prompt = buildReplayPrompt(
    moment.label.split('—')[0].trim(),
    moment.minutesToClose,
    spxBars,
    contracts,
    moment.scannerReads,
  );

  // Get entry prices for key contracts
  const contractMap = new Map(contracts.map(c => [`${c.type}_${c.strike}`, c]));

  // Run judges sequentially to avoid claude session contention
  const judgeConfigs = getJudgeConfigs();
  console.log(`  Running ${judgeConfigs.length} judges sequentially...`);

  const rawResults: PromiseSettledResult<JudgeDecision>[] = [];
  for (const cfg of judgeConfigs) {
    rawResults.push(await (async (): Promise<PromiseSettledResult<JudgeDecision>> => {
      try {
        const text = await askModel(cfg, JUDGE_SYSTEM, prompt, 90000);
        const clean = extractJSON(text);
        const parsed = JSON.parse(clean);

        // Find entry price for target symbol
        let entryPrice: number | null = null;
        if (parsed.target_symbol) {
          const sym = String(parsed.target_symbol);
          const isCall = sym.includes('C0') || sym.toLowerCase().includes('call');
          const strikeMatch = sym.match(/[CP]0*(\d+)000$/);
          const strike = strikeMatch ? parseInt(strikeMatch[1]) : null;
          if (strike) {
            const key = `${isCall ? 'call' : 'put'}_${strike}`;
            const c = contractMap.get(key);
            entryPrice = c?.close ?? parsed.stop_loss ? parseFloat(parsed.stop_loss) * 1.5 : null;
          }
        }

        console.log(`  [${cfg.id}] ${parsed.action?.toUpperCase()} conf=${(parsed.confidence*100).toFixed(0)}% ${parsed.target_symbol ?? ''}`);
        console.log(`     → ${String(parsed.reasoning).slice(0, 150)}`);

        return { status: 'fulfilled' as const, value: {
          judgeId: cfg.id,
          action: parsed.action || 'wait',
          targetSymbol: parsed.target_symbol || null,
          confidence: parseFloat(parsed.confidence) || 0,
          entryPrice,
          stopLoss: parsed.stop_loss ? parseFloat(parsed.stop_loss) : null,
          takeProfit: parsed.take_profit ? parseFloat(parsed.take_profit) : null,
          reasoning: String(parsed.reasoning || ''),
        } as JudgeDecision };
      } catch (e) {
        console.log(`  [${cfg.id}] ERROR: ${(e as Error).message.slice(0, 80)}`);
        return { status: 'rejected' as const, reason: (e as Error).message };
      }
    })());
  }
  const results = rawResults;

  const decisions = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : {
      judgeId: judgeConfigs[i].id, action: 'wait', targetSymbol: null,
      confidence: 0, entryPrice: null, stopLoss: null, takeProfit: null,
      reasoning: '', error: String((r as PromiseRejectedResult).reason),
    }
  );

  // Score each decision
  const outcomeContracts = get0dteContracts(db, moment.outcomeTs, spx.close);
  const outcomeMap = new Map(outcomeContracts.map(c => [`${c.type}_${c.strike}`, c]));

  const scores = decisions.map(d => {
    if (d.action === 'wait' || !d.targetSymbol) {
      // Was waiting the right call?
      const correct = moment.label.includes('11:30');  // only at 11:30 was 'wait' defensible
      return { judgeId: d.judgeId, pnlPct: null, correct, reason: 'Waited — ' + (correct ? 'acceptable at 11:30' : 'MISSED THE MOVE') };
    }

    const sym = d.targetSymbol;
    const isCall = sym.includes('C0') || sym.toLowerCase().includes('call');
    const strikeMatch = sym.match(/[CP]0*(\d+)000$/);
    const strike = strikeMatch ? parseInt(strikeMatch[1]) : null;

    if (!strike || !d.entryPrice) {
      return { judgeId: d.judgeId, pnlPct: null, correct: false, reason: 'Could not determine entry' };
    }

    const key = `${isCall ? 'call' : 'put'}_${strike}`;
    const outcomeBar = outcomeMap.get(key);
    const exitPrice = outcomeBar?.close ?? null;

    if (!exitPrice) {
      return { judgeId: d.judgeId, pnlPct: null, correct: false, reason: `No outcome bar for ${sym}` };
    }

    const pnlPct = ((exitPrice - d.entryPrice) / d.entryPrice) * 100;
    const correct = pnlPct > 20;  // >20% gain = correct direction

    return {
      judgeId: d.judgeId,
      pnlPct,
      correct,
      reason: `Entry=$${d.entryPrice.toFixed(2)} Exit=$${exitPrice.toFixed(2)} → ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`,
    };
  });

  return { momentLabel: moment.label, outcomeDesc: moment.outcomeDesc, decisions, scores };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║         SPXer Judge Replay — March 19 2026                      ║');
  console.log('║  Testing: Sonnet, Opus, Kimi-judge, GLM-judge                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const db = getDb();
  const results: ReplayResult[] = [];

  for (const moment of MOMENTS) {
    const result = await replayMoment(db, moment);
    results.push(result);
  }

  db.close();

  // ── Final scorecard ───────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(70));
  console.log('FINAL SCORECARD');
  console.log('═'.repeat(70));

  // Aggregate by judge
  const judgeScores: Record<string, { correct: number; total: number; pnls: number[] }> = {};

  for (const result of results) {
    console.log(`\n📍 ${result.momentLabel}`);
    console.log(`   Outcome: ${result.outcomeDesc}`);

    for (const score of result.scores) {
      const icon = score.correct ? '✅' : score.pnlPct === null ? '⏸️' : '❌';
      const pnl = score.pnlPct !== null ? ` (${score.pnlPct >= 0 ? '+' : ''}${score.pnlPct.toFixed(0)}%)` : '';
      console.log(`   ${icon} ${score.judgeId.padEnd(12)}: ${score.reason}${pnl}`);

      if (!judgeScores[score.judgeId]) judgeScores[score.judgeId] = { correct: 0, total: 0, pnls: [] };
      judgeScores[score.judgeId].total++;
      if (score.correct) judgeScores[score.judgeId].correct++;
      if (score.pnlPct !== null) judgeScores[score.judgeId].pnls.push(score.pnlPct);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log('JUDGE PERFORMANCE SUMMARY');
  console.log('─'.repeat(70));

  const sorted = Object.entries(judgeScores).sort((a, b) => b[1].correct - a[1].correct);
  for (const [judgeId, s] of sorted) {
    const avgPnl = s.pnls.length > 0 ? (s.pnls.reduce((a, b) => a + b, 0) / s.pnls.length).toFixed(0) : 'N/A';
    const hitRate = ((s.correct / s.total) * 100).toFixed(0);
    console.log(`  ${judgeId.padEnd(14)}: ${s.correct}/${s.total} correct (${hitRate}%) | avg P&L ${avgPnl}%`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log('BEST POSSIBLE TRADES (for reference):');
  console.log('  14:34 ET entry → 15:07 ET outcome:');
  console.log('    C06600 $1.62 → $33.82 = +1,986%');
  console.log('    C06610 $0.73 → $26.00 = +3,462%');
  console.log('    C06615 $0.55 → $23.20 = +4,118%');
  console.log('    C06620 $0.42 → $19.40 = +4,519%');
  console.log('  13:14 ET entry → 13:30 ET outcome:');
  console.log('    C06575 $5.30 → $15.50 = +192%  (SPX +16pts in 16min)');
  console.log('  15:07 ET puts entry → 15:30 ET outcome:');
  console.log('    P06620 $8.80 → ~$18   = +105%  (SPX -17pts in 23min)');
  console.log('─'.repeat(70));

  // Save full results to file
  const reportPath = path.resolve(__dirname, 'logs/replay-report.json');
  require('fs').writeFileSync(reportPath, JSON.stringify({ results, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`\nFull results saved to: ${reportPath}`);
}

main().catch(e => { console.error('[replay] Fatal:', e); process.exit(1); });

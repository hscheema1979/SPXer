/**
 * live-monitor.ts — Parallel live market monitor.
 *
 * Polls SPX bars every 30s. When RSI hits extreme, fires ALL judges
 * in parallel — both WITH and WITHOUT regime context. Logs decisions.
 *
 * Usage: npx tsx live-monitor.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getJudgeConfigs, askModel, type ModelConfig } from './src/agent/model-clients';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');
const LOG_FILE = path.resolve(__dirname, `replay-library/live-${new Date().toISOString().slice(0,10)}.md`);

const PARAMS = {
  pollIntervalMs: 30_000,
  rsiOversoldTrigger: 20,
  rsiOverboughtTrigger: 80,
  cooldownBars: 10,
  trendThreshold: 0.15,
  morningEnd: 10 * 60 + 15,
  gammaStart: 14 * 60,
  noTrade: 15 * 60 + 30,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function linRegSlope(values: number[], period: number): number {
  const n = Math.min(values.length, period);
  if (n < 5) return 0;
  const s = values.slice(-n);
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += s[i]; sxy += i * s[i]; sx2 += i * i; }
  return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
}

function getETMinute(ts: number): number {
  const d = new Date(ts * 1000);
  const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [h, m] = (et.split(', ')[1] || et).split(':').map(Number);
  return h * 60 + m;
}

function etNow(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

type Regime = 'MORNING_MOMENTUM' | 'MEAN_REVERSION' | 'TRENDING_UP' | 'TRENDING_DOWN' | 'GAMMA_EXPIRY' | 'NO_TRADE';

function classifyRegime(minute: number, slope: number): Regime {
  const T = PARAMS.trendThreshold;
  if (minute >= PARAMS.noTrade) return 'NO_TRADE';
  if (minute >= PARAMS.gammaStart) return slope > T ? 'TRENDING_UP' : slope < -T ? 'TRENDING_DOWN' : 'GAMMA_EXPIRY';
  if (minute < PARAMS.morningEnd) return slope > T ? 'TRENDING_UP' : slope < -T ? 'TRENDING_DOWN' : 'MORNING_MOMENTUM';
  return slope > T ? 'TRENDING_UP' : slope < -T ? 'TRENDING_DOWN' : 'MEAN_REVERSION';
}

// ── Judge prompt builder ────────────────────────────────────────────────────

function buildPrompt(spxPrice: number, rsi: number, regime: Regime | null, contracts: string, recentBars: string): string {
  const regimeTag = regime ? `\n[Regime classifier says: ${regime}]` : '';

  return `SPX: ${spxPrice.toFixed(2)}
RSI(14): ${rsi.toFixed(1)}
${regimeTag}

Recent 1-minute bars (newest last):
${recentBars}

Available 0DTE contracts:
${contracts}
`;
}

const SYSTEM = `You are analyzing SPX (S&P 500 Index) options expiring today (0 days to expiration). You will be shown current market data. Tell us what you see and whether you would trade. If yes, specify the exact contract.

Reply in this EXACT format:
ACTION: BUY or PASS
DIRECTION: call or put
CONTRACT: symbol (e.g., SPXW260320C06650)
CONFIDENCE: 0-100
REASON: one sentence`;

// ── Log helper ──────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[${etNow()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  const judges = getJudgeConfigs();
  log(`Live monitor started. ${judges.length} judges loaded.`);
  log(`Judges: ${judges.map(j => j.label).join(', ')}`);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, `# Live Monitor — ${new Date().toISOString().slice(0,10)}\n\n`);

  let lastSignalTs = 0;
  let lastBarCount = 0;

  const poll = async () => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const startTs = Math.floor(new Date(today + 'T09:30:00-04:00').getTime() / 1000);
      const endTs = startTs + 390 * 60;

      const bars = db.prepare(`
        SELECT ts, open, high, low, close FROM bars WHERE symbol='SPX' AND timeframe='1m'
          AND ts >= ? AND ts <= ? ORDER BY ts
      `).all(startTs, endTs) as { ts: number; open: number; high: number; low: number; close: number }[];

      if (bars.length === lastBarCount) return; // no new data
      lastBarCount = bars.length;

      const closes = bars.map(b => b.close);
      const rsi = computeRSI(closes);
      const latest = bars[bars.length - 1];
      const minute = getETMinute(latest.ts);
      const slope = linRegSlope(closes, 20);
      const regime = classifyRegime(minute, slope);

      if (!rsi) return;

      // Status line every 5 bars
      if (bars.length % 5 === 0) {
        log(`SPX=${latest.close.toFixed(2)} RSI=${rsi.toFixed(1)} Regime=${regime} Bars=${bars.length}`);
      }

      const isOversold = rsi < PARAMS.rsiOversoldTrigger;
      const isOverbought = rsi > PARAMS.rsiOverboughtTrigger;
      if (!isOversold && !isOverbought) return;

      // Cooldown check
      if (latest.ts - lastSignalTs < PARAMS.cooldownBars * 60) return;
      lastSignalTs = latest.ts;

      const direction = isOversold ? 'call' : 'put';
      log(`\n${'═'.repeat(60)}`);
      log(`SIGNAL: RSI=${rsi.toFixed(1)} ${isOversold ? 'OVERSOLD' : 'OVERBOUGHT'} | SPX=${latest.close} | Regime=${regime}`);
      log(`${'═'.repeat(60)}`);

      // Get available contracts
      const expiry6 = today.slice(2).replace(/-/g, '');
      const contractRows = db.prepare(`
        SELECT b.symbol, c.type, c.strike, b.close as price
        FROM bars b JOIN contracts c ON b.symbol=c.symbol
        WHERE b.symbol LIKE ? AND b.timeframe='1m'
          AND b.ts = (SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe='1m' AND b2.ts<=?)
          AND c.type = ? AND c.strike BETWEEN ? AND ?
          AND b.close BETWEEN 0.20 AND 8.00
        ORDER BY c.strike
      `).all(
        `SPXW${expiry6}%`, latest.ts, direction,
        direction === 'call' ? latest.close : latest.close - 50,
        direction === 'call' ? latest.close + 50 : latest.close
      ) as any[];

      const contractStr = contractRows.length > 0
        ? contractRows.map((c: any) => `${c.symbol} ${c.type} ${c.strike} @ $${c.price.toFixed(2)}`).join('\n')
        : 'No OTM contracts in $0.20-$8.00 band';

      // Build recent bars string (last 20 bars — raw price action)
      const recentSlice = bars.slice(-20);
      const recentBarsStr = recentSlice.map(b => {
        const t = new Date(b.ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
        return `${t} O:${b.open.toFixed(2)} H:${b.high.toFixed(2)} L:${b.low.toFixed(2)} C:${b.close.toFixed(2)}`;
      }).join('\n');

      // Fire ALL scanners in parallel — WITH regime tag and WITHOUT
      const tasks: Array<{ label: string; config: ModelConfig; hasRegime: boolean }> = [];
      for (const j of judges) {
        tasks.push({ label: `${j.label} +REGIME`, config: j, hasRegime: true });
        tasks.push({ label: `${j.label} -REGIME`, config: j, hasRegime: false });
      }

      log(`Firing ${tasks.length} parallel scanner calls...`);

      const results = await Promise.allSettled(
        tasks.map(async (t) => {
          const prompt = buildPrompt(latest.close, rsi!, t.hasRegime ? regime : null, contractStr, recentBarsStr);
          const start = Date.now();
          const response = await askModel(t.config, SYSTEM, prompt, 60000);
          const elapsed = Date.now() - start;
          return { label: t.label, response, elapsed };
        })
      );

      // Log all results
      log(`\n| Judge | Action | Direction | Contract | Conf | Time | Reason |`);
      log(`|-------|--------|-----------|----------|------|------|--------|`);

      for (const r of results) {
        if (r.status === 'rejected') {
          const label = tasks[results.indexOf(r)]?.label || '?';
          log(`| ${label} | TIMEOUT | - | - | - | - | ${String(r.reason).slice(0,40)} |`);
          continue;
        }
        const { label, response, elapsed } = r.value;
        const actionMatch = response.match(/ACTION:\s*(BUY|PASS)/i);
        const dirMatch = response.match(/DIRECTION:\s*(call|put)/i);
        const contractMatch = response.match(/CONTRACT:\s*(\S+)/i);
        const confMatch = response.match(/CONFIDENCE:\s*(\d+)/i);
        const reasonMatch = response.match(/REASON:\s*(.+)/i);

        const action = actionMatch?.[1] || '?';
        const dir = dirMatch?.[1] || '?';
        const contract = contractMatch?.[1] || '?';
        const conf = confMatch?.[1] || '?';
        const reason = (reasonMatch?.[1] || '?').slice(0, 60);

        const mark = action.toUpperCase() === 'BUY' ? '🟢' : '⚪';
        log(`| ${mark} ${label} | ${action} | ${dir} | ${contract} | ${conf}% | ${(elapsed/1000).toFixed(1)}s | ${reason} |`);
      }

      log(`${'─'.repeat(60)}\n`);

    } finally {
      db.close();
    }
  };

  // Initial poll
  await poll();

  // Poll loop
  setInterval(async () => {
    try { await poll(); }
    catch (e: any) { log(`ERROR: ${e.message}`); }
  }, PARAMS.pollIntervalMs);

  log(`Polling every ${PARAMS.pollIntervalMs / 1000}s. Ctrl+C to stop.`);
}

main().catch(console.error);

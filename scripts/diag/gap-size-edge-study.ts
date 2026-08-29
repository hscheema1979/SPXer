/**
 * gap-size-edge-study.ts — Does gap-UP SIZE predict continuation vs fade?
 *
 * Per trading day per instrument we build:
 *   prevClose = prior day's last RTH 1m close (~16:00 ET)
 *   open      = 09:30 ET bar open (opening print)
 *   p935      = 09:35 ET bar close (early read)
 *   close     = today's last RTH 1m close (~16:00 ET, full day)
 *   sma20/ema10 = trailing DAILY moving averages of prevClose series (exclude today)
 *
 * Gap% = (open - prevClose)/prevClose * 100   (we study gap-UPS: gap% > minGap)
 *
 * Outcome (entered at the 09:30 open, long bias):
 *   dayMove% = (close - open)/open * 100
 *   earlyMove% = (p935 - open)/open * 100
 *   CONTINUATION = close > open (gap-up kept rising) ; FADE = close < open
 *
 * Buckets gap-ups by size and reports, per bucket:
 *   n, mean dayMove%, t-stat & p (mean≠0), win% (continue) & binomial p (≠50%),
 *   95% CI on mean move. Then repeats split by daily trend (open vs SMA20 / EMA10).
 *
 * Usage: npx tsx scripts/diag/gap-size-edge-study.ts [--profiles spx,ndx] [--minGap 0.1]
 */
import fs from 'fs';
import path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PROFILES = arg('profiles', 'spx,ndx').split(',').map(s => s.trim()).filter(Boolean);
const MIN_GAP = parseFloat(arg('minGap', '0.1'));  // gap-up = gap% > this

// ── stats helpers ───────────────────────────────────────────────────────────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const twoSidedP = (z: number) => 2 * (1 - normCdf(Math.abs(z)));
function meanStd(xs: number[]): { mean: number; sd: number } {
  const n = xs.length; if (!n) return { mean: NaN, sd: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, sd: Math.sqrt(v) };
}
const star = (p: number) => p < 0.01 ? '***' : p < 0.05 ? '**' : p < 0.10 ? '*' : '';

// ── data loading ────────────────────────────────────────────────────────────
interface Bar { ts: number; open: number; high: number; low: number; close: number }
function etMinuteOfDay(tsSec: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsSec * 1000));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60 + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function loadDay(profileId: string, date: string): Bar[] {
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const cache = loadBarCacheFromParquetSync({
    profileId, date, underlyingSymbol: profileId.toUpperCase(),
    symbolRange: { lo: '￿', hi: '￿' }, timeframe: '1m',
    startTs: dayStart, endTs: dayStart + 86400 - 1, skipContractIndicators: true,
  }) as any;
  const bars: Bar[] = (cache?.spxBars ?? []).map((b: any) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}

interface Row { date: string; prevClose: number; open: number; p935: number; close: number; sma20: number | null; ema10: number | null }
function buildRows(profileId: string): Row[] {
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) { console.error(`! no parquet dir for ${profileId}`); return []; }
  const dates = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f)).map(f => f.slice(0, 10)).sort();
  const rows: Row[] = [];
  const dailyCloses: number[] = [];   // trailing daily closes (most recent last)
  let ema10: number | null = null;
  let prevDayClose: number | null = null;
  for (const date of dates) {
    const bars = loadDay(profileId, date);
    const rth = bars.filter(b => { const m = etMinuteOfDay(b.ts); return m >= 570 && m <= 959; });
    if (!rth.length) continue;
    const byMin = new Map<number, Bar>();
    for (const b of rth) byMin.set(etMinuteOfDay(b.ts), b);
    const open930 = byMin.get(570);
    const b935 = byMin.get(575);
    const dayClose = rth[rth.length - 1].close;

    // trailing MAs use only PRIOR days' closes (dailyCloses excludes today)
    const sma20 = dailyCloses.length >= 20 ? dailyCloses.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    const emaSnap = ema10;

    if (open930 && b935 && prevDayClose != null) {
      rows.push({ date, prevClose: prevDayClose, open: open930.open, p935: b935.close, close: dayClose, sma20, ema10: emaSnap });
    }
    // update trailing daily series with TODAY's close (for tomorrow)
    dailyCloses.push(dayClose);
    ema10 = ema10 == null ? dayClose : dayClose * (2 / 11) + ema10 * (1 - 2 / 11);
    prevDayClose = dayClose;
  }
  return rows;
}

// ── bucketed reporting ──────────────────────────────────────────────────────
interface GapDay { gap: number; dayMove: number; earlyMove: number; aboveSma: boolean | null; aboveEma: boolean | null }

function summarize(label: string, days: GapDay[]) {
  const n = days.length;
  if (n < 5) { console.log(`  ${label.padEnd(22)} n=${n}  (too few)`); return; }
  const moves = days.map(d => d.dayMove);
  const { mean, sd } = meanStd(moves);
  const se = sd / Math.sqrt(n);
  const t = mean / se;
  const pMean = twoSidedP(t);
  const wins = days.filter(d => d.dayMove > 0).length;   // continuation (close>open)
  const winPct = wins / n * 100;
  const zWin = (wins - n * 0.5) / Math.sqrt(n * 0.25);
  const pWin = twoSidedP(zWin);
  const ci = 1.96 * se;
  const earlyMean = meanStd(days.map(d => d.earlyMove)).mean;
  console.log(
    `  ${label.padEnd(22)} n=${String(n).padStart(3)}  ` +
    `dayMove=${(mean >= 0 ? '+' : '') + mean.toFixed(3)}%  ` +
    `95%CI[${(mean - ci).toFixed(3)},${(mean + ci).toFixed(3)}]  ` +
    `t=${t.toFixed(2)} p=${pMean.toFixed(3)}${star(pMean)}  ` +
    `cont=${winPct.toFixed(1)}% (binom p=${pWin.toFixed(3)}${star(pWin)})  ` +
    `early9:35=${(earlyMean >= 0 ? '+' : '') + earlyMean.toFixed(3)}%`);
}

// size buckets for gap-UPS (percent)
const SIZE_BINS: [string, number, number][] = [
  ['tiny  0.1-0.3%', 0.1, 0.3],
  ['small 0.3-0.6%', 0.3, 0.6],
  ['med   0.6-1.0%', 0.6, 1.0],
  ['large >1.0%', 1.0, Infinity],
];

function report(profileId: string, rows: Row[]) {
  const ups: GapDay[] = rows
    .map(r => ({
      gap: (r.open - r.prevClose) / r.prevClose * 100,
      dayMove: (r.close - r.open) / r.open * 100,
      earlyMove: (r.p935 - r.open) / r.open * 100,
      aboveSma: r.sma20 == null ? null : r.open > r.sma20,
      aboveEma: r.ema10 == null ? null : r.open > r.ema10,
    }))
    .filter(d => d.gap > MIN_GAP);

  console.log(`\n${'='.repeat(118)}\n${profileId.toUpperCase()}  —  ${ups.length} gap-UP days (gap% > ${MIN_GAP}).  Outcome = move from 09:30 open to 16:00 close. cont = close>open.\n${'='.repeat(118)}`);
  console.log('\n[A] ALL gap-ups by SIZE:');
  summarize('ALL gap-ups', ups);
  for (const [name, lo, hi] of SIZE_BINS) summarize(name, ups.filter(d => d.gap > lo && d.gap <= hi));

  console.log('\n[B] gap-ups split by DAILY TREND (open vs 20-day SMA):');
  summarize('above SMA20 (uptrend)', ups.filter(d => d.aboveSma === true));
  summarize('below SMA20 (downtrend)', ups.filter(d => d.aboveSma === false));

  console.log('\n[C] gap-ups split by DAILY TREND (open vs 10-day EMA):');
  summarize('above EMA10', ups.filter(d => d.aboveEma === true));
  summarize('below EMA10', ups.filter(d => d.aboveEma === false));

  console.log('\n[D] SIZE × TREND (SMA20) interaction:');
  for (const [name, lo, hi] of SIZE_BINS) {
    summarize(name + ' | up', ups.filter(d => d.gap > lo && d.gap <= hi && d.aboveSma === true));
    summarize(name + ' | dn', ups.filter(d => d.gap > lo && d.gap <= hi && d.aboveSma === false));
  }
}

for (const p of PROFILES) report(p, buildRows(p));
console.log('\nSig: *** p<0.01  ** p<0.05  * p<0.10   |  XSP=SPX/10 → identical % stats.');

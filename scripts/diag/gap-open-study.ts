/**
 * gap-open-study.ts — Opening gap vs early-session move study.
 *
 * For each trading day per instrument:
 *   prevClose = last RTH 1m close of the prior trading day (~16:00 ET)
 *   open      = open of the 09:30 ET bar (the opening print)
 *   p935      = close of the 09:35 ET bar
 *   p936      = close of the 09:36 ET bar
 *
 * Gap% = (open - prevClose) / prevClose
 *   gap up   : gap% > +flatBand
 *   gap down : gap% < -flatBand
 *   flat     : |gap%| <= flatBand
 *
 * Early move (continuation vs fade), measured from the 09:30 OPEN:
 *   m935 = (p935 - open)/open ,  m936 = (p936 - open)/open
 *
 * "Continuation" = early move has the SAME sign as the gap (gap up keeps rising).
 * "Fade"         = early move has the OPPOSITE sign (gap up sells off).
 *
 * Usage:  npx tsx scripts/diag/gap-open-study.ts [--flat 0.1] [--profiles spx,ndx]
 */
import fs from 'fs';
import path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const FLAT_BAND_PCT = parseFloat(arg('flat', '0.1'));      // |gap| <= this% => "flat"
const PROFILES = arg('profiles', 'spx,ndx').split(',').map(s => s.trim()).filter(Boolean);

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }

// ET wall-clock minute-of-day (e.g. 9:30 => 570) for a unix-sec timestamp.
function etMinuteOfDay(tsSec: number): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(tsSec * 1000));
  const h = parseInt(p.find(x => x.type === 'hour')!.value, 10);
  const m = parseInt(p.find(x => x.type === 'minute')!.value, 10);
  return h * 60 + m;
}

function loadDay(profileId: string, date: string): Bar[] {
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const cache = loadBarCacheFromParquetSync({
    profileId, date, underlyingSymbol: profileId.toUpperCase(),
    symbolRange: { lo: '￿', hi: '￿' },
    timeframe: '1m', startTs: dayStart, endTs: dayStart + 86400 - 1,
    skipContractIndicators: true,
  }) as any;
  const bars: Bar[] = (cache?.spxBars ?? []).map((b: any) => ({
    ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
  }));
  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}

interface DayRow { date: string; prevClose: number; open: number; p935: number; p936: number }

function buildRows(profileId: string): DayRow[] {
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) { console.error(`! no parquet dir for ${profileId}`); return []; }
  const dates = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map(f => f.slice(0, 10)).sort();

  const rows: DayRow[] = [];
  let prevDayClose: number | null = null;
  for (const date of dates) {
    const bars = loadDay(profileId, date);
    // RTH bars: 09:30 (570) .. 15:59 (959) ET inclusive
    const rth = bars.filter(b => { const m = etMinuteOfDay(b.ts); return m >= 570 && m <= 959; });
    const byMin = new Map<number, Bar>();
    for (const b of rth) byMin.set(etMinuteOfDay(b.ts), b);
    const open930 = byMin.get(570);
    const b935 = byMin.get(575);
    const b936 = byMin.get(576);
    const lastClose = rth.length ? rth[rth.length - 1].close : null;

    if (open930 && b935 && b936 && prevDayClose != null) {
      rows.push({ date, prevClose: prevDayClose, open: open930.open, p935: b935.close, p936: b936.close });
    }
    if (lastClose != null) prevDayClose = lastClose;
  }
  return rows;
}

interface Stat { n: number; sumMove: number; cont: number; fade: number; sumAbs: number }
function newStat(): Stat { return { n: 0, sumMove: 0, cont: 0, fade: 0, sumAbs: 0 }; }

function classify(gapPct: number): 'up' | 'down' | 'flat' {
  if (gapPct > FLAT_BAND_PCT) return 'up';
  if (gapPct < -FLAT_BAND_PCT) return 'down';
  return 'flat';
}

function report(profileId: string, rows: DayRow[]) {
  console.log(`\n${'='.repeat(72)}\n${profileId.toUpperCase()}  —  ${rows.length} day pairs  (flat band ±${FLAT_BAND_PCT}%)\n${'='.repeat(72)}`);
  if (!rows.length) return;

  // bucket -> {935 stat, 936 stat}
  const buckets: Record<string, { s935: Stat; s936: Stat; gapSum: number }> = {
    up: { s935: newStat(), s936: newStat(), gapSum: 0 },
    down: { s935: newStat(), s936: newStat(), gapSum: 0 },
    flat: { s935: newStat(), s936: newStat(), gapSum: 0 },
  };

  for (const r of rows) {
    const gapPct = (r.open - r.prevClose) / r.prevClose * 100;
    const cls = classify(gapPct);
    const m935 = (r.p935 - r.open) / r.open * 100;
    const m936 = (r.p936 - r.open) / r.open * 100;
    const gapSign = Math.sign(gapPct);
    const b = buckets[cls];
    b.gapSum += gapPct;
    for (const [stat, mv] of [[b.s935, m935], [b.s936, m936]] as [Stat, number][]) {
      stat.n++; stat.sumMove += mv; stat.sumAbs += Math.abs(mv);
      if (cls !== 'flat') {
        if (Math.sign(mv) === gapSign && mv !== 0) stat.cont++;
        else if (mv !== 0) stat.fade++;
      }
    }
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (x: number, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
  console.log(pad('bucket', 8) + pad('days', 6) + pad('avgGap%', 10) + pad('mark', 6) +
              pad('avgMove%', 11) + pad('avgAbs%', 10) + pad('cont%', 8) + 'continuation vs fade');
  for (const cls of ['up', 'down', 'flat'] as const) {
    const b = buckets[cls];
    const days = b.s935.n;
    if (!days) continue;
    const avgGap = b.gapSum / days;
    for (const [mark, s] of [['9:35', b.s935], ['9:36', b.s936]] as [string, Stat][]) {
      const avgMove = s.sumMove / s.n;
      const avgAbs = s.sumAbs / s.n;
      const decided = s.cont + s.fade;
      const contPct = decided ? (s.cont / decided * 100) : NaN;
      const verdict = cls === 'flat' ? '—'
        : `${s.cont} cont / ${s.fade} fade  ${contPct >= 50 ? '→ tends to CONTINUE' : '→ tends to FADE'}`;
      console.log(
        pad(mark === '9:35' ? cls : '', 8) +
        pad(mark === '9:35' ? String(days) : '', 6) +
        pad(mark === '9:35' ? num(avgGap, 3) : '', 10) +
        pad(mark, 6) +
        pad(num(avgMove, 4), 11) +
        pad(num(avgAbs, 4), 10) +
        pad(isNaN(contPct) ? '—' : contPct.toFixed(1) + '%', 8) +
        verdict);
    }
    console.log('-'.repeat(72));
  }
}

for (const p of PROFILES) {
  const rows = buildRows(p);
  report(p, rows);
}
console.log('\nNote: XSP (Mini-SPX) = SPX/10 — same underlying index, so its gap%/move% stats are identical to SPX.');

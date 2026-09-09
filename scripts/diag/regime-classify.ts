/**
 * regime-classify.ts
 *
 * Layer 1 of the regime→strategy PLAYBOOK: the "what happened / what's
 * happening" measurement layer. For each trading day it computes a small set
 * of decision-relevant features and assigns a coarse regime label, so the
 * playbook can answer "given regime R, trade strategies A/B/C".
 *
 * Gap definitions are deliberately aligned with the parallel gap study
 * (scripts/diag/gap-*.ts): gap% = (open − prevClose)/prevClose × 100, buckets
 * at 0.1/0.3/0.6/1.0 %, daily trend = open vs 20-day SMA of closes. That makes
 * the gap cells of the playbook map 1:1 onto the gap session's findings.
 *
 * No look-ahead: percentile/SMA context uses only PRIOR days. A day's regime is
 * known from its own OHLC + history that closed before it — never future bars.
 * (Strategy selection in live trading would key off the morning's gap + the
 * developing session, but the daily label here is the training scaffold.)
 *
 * Pure functions (aggDay / computeFeatures / classify) are unit-tested; the CLI
 * batch-runs them over SPX/NDX 0DTE history and emits a shared dataset both
 * this session and the gap session consume:
 *   scripts/autoresearch/playbook/regimes-{sym}.json
 */

export interface DayBar { ts: number; open: number; high: number; low: number; close: number; }

export interface DayAgg {
  open: number; high: number; low: number; close: number;
  orHigh: number; orLow: number; rvol: number;
}

export interface RegimeFeatures {
  date: string;
  gapPct: number; gapBucket: string; gapDir: 'up' | 'down' | 'flat';
  dayRangePct: number; bodyPct: number; trendiness: number;
  orRangePct: number; orBreak: 'up' | 'down' | 'none';
  rvol: number; rvolPctile: number | null;
  trend20: 'above' | 'below' | null;
  gapFilled: boolean;
}

export interface RegimeLabel { primary: string; tags: string[]; }

// Gap-size thresholds (percent), matched to the gap study's SIZE_BINS.
const GAP_FLAT = 0.1, GAP_SMALL = 0.3, GAP_MED = 0.6, GAP_LARGE = 1.0;

function gapBucketOf(gapPct: number): string {
  const a = Math.abs(gapPct);
  const dir = gapPct > 0 ? 'up' : 'down';
  if (a < GAP_FLAT) return 'flat';
  if (a < GAP_SMALL) return `${dir}_tiny`;
  if (a < GAP_MED) return `${dir}_small`;
  if (a < GAP_LARGE) return `${dir}_med`;
  return `${dir}_large`;
}

/** Fold a day's intraday bars into OHLC + opening-range + realized vol. */
export function aggDay(dayBars: DayBar[], sessOpenTs: number, orMinutes = 30): DayAgg {
  if (dayBars.length === 0) throw new Error('aggDay: empty bars');
  const open = dayBars[0].open, close = dayBars[dayBars.length - 1].close;
  let high = -Infinity, low = Infinity;
  let orHigh = -Infinity, orLow = Infinity;
  const orEnd = sessOpenTs + orMinutes * 60;
  // realized vol: stdev of 1m log returns, scaled to a daily figure.
  const rets: number[] = [];
  let prev = dayBars[0].close;
  for (const b of dayBars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (b.ts < orEnd) { if (b.high > orHigh) orHigh = b.high; if (b.low < orLow) orLow = b.low; }
    if (prev > 0 && b.close > 0) rets.push(Math.log(b.close / prev));
    prev = b.close;
  }
  if (orHigh === -Infinity) { orHigh = high; orLow = low; }
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const varc = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const rvol = Math.sqrt(varc) * Math.sqrt(390) * 100; // ~daily realized vol in %
  return { open, high, low, close, orHigh, orLow, rvol };
}

/** Build the feature vector. `sma20`/`rvolPctile` are PRIOR-only context. */
export function computeFeatures(
  date: string, a: DayAgg, prevClose: number | null,
  sma20: number | null, rvolPctile: number | null
): RegimeFeatures {
  const gapPct = prevClose ? (a.open - prevClose) / prevClose * 100 : 0;
  const gapDir = gapPct > GAP_FLAT ? 'up' : gapPct < -GAP_FLAT ? 'down' : 'flat';
  const dayRangePct = (a.high - a.low) / a.open * 100;
  const bodyPct = (a.close - a.open) / a.open * 100;
  const range = a.high - a.low;
  const trendiness = range > 0 ? Math.abs(a.close - a.open) / range : 0;
  const orRangePct = (a.orHigh - a.orLow) / a.open * 100;
  const orBreak = a.close > a.orHigh ? 'up' : a.close < a.orLow ? 'down' : 'none';
  // gap filled = price traded back through prevClose intraday.
  const gapFilled = prevClose != null && gapDir !== 'flat' &&
    (gapDir === 'up' ? a.low <= prevClose : a.high >= prevClose);
  const trend20 = sma20 == null ? null : (a.open >= sma20 ? 'above' : 'below');
  return { date, gapPct, gapBucket: gapBucketOf(gapPct), gapDir, dayRangePct, bodyPct, trendiness, orRangePct, orBreak, rvol: a.rvol, rvolPctile, trend20, gapFilled };
}

/**
 * Assign a primary regime + descriptive tags. The primary is a single bucket
 * the playbook indexes on; tags carry the finer context (gap size, OR break,
 * trend, vol) that secondary strategy selection can use.
 */
export function classify(f: RegimeFeatures): RegimeLabel {
  const tags: string[] = [];
  if (f.gapBucket !== 'flat') tags.push(`gap_${f.gapBucket}`);
  if (f.gapFilled) tags.push('gap_filled');
  if (f.orBreak !== 'none') tags.push(`or_break_${f.orBreak}`);
  if (f.trend20) tags.push(`trend20_${f.trend20}`);
  if (f.rvolPctile != null && f.rvolPctile >= 0.7) tags.push('vol_high');
  if (f.rvolPctile != null && f.rvolPctile <= 0.3) tags.push('vol_low');
  if (f.trendiness >= 0.6) tags.push('trend_day'); else if (f.trendiness <= 0.35) tags.push('chop_day');

  let primary: string;
  const sigGap = Math.abs(f.gapPct) >= GAP_SMALL; // small+ gap is regime-defining
  if (sigGap) {
    const bodySameAsGap = Math.sign(f.bodyPct) === Math.sign(f.gapPct);
    if (f.gapFilled && !bodySameAsGap) primary = 'gap_fade';
    else if (bodySameAsGap && f.trendiness >= 0.5) primary = 'gap_go';
    else primary = 'gap_chop';
  } else if (f.rvolPctile != null && f.rvolPctile >= 0.7 && f.trendiness >= 0.55) {
    primary = 'trend_vol';
  } else if (f.trendiness >= 0.6) {
    primary = 'trend';
  } else if (f.rvolPctile != null && f.rvolPctile <= 0.3 && f.trendiness <= 0.4) {
    primary = 'quiet_range';
  } else if (f.trendiness <= 0.35) {
    primary = 'chop';
  } else {
    primary = 'mixed';
  }
  return { primary, tags };
}

// ── CLI: batch-classify SPX/NDX 0DTE history → shared playbook dataset ──────
// Skipped during unit tests (only runs when invoked directly).
const INVOKED_DIRECTLY = (() => {
  try { return require.main === module; } catch { return false; }
})();

if (INVOKED_DIRECTLY) {
  (async () => {
    const dotenv = await import('dotenv'); dotenv.config({ quiet: true } as any);
    const { resolveSymbolTarget, listDatesFor, loadDay } = await import('./sweep-symbol');
    const fs = await import('fs'); const path = await import('path');

    const sym = (process.argv.find((_, i) => process.argv[i - 1] === '--symbol') || 'SPX').toUpperCase();
    const target = resolveSymbolTarget(['--symbol', sym]);
    const UT: any = { ...target, dte: 0, profileId: `${sym.toLowerCase()}-0dte` };

    function sessOpenTs(date: string): number {
      const [y, mo, d] = date.split('-').map(Number);
      const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
      const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
      return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
    }

    const dates: string[] = listDatesFor(UT);
    const closes: number[] = [];
    const rvols: number[] = [];
    const out: any[] = [];
    let prevClose: number | null = null;

    for (const date of dates) {
      let dd: any; try { dd = loadDay(UT, date, '1m'); } catch { continue; }
      const bars = dd?.spxBars; if (!bars?.length) continue;
      const agg = aggDay(bars, sessOpenTs(date));
      // prior-only context: 20-day SMA of prior closes; rvol percentile vs prior 60 rvols.
      const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((s, c) => s + c, 0) / 20 : null;
      const hist = rvols.slice(-60);
      const rvolPctile = hist.length >= 20 ? hist.filter(v => v < agg.rvol).length / hist.length : null;
      const f = computeFeatures(date, agg, prevClose, sma20, rvolPctile);
      const label = classify(f);
      out.push({ ...f, ...label });
      closes.push(agg.close); rvols.push(agg.rvol); prevClose = agg.close;
    }

    const dir = path.join(process.cwd(), 'scripts/autoresearch/playbook');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `regimes-${sym.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));

    // distribution summary
    const dist = new Map<string, number>();
    for (const r of out) dist.set(r.primary, (dist.get(r.primary) ?? 0) + 1);
    console.log(`${sym}: classified ${out.length}/${dates.length} days → ${file}`);
    console.log('Regime distribution:');
    for (const [k, v] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(13)} ${String(v).padStart(4)}  (${(100 * v / out.length).toFixed(1)}%)`);
    }
  })().catch(e => { console.error('regime-classify CLI error:', e); process.exit(1); });
}

/**
 * ndx-spread-sample.ts — Pull real historical NBBO from ThetaData for NDX 0DTE
 * options across a sample of dates, and report the actual bid/ask half-spread
 * by moneyness and time-of-day. Answers: what fill half-spread is realistic?
 */
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

const REST = process.env.THETADATA_REST_URL || 'http://127.0.0.1:25503';
const T = resolveSymbolTarget(['', '', '--symbol', 'NDX']);
const SI = T.strikeInterval; // 10

// Moneyness offsets (in points) to sample, both puts & calls
const OFFSETS = [
  { tag: 'ATM',      pts: 0  },
  { tag: '10pt-OTM', pts: 10 },
  { tag: '20pt-OTM', pts: 20 },
  { tag: '30pt-OTM', pts: 30 },
  { tag: '40pt-OTM', pts: 40 },
  { tag: '50pt-OTM', pts: 50 },
  { tag: '70pt-OTM', pts: 70 },
];

async function fetchQuotes(date: string, right: 'put'|'call', strike: number): Promise<any[]> {
  const url = `${REST}/v3/option/history/quote?symbol=NDXP&expiration=${date}&right=${right}&strike=${strike}&interval=1m&start_date=${date}&end_date=${date}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const hdr = lines[0].split(',');
    const bidI = hdr.indexOf('bid'), askI = hdr.indexOf('ask'), tsI = hdr.indexOf('timestamp');
    const bidSzI = hdr.indexOf('bid_size'), askSzI = hdr.indexOf('ask_size');
    const out: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const bid = parseFloat(c[bidI]), ask = parseFloat(c[askI]);
      const ts = c[tsI]?.replace(/"/g, '');
      const bidSz = parseInt(c[bidSzI] || '0'), askSz = parseInt(c[askSzI] || '0');
      if (bid > 0 && ask > 0 && ask >= bid) out.push({ ts, bid, ask, bidSz, askSz });
    }
    return out;
  } catch { return []; }
}

function etHour(tsIso: string): number {
  // timestamp is ET wall-clock already (e.g. 2025-08-20T09:30:00.000)
  const m = /T(\d{2}):(\d{2})/.exec(tsIso);
  return m ? parseInt(m[1]) : 0;
}

interface Sample { halfSpreadPts: number; midPx: number; relPct: number; hour: number; }
const byMoneyness: Record<string, Sample[]> = {};
for (const o of OFFSETS) byMoneyness[o.tag] = [];

async function main() {
  const allDates = listDatesFor(T);
  const N = parseInt(process.env.SAMPLE_DAYS || '15');
  const step = Math.floor(allDates.length / N);
  const dates: string[] = [];
  for (let i = 0; i < N; i++) dates.push(allDates[i * step]);

  console.error(`Sampling ${dates.length} dates...`);
  for (const date of dates) {
    const c1 = loadDay(T, date, '1m') as any;
    if (!c1?.spxBars?.length) { console.error(`  ${date} no bar data, skip`); continue; }
    // Mid-session spot to center the strikes
    const spot = c1.spxBars[Math.floor(c1.spxBars.length / 2)].close;
    const atmStrike = Math.round(spot / SI) * SI;

    for (const o of OFFSETS) {
      // OTM put = below spot; OTM call = above spot
      const putStrike  = atmStrike - o.pts;
      const callStrike = atmStrike + o.pts;
      const [putQ, callQ] = await Promise.all([
        fetchQuotes(date, 'put', putStrike),
        fetchQuotes(date, 'call', callStrike),
      ]);
      for (const q of [...putQ, ...callQ]) {
        const hs = (q.ask - q.bid) / 2;
        const mid = (q.ask + q.bid) / 2;
        if (mid <= 0) continue;
        const hour = etHour(q.ts);
        // RTH only, 10:00-15:45 ET (our trading window)
        if (hour < 10 || hour > 15) continue;
        byMoneyness[o.tag].push({ halfSpreadPts: hs, midPx: mid, relPct: hs / mid * 100, hour });
      }
    }
    console.error(`  ${date} done`);
  }

  const pct = (arr: number[], p: number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * p)];
  };

  console.log('\n=== NDX 0DTE REAL NBBO HALF-SPREAD (RTH 10:00-15:45 ET) ===\n');
  console.log('moneyness   n      hs_p25   hs_p50   hs_p75   hs_p90   avg_mid   hs%mid_p50');
  for (const o of OFFSETS) {
    const s = byMoneyness[o.tag];
    if (!s.length) { console.log(`${o.tag.padEnd(10)}  no data`); continue; }
    const hs = s.map(x => x.halfSpreadPts);
    const mids = s.map(x => x.midPx);
    const rel = s.map(x => x.relPct);
    const avgMid = mids.reduce((a, b) => a + b, 0) / mids.length;
    console.log(
      o.tag.padEnd(10) +
      String(s.length).padStart(6) +
      pct(hs, 0.25).toFixed(2).padStart(9) +
      pct(hs, 0.50).toFixed(2).padStart(9) +
      pct(hs, 0.75).toFixed(2).padStart(9) +
      pct(hs, 0.90).toFixed(2).padStart(9) +
      avgMid.toFixed(1).padStart(10) +
      (pct(rel, 0.50).toFixed(1) + '%').padStart(11)
    );
  }

  // Time-of-day breakdown for ATM
  console.log('\n=== ATM half-spread by ET hour ===');
  console.log('hour    n    hs_p50   hs_p75');
  const atm = byMoneyness['ATM'];
  for (let h = 10; h <= 15; h++) {
    const sub = atm.filter(x => x.hour === h).map(x => x.halfSpreadPts);
    if (!sub.length) continue;
    console.log(`${h}:00 ${String(sub.length).padStart(5)} ${pct(sub,0.50).toFixed(2).padStart(8)} ${pct(sub,0.75).toFixed(2).padStart(8)}`);
  }

  console.log('\nModel currently assumes half-spread = $0.10/leg.');
}

main();

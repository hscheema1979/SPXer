import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, loadDay } from './sweep-symbol';

const TARGET = resolveSymbolTarget(['--symbol', 'NDX']);

function sessOpenTs(date: string): number {
  const [y,mo,d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y,mo-1,d,12,0,0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));
  return Math.floor(Date.UTC(y,mo-1,d,9+(12-etHour),30,0)/1000);
}
function optPx(bars: any[], ts: number): number|null {
  for(let i=bars.length-1;i>=0;i--) if(bars[i].ts<=ts) return bars[i].close;
  return null;
}
function markAge(bars: any[], ts: number): number {
  for(let i=bars.length-1;i>=0;i--) if(bars[i].ts<=ts) return ts - bars[i].ts;
  return Infinity;
}
function findStrike(c1: any, type: 'C'|'P', targetK: number): string|null {
  let best: string|null = null, bestD = Infinity;
  for (const [s] of c1.contractBars as Map<string,any[]>) {
    const sym = s as string;
    if (sym[sym.length-9] !== type) continue;
    const k = c1.contractStrikes?.get(sym);
    if (k == null) continue;
    const d = Math.abs(k - targetK);
    if (d < bestD) { bestD = d; best = sym; }
  }
  return best;
}
function wma(vals: number[], len: number): number {
  let w = 0, ws = 0;
  for (let i = 0; i < len; i++) { const wt = i+1; w += wt; ws += vals[vals.length-len+i]*wt; }
  return ws/w;
}
function hmaDir(closes: number[], fast: number, slow: number): 'bull'|'bear'|null {
  const hs = Math.floor(Math.sqrt(slow));
  if (closes.length < slow + hs + 1) return null;
  const raws: number[] = [];
  for (let i = hs; i >= 0; i--) {
    const sl = closes.slice(0, closes.length - i);
    if (sl.length < slow) { raws.push(NaN); continue; }
    const rf = 2*wma(sl.slice(-Math.floor(fast/2)), Math.floor(fast/2)) - wma(sl.slice(-fast), fast);
    const rs = 2*wma(sl.slice(-Math.floor(slow/2)), Math.floor(slow/2)) - wma(sl.slice(-slow), slow);
    raws.push(rf - rs);
  }
  if (raws.some(isNaN)) return null;
  const prev = raws[raws.length - 2], cur = raws[raws.length - 1];
  return cur > prev ? 'bull' : 'bear';
}
function demaDir(closes: number[], fast: number, slow: number): 'bull'|'bear'|null {
  if (closes.length < slow * 2) return null;
  const ema = (arr: number[], n: number) => {
    const k = 2/(n+1); let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i]*k + e*(1-k);
    return e;
  };
  const dema = (arr: number[], n: number) => {
    if (arr.length < n*2) return NaN;
    const e1 = ema(arr, n);
    const e2vals: number[] = [];
    for (let i = n-1; i < arr.length; i++) e2vals.push(arr[i]);
    const e2 = ema(e2vals, n);
    return 2*e1 - e2;
  };
  const df = dema(closes, fast), ds = dema(closes, slow);
  if (isNaN(df) || isNaN(ds)) return null;
  const pfArr = closes.slice(0,-1), psArr = closes.slice(0,-1);
  const pf = dema(pfArr, fast), ps = dema(psArr, slow);
  if (isNaN(pf) || isNaN(ps)) return null;
  const cur = df - ds, prev = pf - ps;
  return cur > prev ? 'bull' : 'bear';
}

function detectEntries(s1: any[], tradeStart: number, cutoff: number, signalFn: (closes:number[])=>'bull'|'bear'|null) {
  let bullStreak=0, bearStreak=0, bullFired=false, bearFired=false;
  let prevDir: string|null = null, bullCross=0, bearCross=0;
  const entries: {ts:number, dir:string, ndx:number}[] = [];
  for (const b of s1) {
    const closes = s1.filter((x:any) => x.ts <= b.ts).map((x:any) => x.close);
    const dir = signalFn(closes);
    if (b.ts >= tradeStart) {
      if (prevDir !== null && dir !== prevDir) {
        if (dir === 'bull') bullCross = b.ts;
        if (dir === 'bear') bearCross = b.ts;
      }
      if (dir === 'bull') { bullStreak++; bearStreak=0; bearFired=false; } else { bullStreak=0; bullFired=false; }
      if (dir === 'bear') { bearStreak++; bullStreak=0; bullFired=false; } else { bearStreak=0; bearFired=false; }
      if (dir === 'bull' && bullStreak >= 3 && !bullFired && bullCross > 0) {
        entries.push({ ts: b.ts+60, dir: 'bull', ndx: b.close }); bullFired=true;
      }
      if (dir === 'bear' && bearStreak >= 3 && !bearFired && bearCross > 0) {
        entries.push({ ts: b.ts+60, dir: 'bear', ndx: b.close }); bearFired=true;
      }
    }
    prevDir = dir;
    if (b.ts >= cutoff) break;
  }
  return entries;
}

const STALE_SEC = 300;

function walkTP(c1: any, ev: {ts:number,dir:string,ndx:number}, legs: {sym:string,sign:number}[], credit: number, tpFrac: number, settle: number) {
  const tpV = (1 - tpFrac) * credit;
  const tpTrigger = tpV - 4 * 0.10; // hard fill penalty

  for (let ts = ev.ts; ts <= settle; ts += 60) {
    let V = 0;
    let shortsFresh = false;
    for (const lg of legs) {
      const bars = c1.contractBars.get(lg.sym) as any[];
      const px = optPx(bars, ts) ?? optPx(bars, ev.ts-1)!;
      V += lg.sign * px;
      if (lg.sign > 0 && bars.some((b:any)=>b.ts===ts)) shortsFresh = true;
    }
    if (V <= tpTrigger && shortsFresh) {
      return { exitTs: ts, exitV: tpV, reason: 'TP', dur: Math.round((ts-ev.ts)/60) };
    }
  }
  let V = 0;
  for (const lg of legs) {
    const bars = c1.contractBars.get(lg.sym) as any[];
    const px = optPx(bars, settle) ?? 0;
    V += lg.sign * px;
  }
  return { exitTs: settle, exitV: V, reason: 'settle', dur: Math.round((settle-ev.ts)/60) };
}

// Stress-test set: 5 flat/choppy days + 2 mid-range + 3 previously verified trending days
const DATES = [
  '2025-09-09', // range=64pts  flattest day in dataset
  '2025-07-28', // range=87pts  nearly zero net move
  '2025-08-18', // range=96pts  flat grind
  '2025-10-21', // range=135pts flat, net move=1pt
  '2025-06-06', // range=140pts flat, net move=2pts
  '2025-10-29', // range=275pts mid-range, net move=14pts (choppy but wider)
  '2025-09-25', // range=274pts mid-range with trend attempt
  '2025-11-03', // range=~350pts trending (previously verified)
  '2025-12-10', // range=~400pts trending (previously verified)
  '2026-03-18', // range=~500pts trending (previously verified)
];

// Accumulate cross-date totals for each (otm, wing) combo
const OTM_OFFSETS = [0, 20, 40, 60];
const WING_WIDTHS = [20, 30, 40, 50, 70, 100];
type Combo = { n: number; wins: number; pnl: number; skip_stale: number; skip_geom: number };
const totals = new Map<string, Combo>();
for (const o of OTM_OFFSETS) for (const w of WING_WIDTHS) totals.set(`${o}x${w}`, {n:0,wins:0,pnl:0,skip_stale:0,skip_geom:0});

// IB cross-date accumulator
let ibTotal = { n:0, wins:0, pnl:0, skip_stale:0, skip_geom:0 };
const ibByDate: {date:string, n:number, wins:number, pnl:number, entries:number}[] = [];


for (const date of DATES) {
  const c1 = loadDay(TARGET, date, '1m') as any;
  if (!c1?.spxBars?.length) { console.log(date, '— no data'); continue; }
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  const tradeStart = sess + 1800;
  const cutoff = sess + 6*3600;
  const settle = sess + 6*3600 + 15*60;
  const ndxAt10 = optPx(s1, tradeStart - 1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${date} | NDX@10:00=${ndxAt10?.toFixed(1)} | contracts=${c1.contractBars.size}`);
  console.log('='.repeat(70));

  // ── Strategy 1: HMA 1m 3x9 | IB±30 w50 | TP35 ─────────────────────────
  const hmaEntries = detectEntries(s1, tradeStart, cutoff, (cls) => hmaDir(cls, 3, 9));
  console.log(`\n[S1] HMA 3x9 | IB±30 w50 | TP35  (${hmaEntries.length} entries, stale_cutoff=${STALE_SEC}s)`);
  let s1pnl = 0, s1n = 0, s1wins = 0;
  for (const ev of hmaEntries) {
    const center = ev.dir === 'bull' ? ev.ndx + 30 : ev.ndx - 30;
    const sym_sc = findStrike(c1, 'C', center);
    const sym_sp = findStrike(c1, 'P', center);
    const sym_lc = findStrike(c1, 'C', center + 50);
    const sym_lp = findStrike(c1, 'P', center - 50);
    if (!sym_sc||!sym_sp||!sym_lc||!sym_lp) continue;

    const sc_k = c1.contractStrikes?.get(sym_sc), sp_k = c1.contractStrikes?.get(sym_sp);
    const lc_k = c1.contractStrikes?.get(sym_lc), lp_k = c1.contractStrikes?.get(sym_lp);
    const sc_bars=c1.contractBars.get(sym_sc) as any[], sp_bars=c1.contractBars.get(sym_sp) as any[];
    const lc_bars=c1.contractBars.get(sym_lc) as any[], lp_bars=c1.contractBars.get(sym_lp) as any[];
    const sc_px=optPx(sc_bars,ev.ts-1), sp_px=optPx(sp_bars,ev.ts-1);
    const lc_px=optPx(lc_bars,ev.ts-1), lp_px=optPx(lp_bars,ev.ts-1);
    if (sc_px==null||sp_px==null||lc_px==null||lp_px==null) continue;

    const sc_age=Math.round(markAge(sc_bars,ev.ts-1)), sp_age=Math.round(markAge(sp_bars,ev.ts-1));
    if (sc_age > STALE_SEC || sp_age > STALE_SEC) { ibTotal.skip_stale++; process.stdout.write(`  ${new Date(ev.ts*1000).toISOString().slice(11,16)} SKIP(stale ${sc_age}/${sp_age}s)\n`); continue; }
    const credit = sc_px + sp_px - lc_px - lp_px;
    if (credit <= 0.10) continue;
    if (credit >= 50) { ibTotal.skip_geom++; process.stdout.write(`  ${new Date(ev.ts*1000).toISOString().slice(11,16)} SKIP(geom cr=${credit.toFixed(2)}>=wing)\n`); continue; }
    const wingW = 50;
    const maxRisk = (wingW - credit) * 100;

    const legs = [
      {sym: sym_sc, sign: +1}, {sym: sym_sp, sign: +1},
      {sym: sym_lc, sign: -1}, {sym: sym_lp, sign: -1},
    ];
    const res = walkTP(c1, ev, legs, credit, 0.35, settle);
    const pnl = (credit - res.exitV) * 100 - 25;
    s1pnl += pnl; s1n++; if (pnl > 0) s1wins++;
    ibTotal.n++; ibTotal.pnl += pnl; if (pnl > 0) ibTotal.wins++;
    console.log(`  ${new Date(ev.ts*1000).toISOString().slice(11,16)} ${ev.dir.padEnd(4)} ctr=${center.toFixed(0)} (sc=${sc_k} lc=${lc_k} lp=${lp_k}) cr=$${credit.toFixed(2)} maxR=$${maxRisk.toFixed(0)} ages=${sc_age}/${sp_age}s → ${res.reason} ${new Date(res.exitTs*1000).toISOString().slice(11,16)} ${res.dur}min pnl=$${pnl.toFixed(0)}`);
  }
  if (s1n) console.log(`  DAY TOTAL: n=${s1n} wins=${s1wins} (${(100*s1wins/s1n).toFixed(0)}%) pnl=$${s1pnl.toFixed(0)} avg=$${(s1pnl/s1n).toFixed(0)}`);
  else console.log(`  DAY TOTAL: n=0 (all entries skipped)`);
  ibByDate.push({ date, n: s1n, wins: s1wins, pnl: s1pnl, entries: hmaEntries.length });

  if (false) { // S2 disabled for IB stress-test run
  const demaEntries = detectEntries(s1, tradeStart, cutoff, (cls) => demaDir(cls, 3, 9));
  console.log(`\n[S2] DEMA 3x9 | OTM/wing sweep | TP50  (${demaEntries.length} signal entries)`);

  for (const shortOffset of OTM_OFFSETS) {
    for (const wingW of WING_WIDTHS) {
      let pnl = 0, n = 0, wins = 0, skip_stale = 0, skip_geom = 0;
      for (const ev of demaEntries) {
        const ndx = ev.ndx;
        const sym_sc = findStrike(c1, 'C', ndx + shortOffset);
        const sym_lc = findStrike(c1, 'C', ndx + shortOffset + wingW);
        const sym_sp = findStrike(c1, 'P', ndx - shortOffset);
        const sym_lp = findStrike(c1, 'P', ndx - shortOffset - wingW);
        if (!sym_sc||!sym_lc||!sym_sp||!sym_lp) continue;

        const sc_bars=c1.contractBars.get(sym_sc) as any[], lc_bars=c1.contractBars.get(sym_lc) as any[];
        const sp_bars=c1.contractBars.get(sym_sp) as any[], lp_bars=c1.contractBars.get(sym_lp) as any[];
        const sc_px=optPx(sc_bars,ev.ts-1), lc_px=optPx(lc_bars,ev.ts-1);
        const sp_px=optPx(sp_bars,ev.ts-1), lp_px=optPx(lp_bars,ev.ts-1);
        if (sc_px==null||lc_px==null||sp_px==null||lp_px==null) continue;

        const sc_age=Math.round(markAge(sc_bars,ev.ts-1)), sp_age=Math.round(markAge(sp_bars,ev.ts-1));
        if (sc_age > STALE_SEC || sp_age > STALE_SEC) { skip_stale++; continue; }

        const credit = sc_px - lc_px + sp_px - lp_px;
        if (credit <= 0.10) continue;
        if (credit >= wingW) { skip_geom++; continue; }

        const legs = [
          {sym: sym_sc, sign: +1}, {sym: sym_sp, sign: +1},
          {sym: sym_lc, sign: -1}, {sym: sym_lp, sign: -1},
        ];
        const res = walkTP(c1, ev, legs, credit, 0.50, settle);
        const tradePnl = (credit - res.exitV) * 100 - 25;
        pnl += tradePnl; n++; if (tradePnl > 0) wins++;
      }
      const key = `${shortOffset}x${wingW}`;
      const t = totals.get(key)!;
      t.n += n; t.wins += wins; t.pnl += pnl; t.skip_stale += skip_stale; t.skip_geom += skip_geom;

      if (n === 0 && skip_geom === 0) continue;
      const wr = n > 0 ? `${(100*wins/n).toFixed(0)}%` : '—';
      const avgP = n > 0 ? `$${(pnl/n).toFixed(0)}` : '—';
      const maxR = wingW * 100;
      const rr = n > 0 ? `${((pnl/n)/maxR*100).toFixed(1)}%` : '—';
      console.log(`  ${shortOffset}OTM w${String(wingW).padStart(3)} | n=${String(n).padStart(2)} wr=${wr.padStart(4)} avg=${avgP.padStart(5)} rr=${rr.padStart(5)}/maxR | skip_stale=${skip_stale} skip_geom=${skip_geom}`);
    }
  }
  } // end if(false) S2 block
} // end for dates

// IB cross-date summary
console.log(`\n${'='.repeat(70)}`);
console.log(`IB±30 w50 TP35 | HMA 3x9 | stale<${STALE_SEC}s | STRESS TEST SUMMARY`);
console.log('='.repeat(70));
console.log(`  ${'date'.padEnd(12)} ${'sig'.padStart(4)} ${'n'.padStart(4)} ${'wr'.padStart(5)} ${'pnl'.padStart(8)} ${'avg'.padStart(7)}`);
for (const r of ibByDate) {
  const wr = r.n > 0 ? `${(100*r.wins/r.n).toFixed(0)}%` : '—';
  const avg = r.n > 0 ? `$${(r.pnl/r.n).toFixed(0)}` : '—';
  console.log(`  ${r.date}  ${String(r.entries).padStart(4)} ${String(r.n).padStart(4)} ${wr.padStart(5)} ${('$'+r.pnl.toFixed(0)).padStart(8)} ${avg.padStart(7)}`);
}
const allWr = ibTotal.n > 0 ? `${(100*ibTotal.wins/ibTotal.n).toFixed(1)}%` : '—';
const allAvg = ibTotal.n > 0 ? `$${(ibTotal.pnl/ibTotal.n).toFixed(0)}` : '—';
console.log(`  ${'─'.repeat(56)}`);
console.log(`  ${'TOTAL'.padEnd(12)}  ${''.padStart(4)} ${String(ibTotal.n).padStart(4)} ${allWr.padStart(5)} ${('$'+ibTotal.pnl.toFixed(0)).padStart(8)} ${allAvg.padStart(7)}`);
console.log(`  skip_stale=${ibTotal.skip_stale}  skip_geom=${ibTotal.skip_geom}`);

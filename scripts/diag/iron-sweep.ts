/**
 * iron-sweep.ts
 *
 * Sweeps 4-leg defined-risk credit structures (IRON CONDOR + IRON BUTTERFLY)
 * using the same look-ahead-protected signal engine as credit-spread-sweep.ts.
 *
 * Iron condor: short put @ (SPX − shortOffset), long put @ shortStrike − wingWidth,
 *              short call @ (SPX + shortOffset), long call @ shortStrike + wingWidth.
 *   - Symmetric around SPX. Max loss = wingWidth × 100 − credit × 100. Defined risk.
 *
 * Iron butterfly: same legs but both short strikes at SPX (shortOffset = 0).
 *   - Max profit at SPX = SPX_entry at expiry. Tighter sweet spot than condor.
 *
 * Spread value V at any time = sum(sign_i × close_i) where:
 *   short legs: sign = +1  (we'd pay V to buy back)
 *   long legs:  sign = −1  (we'd receive V to sell)
 * Entry credit = V at entry. P&L per share = credit − V_now.
 *
 * Same exit logic as credit-spread-sweep: TP fires when V ≤ (1−tpFrac)*credit;
 * SL fires when V ≥ (1+slMult)*credit. Hold-to-settle = V at session end.
 *
 * Output appended to /tmp/credit_spread_sweep.json + /tmp/credit_spread_daily.json
 * (existing 2-leg variants kept), so the viewer can load both.
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { readBarCacheFile } from '../../src/replay/bar-cache-file';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath, instrumentClass } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile, knownDates } from './sweep-shard';
import * as fs from 'fs';
import * as path from 'path';

// Resolved early — geometry below is defined in STRIKE COUNTS and scaled to
// dollars by the instrument's strike interval (SPX 5, SPY/QQQ 1, NDX 10).
const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

const SLIPPAGE_PER_STRUCTURE = 25;     // 4-leg = ~2× the 2-leg slippage
const MIN_ALIGN = 3, CROSS_WIN = 60;
const FAST0 = 3, SLOW0 = 15;
const CUTOFF_HHMM = 6 * 3600;          // 15:30 ET
const SETTLE_HHMM = 6 * 3600 + 15 * 60; // 15:45 ET — exit before late-day liquidity dries up on deep-ITM legs
const TRADESTART_SEC = 1800;            // 10:00 ET

type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: {tf:number;fast:number;slow:number}[]; }
const SIGNALS: SignalSpec[] = [
  // 2+3+5 multi-TF (5m confirmation slows entries but adds robustness)
  { label: 'HMA  2+3+5 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'HMA  2+3+5 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'HMA  2+3+5 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  { label: 'DEMA 2+3+5 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'DEMA 2+3+5 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'DEMA 2+3+5 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  // 2+3 multi-TF (no 5m confirmation — faster entries, weaker filter)
  { label: 'HMA  2+3 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'HMA  2+3 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'HMA  2+3 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
  { label: 'DEMA 2+3 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'DEMA 2+3 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'DEMA 2+3 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
  // Single-TF (subset — fast TFs only since iron structures fire many trades)
  { label: 'HMA  1m 3x9',  signal: 'hma',  tfs:[{tf:1,fast:3,slow:9}] },
  { label: 'HMA  2m 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9}] },
  { label: 'HMA  3m 3x9',  signal: 'hma',  tfs:[{tf:3,fast:3,slow:9}] },
  { label: 'HMA  5m 3x9',  signal: 'hma',  tfs:[{tf:5,fast:3,slow:9}] },
  { label: 'HMA  1m 3x12', signal: 'hma',  tfs:[{tf:1,fast:3,slow:12}] },
  { label: 'HMA  2m 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12}] },
  { label: 'HMA  3m 3x12', signal: 'hma',  tfs:[{tf:3,fast:3,slow:12}] },
  { label: 'HMA  5m 3x12', signal: 'hma',  tfs:[{tf:5,fast:3,slow:12}] },
  { label: 'HMA  1m 3x21', signal: 'hma',  tfs:[{tf:1,fast:3,slow:21}] },
  { label: 'DEMA 1m 3x9',  signal: 'dema', tfs:[{tf:1,fast:3,slow:9}] },
  { label: 'DEMA 2m 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9}] },
  { label: 'DEMA 1m 3x12', signal: 'dema', tfs:[{tf:1,fast:3,slow:12}] },
];

// ── Iron structures ───────────────────────────────────────────────────────
// shortOffset = pts from spot for the short strikes (0 = ATM = iron butterfly).
// wingWidth   = pts from short strike to the protective long wing.
interface IronSpec {
  label: string;
  kind: 'condor' | 'butterfly';
  shortOffset: number;     // condor: distance from center to short legs (each side)
  wingWidth: number;       // distance from short leg to long wing
  centerOffset?: number;   // distance from spot to the structure's CENTER, signed by signal direction
                           //   bull signal → center = spot + centerOffset
                           //   bear signal → center = spot - centerOffset
                           // 0 (or unset) = static (centered at spot, no directional bias)
}
// Build IB/IC matrix programmatically:
//   wing widths: 5, 10, 15, 20, 25, 30, 40, 50 (re-add tighter widths plus wider sweep)
//   IC short offsets: 10, 15, 20
//   Directional IBs (centerOffset > 0): body displaced by ±N in signal direction
//     for N in {5, 10, 15, 20, 25}, wing widths {10, 15, 20, 25}
// ── Geometry in STRIKE COUNTS (× SI → dollars), per instrument class.
//   SPX/NDX (cash indices, $5/$10 grid, deep index liquidity): keep the
//     validated broad set — SPX×5 = $5..$50, byte-identical to historical
//     results + live OptionX configs.
//   SPY/QQQ ($1 grid, ~$700): cap to realistically-tradeable widths. A
//     >5-strike wing on 1DTE/0DTE ETFs has ~no volume at the long leg — those
//     wider structures are backtest fantasies (the engine "fills" illiquid
//     wings at theoretical mid). 1–5 strikes ($1–$5) is the liquid range.
// Registry-driven (sweep-registry.json class:index|etf) — future-proof for any
// new ticker. Geometry stays strike-COUNT × strikeInterval (NDX×10, QQQ×1);
// class only bounds the liquid sweep width.
const ETF = instrumentClass(TARGET) === 'etf';
const WING_WIDTHS_S = ETF ? [1, 2, 3, 4, 5]       : [1, 2, 3, 4, 5, 6, 8, 10];
const IC_OFFSETS_S  = ETF ? [1, 2, 3]             : [2, 3, 4];
const DIR_CENTER_S  = ETF ? [1, 2, 3]             : [1, 2, 3, 4, 5];
const DIR_WING_S    = ETF ? [1, 2, 3]             : [2, 3, 4, 5];
const STRUCTURES: IronSpec[] = [
  // Static iron butterflies (centered at spot, no directional bias).
  ...WING_WIDTHS_S.map(s => { const w = s * SI; return { label:`IB w${w}`, kind:'butterfly' as const, shortOffset:0, wingWidth:w }; }),
  // Static iron condors (symmetric around spot).
  ...IC_OFFSETS_S.flatMap(os => WING_WIDTHS_S.map(s => { const off = os * SI, w = s * SI; return { label:`IC ${off}w${w}`, kind:'condor' as const, shortOffset:off, wingWidth:w }; })),
  // DIRECTIONAL iron butterflies: body displaced ±N in signal direction.
  ...DIR_CENTER_S.flatMap(cs => DIR_WING_S.map(s => { const co = cs * SI, w = s * SI; return {
    label:`IB±${co} w${w}`, kind:'butterfly' as const, shortOffset:0, wingWidth:w, centerOffset:co,
  }; })),
];

interface ExitSpec { label: string; tpFrac: number; slMult: number; useFlip: boolean; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle',  tpFrac: 0,    slMult: 0,   useFlip: false },
  { label: 'TP10 only',       tpFrac: 0.10, slMult: 0,   useFlip: false },
  { label: 'TP15 only',       tpFrac: 0.15, slMult: 0,   useFlip: false },
  { label: 'TP20 only',       tpFrac: 0.20, slMult: 0,   useFlip: false },
  { label: 'TP25 only',       tpFrac: 0.25, slMult: 0,   useFlip: false },
  { label: 'TP35 only',       tpFrac: 0.35, slMult: 0,   useFlip: false },
  { label: 'TP50 only',       tpFrac: 0.50, slMult: 0,   useFlip: false },
  { label: 'TP75 only',       tpFrac: 0.75, slMult: 0,   useFlip: false },
  // Flip-exit variants: close on signal reversal (first opposite alignment after entry)
  { label: 'TP10 +flip',      tpFrac: 0.10, slMult: 0,   useFlip: true  },
  { label: 'TP15 +flip',      tpFrac: 0.15, slMult: 0,   useFlip: true  },
  { label: 'TP25 +flip',      tpFrac: 0.25, slMult: 0,   useFlip: true  },
  { label: 'TP50 +flip',      tpFrac: 0.50, slMult: 0,   useFlip: true  },
  { label: 'TP25 SL3x',       tpFrac: 0.25, slMult: 3.0, useFlip: false },
  { label: 'TP50 SL3x',       tpFrac: 0.50, slMult: 3.0, useFlip: false },
  { label: 'TP50 SL4x',       tpFrac: 0.50, slMult: 4.0, useFlip: false },
  { label: 'flip only',       tpFrac: 0,    slMult: 0,   useFlip: true  },
];

// Effectively-uncapped budget so the sweep captures every signal that would
// have fired. We TRACK each variant's peak concurrent open count and average
// max-risk, so the dashboard can predict the budget-scaled outcome for any
// lower budget the user chooses, without re-running the sweep.
const MAX_OPEN_RISK = 100_000;

// (dates resolved via sweep-symbol.ts listDatesFor — profile-id aware)
function prevDate(d:string){const dt=new Date(d+'T12:00:00Z');dt.setUTCDate(dt.getUTCDate()-1);if(dt.getUTCDay()===0)dt.setUTCDate(dt.getUTCDate()-2);if(dt.getUTCDay()===6)dt.setUTCDate(dt.getUTCDate()-1);return dt.toISOString().slice(0,10);}
function sessOpenTs(date:string):number{
  const[y,mo,d]=date.split('-').map(Number);
  const utcNoon=new Date(Date.UTC(y,mo-1,d,12,0,0));
  const etHour=parseInt(utcNoon.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));
  const offsetH=12-etHour;
  return Math.floor(Date.UTC(y,mo-1,d,9+offsetH,30,0)/1000);
}

interface TFState { closed:any[]; partial:any|null; }
function mkSt():TFState{return{closed:[],partial:null};}
function feed(st:TFState,b:any,tf:number){
  const bk=Math.floor(b.ts/(tf*60))*(tf*60);
  if(!st.partial||st.partial.ts!==bk){if(st.partial)st.closed.push(st.partial);st.partial={ts:bk,open:b.open,high:b.high,low:b.low,close:b.close};}
  else{if(b.high>st.partial.high)st.partial.high=b.high;if(b.low<st.partial.low)st.partial.low=b.low;st.partial.close=b.close;}
}
function wma(arr:number[],end:number,p:number):number|null{if(end<p-1)return null;let s=0,w=0;for(let i=0;i<p;i++){s+=arr[end-i]*(p-i);w+=(p-i);}return s/w;}
function hmaDir(closes:number[],fast:number,slow:number):'bull'|'bear'|null{
  const hf=Math.floor(fast/2),sf=Math.floor(Math.sqrt(fast));
  const hs=Math.floor(slow/2),ss=Math.floor(Math.sqrt(slow));
  const rf:number[]=[],rs:number[]=[]; let fa:number|null=null,sa:number|null=null;
  for(let i=0;i<closes.length;i++){
    const a=wma(closes,i,hf),b=wma(closes,i,fast);if(a!=null&&b!=null){rf.push(2*a-b);if(rf.length>=sf)fa=wma(rf,rf.length-1,sf);}
    const c=wma(closes,i,hs),d=wma(closes,i,slow);if(c!=null&&d!=null){rs.push(2*c-d);if(rs.length>=ss)sa=wma(rs,rs.length-1,ss);}
  }
  if(fa==null||sa==null)return null; return fa>sa?'bull':'bear';
}
function demaDir(closes:number[],fast:number,slow:number):'bull'|'bear'|null{
  function dema(p:number):number|null{
    if(closes.length<p)return null;
    const a=2/(p+1);
    let e1=0; for(let i=0;i<p;i++)e1+=closes[i]; e1/=p;
    const e1s:number[]=[e1];
    for(let i=p;i<closes.length;i++){e1=a*closes[i]+(1-a)*e1;e1s.push(e1);}
    if(e1s.length<p)return null;
    let e2=0; for(let i=0;i<p;i++)e2+=e1s[i]; e2/=p;
    for(let i=p;i<e1s.length;i++){e2=a*e1s[i]+(1-a)*e2;}
    return 2*e1s[e1s.length-1]-e2;
  }
  const f=dema(fast),s=dema(slow);
  if(f==null||s==null)return null; return f>s?'bull':'bear';
}
function getDir(st:TFState,fast:number,slow:number,signal:Signal):'bull'|'bear'|null{
  const bars=st.partial?[...st.closed,st.partial]:st.closed;
  if(!bars.length)return null;
  const closes=bars.map((b:any)=>b.close);
  return signal==='dema'?demaDir(closes,fast,slow):hmaDir(closes,fast,slow);
}

interface SignalEvent { alignTs:number; dir:'bull'|'bear'; entryTs:number; }
function detectSignals(date:string, spec:SignalSpec, c1:any, p1:any): {entries:SignalEvent[], dirLog:Map<number,('bull'|'bear'|null)[]>} {
  const s1:any[]=c1.spxBars;
  const sess=sessOpenTs(date), tradeStart=sess+TRADESTART_SEC;
  const sts=spec.tfs.map(()=>mkSt());
  for(const b of (p1?.spxBars??[])){sts.forEach((st,i)=>feed(st,b,spec.tfs[i].tf));}
  const prevDirs=spec.tfs.map(()=>null as any);
  const bullCross=spec.tfs.map(()=>0), bearCross=spec.tfs.map(()=>0);
  const dirLog=new Map<number,any[]>();
  const entries:SignalEvent[]=[];
  let bullStreak=0,bearStreak=0,bullFired=false,bearFired=false;
  for(const b of s1){
    sts.forEach((st,i)=>feed(st,b,spec.tfs[i].tf));
    if(b.ts<tradeStart)continue;
    const dirs=sts.map((st,i)=>getDir(st,spec.tfs[i].fast,spec.tfs[i].slow,spec.signal));
    dirLog.set(b.ts,dirs);
    dirs.forEach((d,i)=>{if(prevDirs[i]!==null&&d!==prevDirs[i]){if(d==='bull')bullCross[i]=b.ts;if(d==='bear')bearCross[i]=b.ts;}prevDirs[i]=d;});
    const allBull=dirs.every(d=>d==='bull'), allBear=dirs.every(d=>d==='bear');
    if(allBull){bullStreak++;bearStreak=0;bearFired=false;}else{bullStreak=0;bullFired=false;}
    if(allBear){bearStreak++;bullStreak=0;bullFired=false;}else{bearStreak=0;bearFired=false;}
    if(allBull&&bullStreak>=MIN_ALIGN&&!bullFired){
      const ts=bullCross.filter(t=>t>0);
      if(ts.length===spec.tfs.length&&(Math.max(...ts)-Math.min(...ts))/60<=CROSS_WIN){entries.push({alignTs:b.ts,dir:'bull',entryTs:b.ts+60});bullFired=true;}
    }
    if(allBear&&bearStreak>=MIN_ALIGN&&!bearFired){
      const ts=bearCross.filter(t=>t>0);
      if(ts.length===spec.tfs.length&&(Math.max(...ts)-Math.min(...ts))/60<=CROSS_WIN){entries.push({alignTs:b.ts,dir:'bear',entryTs:b.ts+60});bearFired=true;}
    }
  }
  return {entries,dirLog};
}

function findStrike(c1:any, type:'C'|'P', targetK:number): string|null {
  let best:string|null=null, bestD=Infinity;
  // OCC type char is always 9 chars from the end (works for SPXW/SPY/QQQ/NDXP).
  for(const [s] of c1.contractBars){const sym=s as string;if(sym[sym.length-9]!==type)continue;const k=c1.contractStrikes.get(sym);const d=Math.abs(k-targetK);if(d<bestD){bestD=d;best=sym;}}
  return best;
}
function optPx(bars:any[],ts:number):number|null{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return bars[i].close;return null;}

interface Leg { bars:any[]; sign:number; strike:number; symbol:string; }
// Compute V trajectory for a 4-leg structure. V = Σ sign_i × close_i(t).
function buildTrajectory(legs:Leg[], entryTs:number, endTs:number): Array<{ts:number,V:number}> {
  const tsSet = new Set<number>();
  for(const lg of legs) for(const b of lg.bars) if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a,b)=>a-b);
  // Walk pointers per leg
  const ptr = new Array(legs.length).fill(0);
  const last = new Array<number|null>(legs.length).fill(null);
  const traj: Array<{ts:number,V:number}> = [];
  for(const t of tsList){
    for(let i=0;i<legs.length;i++){
      while(ptr[i] < legs[i].bars.length && legs[i].bars[ptr[i]].ts <= t){
        last[i] = legs[i].bars[ptr[i]].close;
        ptr[i]++;
      }
    }
    if(last.every(v=>v!=null)){
      let V = 0;
      for(let i=0;i<legs.length;i++) V += legs[i].sign * (last[i] as number);
      traj.push({ts:t, V});
    }
  }
  return traj;
}

function applyExit(traj:Array<{ts:number,V:number}>, endTs:number, legs:Leg[],
                   credit:number, tpFrac:number, slMult:number, flipTs:number,
                   spxAtSettle:number|null)
                  : {exitTs:number, exitV:number, reason:string} {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac>0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slMult>0 ? (1 + slMult) * credit : Infinity;
  for(const p of traj){
    if(p.ts > effEnd) break;
    if(tpFrac>0 && p.V <= tpV) return {exitTs:p.ts, exitV:Math.max(0,p.V), reason:'TP'};
    if(slMult>0 && p.V >= slV) return {exitTs:p.ts, exitV:p.V, reason:'SL'};
  }
  // No TP/SL hit by effEnd.
  // Two cases:
  //  A) effEnd == endTs (true session settle): use INTRINSIC value from SPX_close and strikes.
  //     This is correct at 15:45 ET on 0DTE — option value = max(0, intrinsic) + ~0 extrinsic.
  //     Avoids the stale-leg-bar bias (deep ITM legs often stop printing late in the day).
  //  B) effEnd < endTs (flip exit before settle): use last available close per leg (best-effort MTM).
  // INTRINSIC settle is ONLY valid at true same-day expiry (0DTE @ 15:45 ET,
  // extrinsic ≈ 0). For 1DTE+ the contract still has ≥1 session of life at the
  // 15:45 day-D forced exit and carries real extrinsic — valuing it at
  // intrinsic massively inflates short-premium P&L. So gate on dte===0; for
  // dte≥1 use the real option-bar mark (the OPRA close IS in the day-D parquet).
  if(effEnd === endTs && spxAtSettle != null && TARGET.dte === 0){
    let V = 0;
    for(const lg of legs){
      // OCC type char is 9 from the end (prefix-agnostic: SPXW/SPY/QQQ/NDXP)
      const isPut = (lg.symbol[lg.symbol.length - 9] === 'P');
      const intrinsic = isPut ? Math.max(0, lg.strike - spxAtSettle)
                              : Math.max(0, spxAtSettle - lg.strike);
      V += lg.sign * intrinsic;
    }
    return {exitTs:effEnd, exitV: Math.max(0,V), reason: 'expiry'};
  } else {
    // Real mark-to-market at the exit ts (last printed close per leg).
    // Covers: flip exits (effEnd<endTs) AND 1DTE+ settle (effEnd==endTs, dte≥1).
    let V = 0; let ok = true;
    for(const lg of legs){
      const c = optPx(lg.bars, effEnd);
      if(c==null){ ok = false; break; }
      V += lg.sign * c;
    }
    const reason = effEnd === endTs ? 'settle-mtm' : 'flip';
    return {exitTs:effEnd, exitV: ok ? Math.max(0,V) : 0, reason};
  }
}

// Find the V at a given timestamp within a trajectory (latest V where ts ≤ targetTs).
// Used for rotation eviction decisions ("current V of each open position at signal time").
function currentV(traj: Array<{ts:number,V:number}>, targetTs: number): number | null {
  let v: number | null = null;
  for(const p of traj){
    if(p.ts > targetTs) break;
    v = p.V;
  }
  return v;
}

interface HourBucket { n:number; creditSum:number; riskSum:number; pnlSum:number; wins:number; }
interface Stat {
  pnl:number; pnl_gross:number; n:number; wins:number; daily:Map<string,number>;
  creditSum:number; widthSum:number;
  perHour: Map<number, HourBucket>;
  peakConcurrent: number;
  evictions: number;
  // Trade-duration tracking (seconds). Sum across all trades; divide by n for avg.
  durationSumSec: number;
}
const results = new Map<string, Stat>();
function recK(sig:string,struct:string,ex:string){return `${sig}|${struct}|${ex}`;}

// Fast ET hour from unix ts. Uses the day's sessOpen (= 09:30 ET in unix sec)
// as the reference, so no Date/toLocaleString calls in the hot loop.
// 09:30 ET = minute 570 of the day; etHour = floor((570 + (ts−sessOpen)/60) / 60).
let _sessOpenForEtHour = 0;
function setEtHourSessOpen(sessOpenTs: number){ _sessOpenForEtHour = sessOpenTs; }
function etHour(ts: number): number {
  const minSinceOpen = (ts - _sessOpenForEtHour) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}

function rec(sig:string,struct:string,ex:string, pnl_gross:number, date:string, credit:number, width:number, entryTs:number, maxRisk:number, durationSec:number = 0){
  const k=recK(sig,struct,ex);
  let v=results.get(k); if(!v){v={pnl:0,pnl_gross:0,n:0,wins:0,daily:new Map(),creditSum:0,widthSum:0,perHour:new Map(),peakConcurrent:0,evictions:0,durationSumSec:0}; results.set(k,v);}
  const pnl_net = pnl_gross - SLIPPAGE_PER_STRUCTURE;
  v.pnl += pnl_net; v.pnl_gross += pnl_gross; v.n++; if(pnl_net>0)v.wins++; v.daily.set(date,(v.daily.get(date)??0)+pnl_net);
  v.creditSum += credit; v.widthSum += width;
  v.durationSumSec += durationSec;
  // Per-hour bucket (clamped to 9..15 — anything outside is noise/wrong-day)
  const h = Math.max(9, Math.min(15, etHour(entryTs)));
  let hb = v.perHour.get(h); if(!hb){hb={n:0,creditSum:0,riskSum:0,pnlSum:0,wins:0}; v.perHour.set(h,hb);}
  hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl_net;
  if(pnl_net > 0) hb.wins++;
}

// ── Per-trade emission (additive, env-gated) ───────────────────────────────
// SWEEP_EMIT_TRADES_KEYS="signal|structure|exit\n…" enables emission for
// specified variants only; SWEEP_EMIT_TRADES_DIR is the output root. Each
// emitted day = one JSON file under {dir}/{slug}/{date}.json with the full
// 4-leg trade history + SPX bars + per-leg bars (deduped) for the UI.
interface IronTradeRecord {
  entryTs:number; exitTs:number; durationSec:number;
  dir:'bull'|'bear';
  spxAtEntry:number; spxAtExit:number;
  center:number;
  shortPutSymbol:string;  shortPutStrike:number;  shortPutEntryMark:number;  shortPutExitMark:number;
  longPutSymbol:string;   longPutStrike:number;   longPutEntryMark:number;   longPutExitMark:number;
  shortCallSymbol:string; shortCallStrike:number; shortCallEntryMark:number; shortCallExitMark:number;
  longCallSymbol:string;  longCallStrike:number;  longCallEntryMark:number;  longCallExitMark:number;
  netCredit:number; netExitDebit:number; wingWidth:number; maxRisk:number;
  tpFrac:number; slMult:number;
  pnlGross:number; pnlNet:number;
  exitReason:string;
}
interface IronDayEmit {
  date:string; signal:string; structure:string; exit:string;
  spxOpen:number; spxClose:number; spxSettle:number|null;
  trades: IronTradeRecord[];
  spxBars: any[];
  contractBars: Record<string, any[]>;
}
const EMIT_KEYS = (() => {
  const raw = process.env.SWEEP_EMIT_TRADES_KEYS;
  if (!raw) return null;
  return new Set(raw.split(/[\n,]/).map(s=>s.trim()).filter(Boolean));
})();
const EMIT_DIR = process.env.SWEEP_EMIT_TRADES_DIR
  || path.join(process.cwd(), 'scripts/autoresearch/output/iron-trades');
const EMIT_BUFFER = new Map<string, Map<string, IronDayEmit>>();
function slugify(k:string){ return k.replace(/[|]/g,'__').replace(/\s+/g,'_'); }
function emitIronTrade(k:string, date:string, hdr:{spxOpen:number; spxClose:number; spxSettle:number|null}, tr:IronTradeRecord, spxBars:any[], legs:Array<{symbol:string;bars:any[]}>){
  if (!EMIT_KEYS || !EMIT_KEYS.has(k)) return;
  let byDate = EMIT_BUFFER.get(k); if(!byDate){byDate=new Map(); EMIT_BUFFER.set(k,byDate);}
  let d = byDate.get(date);
  if(!d){
    const [signal,structure,exit] = k.split('|');
    d = { date, signal, structure, exit,
          spxOpen: hdr.spxOpen, spxClose: hdr.spxClose, spxSettle: hdr.spxSettle,
          trades: [], spxBars, contractBars: {} };
    byDate.set(date,d);
  }
  d.trades.push(tr);
  for (const lg of legs) if (!d.contractBars[lg.symbol]) d.contractBars[lg.symbol] = lg.bars;
}
function compactBars(bars:any[]): number[][] {
  const out:number[][] = new Array(bars.length);
  for (let i=0;i<bars.length;i++) {
    const b = bars[i];
    out[i] = [b.ts, b.open, b.high, b.low, b.close, b.volume ?? 0];
  }
  return out;
}
function flushTrades(){
  if (!EMIT_KEYS || EMIT_BUFFER.size === 0) return;
  fs.mkdirSync(EMIT_DIR, { recursive: true });
  let nFiles = 0, nTrades = 0;
  for (const [k, byDate] of EMIT_BUFFER) {
    const sub = path.join(EMIT_DIR, slugify(k));
    fs.mkdirSync(sub, { recursive: true });
    for (const [date, day] of byDate) {
      day.trades.sort((a,b)=>a.entryTs-b.entryTs);
      const compact = {
        ...day,
        spxBars: compactBars(day.spxBars),
        contractBars: Object.fromEntries(
          Object.entries(day.contractBars).map(([sym, b]) => [sym, compactBars(b as any[])])
        ),
      };
      fs.writeFileSync(path.join(sub, `${date}.json`), JSON.stringify(compact));
      nFiles++; nTrades += day.trades.length;
    }
  }
  console.error(`[iron-trades] emitted ${nTrades} trades across ${nFiles} files under ${EMIT_DIR}`);
}

const ALL_DATES = listDatesFor(TARGET);
// Parallel-shard hook (see sweep-shard.ts). SWEEP_MERGE → skip loop, results
// come from shard dumps. SWEEP_SHARD="i/n" → only this worker's date subset.
// No env = serial, identical. Each shard keeps every date's FULL bar history,
// so this cannot introduce look-ahead and does not alter volume handling.
const SWEEP_DATES = process.env.SWEEP_MERGE ? [] : shardDates(ALL_DATES);
// Incremental hook (see credit-spread-sweep / sweep-shard): SWEEP_STATE=<file>
// loads the prior accumulator, replays only NEW dates (idempotent by date),
// finalize still writes FULL-history dashboard JSON, then state is persisted.
const STATE_FILE = process.env.SWEEP_STATE;
let RUN_DATES = SWEEP_DATES;
if (STATE_FILE && !process.env.SWEEP_MERGE && !process.env.SWEEP_SHARD) {
  const had = mergeStateFile(STATE_FILE, results);
  if (had) {
    const known = knownDates(results);
    RUN_DATES = SWEEP_DATES.filter(d => !known.has(d));
    console.error(`[incremental] state has ${known.size} dates; replaying ${RUN_DATES.length} NEW: ${RUN_DATES.join(',') || '(none)'}`);
  } else {
    console.error(`[incremental] no state file — bootstrap full ${SWEEP_DATES.length} dates`);
  }
}
console.error(`[${TARGET.symbol}] Iron sweep — dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD} → ${SWEEP_DATES.length})` : ''}, signals: ${SIGNALS.length}, structures: ${STRUCTURES.length}, exits: ${EXITS.length}`);

for(let di=0; di<RUN_DATES.length; di++){
  const date = RUN_DATES[di];
  if(di%20===0) console.error(`  ${di}/${RUN_DATES.length}  ${date}`);
  let c1:any, p1:any;
  try { c1 = loadDay(TARGET,date,'1m') as any; p1 = loadDay(TARGET,prevDate(date),'1m') as any; }
  catch { continue; }
  if(!c1?.spxBars?.length) continue;
  const s1:any[]=c1.spxBars;
  const sess = sessOpenTs(date), cutoff = sess + CUTOFF_HHMM, settle = sess + SETTLE_HHMM;
  setEtHourSessOpen(sess);   // arm fast etHour for this day
  // SPX close at settle time — used for intrinsic-value settle (avoids stale leg-bar bias).
  const spxAtSettle = optPx(s1, settle);

  // Per (sig, struct, exit) — track open positions for this day so we can apply
  // maxConcurrent + close-least-profitable rotation. Positions are CLOSED naturally
  // (TP/SL/flip/settle via pre-computed exit) when their natural exit time arrives,
  // or EVICTED at the current V if rotation needs space for a new entry.
    // Per-variant per-day overlap tracking: list of (entryTs, exitTs) events.
  // Used to compute peak concurrent open positions after all trades recorded.
  const overlapMap = new Map<string, Array<{entry:number, exit:number}>>();

  for(const sig of SIGNALS){
    const {entries,dirLog} = detectSignals(date, sig, c1, p1);
    // Sort entries by entryTs (should already be, but guarantee)
    entries.sort((a,b) => a.entryTs - b.entryTs);

    for(const ev of entries){
      if(ev.entryTs >= cutoff) continue;

      const spxEntry = optPx(s1, ev.entryTs - 1);
      if(spxEntry==null) continue;

      // Flip cutoff for this signal direction
      let flipTs = Infinity;
      for(const [t, dirs] of dirLog){
        if(t <= ev.entryTs) continue;
        if(!dirs) continue;
        const flip = ev.dir==='bull' ? dirs.every((d:any)=>d==='bear') : dirs.every((d:any)=>d==='bull');
        if(flip){flipTs = t+60; break;}
      }

      for(const st of STRUCTURES){
        const center = st.centerOffset
          ? spxEntry + (ev.dir === 'bull' ? st.centerOffset : -st.centerOffset)
          : spxEntry;
        const Kshort_put  = center - st.shortOffset;
        const Klong_put   = Kshort_put - st.wingWidth;
        const Kshort_call = center + st.shortOffset;
        const Klong_call  = Kshort_call + st.wingWidth;
        const sym_sp = findStrike(c1, 'P', Kshort_put);
        const sym_lp = findStrike(c1, 'P', Klong_put);
        const sym_sc = findStrike(c1, 'C', Kshort_call);
        const sym_lc = findStrike(c1, 'C', Klong_call);
        if(!sym_sp || !sym_lp || !sym_sc || !sym_lc) continue;
        if(new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) continue;

        const legs:Leg[] = [
          { symbol:sym_sp, strike:Kshort_put,  sign:+1, bars: c1.contractBars.get(sym_sp) as any[] },
          { symbol:sym_lp, strike:Klong_put,   sign:-1, bars: c1.contractBars.get(sym_lp) as any[] },
          { symbol:sym_sc, strike:Kshort_call, sign:+1, bars: c1.contractBars.get(sym_sc) as any[] },
          { symbol:sym_lc, strike:Klong_call,  sign:-1, bars: c1.contractBars.get(sym_lc) as any[] },
        ];
        const entries_px = legs.map(lg => optPx(lg.bars, ev.entryTs - 1));
        if(entries_px.some(p => p==null)) continue;
        const credit = legs.reduce((s,lg,i) => s + lg.sign * (entries_px[i] as number), 0);
        if(credit <= 0.10) continue;
        if(credit >= st.wingWidth * 0.95) continue;

        const traj = buildTrajectory(legs, ev.entryTs, settle);
        const maxRisk = (st.wingWidth - credit) * 100;

        for(const ex of EXITS){
          // Compute natural exit and record P&L immediately (no position mgmt in sweep).
          // Concurrency tracked via overlapMap so dashboard can compute budget-scaled outcome.
          const flipUse = ex.useFlip ? flipTs : Infinity;
          const nat = applyExit(traj, settle, legs, credit, ex.tpFrac, ex.slMult, flipUse, spxAtSettle);
          const pnl_gross = (credit - nat.exitV) * 100;
          const pnl_net = pnl_gross - SLIPPAGE_PER_STRUCTURE;
          const durationSec = Math.max(0, nat.exitTs - ev.entryTs);
          rec(sig.label, st.label, ex.label, pnl_gross, date, credit, st.wingWidth, ev.entryTs, maxRisk, durationSec);

          // Record (entry, exit) span for peak-concurrent computation at end of day.
          const k = `${sig.label}|${st.label}|${ex.label}`;
          let evs = overlapMap.get(k); if(!evs){evs=[]; overlapMap.set(k, evs);}
          evs.push({entry: ev.entryTs, exit: nat.exitTs});

          // Per-trade emission (no-op unless this variant key is in EMIT_KEYS).
          if (EMIT_KEYS && EMIT_KEYS.has(k)) {
            const spxAtExit = optPx(s1, nat.exitTs) ?? spxEntry;
            // Per-leg exit marks. For intrinsic settle at 0DTE expiry use
            // SPX-vs-strike; else fall back to leg-bar close.
            // legs[0..1] are puts, legs[2..3] are calls (positional, see leg build).
            const exitMark = (lg:Leg, isPut:boolean) => {
              if (nat.reason === 'expiry' && spxAtSettle != null) {
                return isPut
                  ? Math.max(0, lg.strike - spxAtSettle)
                  : Math.max(0, spxAtSettle - lg.strike);
              }
              return optPx(lg.bars, nat.exitTs) ?? 0;
            };
            const tr: IronTradeRecord = {
              entryTs: ev.entryTs, exitTs: nat.exitTs, durationSec,
              dir: ev.dir,
              spxAtEntry: spxEntry, spxAtExit,
              center,
              shortPutSymbol: sym_sp, shortPutStrike: Kshort_put,
              shortPutEntryMark: entries_px[0] as number, shortPutExitMark: exitMark(legs[0], true),
              longPutSymbol:  sym_lp, longPutStrike: Klong_put,
              longPutEntryMark:  entries_px[1] as number, longPutExitMark:  exitMark(legs[1], true),
              shortCallSymbol: sym_sc, shortCallStrike: Kshort_call,
              shortCallEntryMark: entries_px[2] as number, shortCallExitMark: exitMark(legs[2], false),
              longCallSymbol:  sym_lc, longCallStrike: Klong_call,
              longCallEntryMark:  entries_px[3] as number, longCallExitMark:  exitMark(legs[3], false),
              netCredit: credit, netExitDebit: nat.exitV, wingWidth: st.wingWidth, maxRisk,
              tpFrac: ex.tpFrac, slMult: ex.slMult,
              pnlGross: pnl_gross, pnlNet: pnl_net,
              exitReason: nat.reason,
            };
            const spxOpen = s1[0]?.close ?? spxEntry;
            const spxClose = s1[s1.length-1]?.close ?? spxEntry;
            emitIronTrade(k, date,
              { spxOpen, spxClose, spxSettle: spxAtSettle },
              tr, s1, legs);
          }
        }
      }
    }
  }

  // End of day: compute peak concurrent open positions per variant via sweep-line.
  // For each variant's events list, sort by entry time; for each entry, sum how
  // many prior entries have not yet exited. peak = max across entries.
  for(const [k, evs] of overlapMap){
    if(evs.length === 0) continue;
    const stat = results.get(k); if(!stat) continue;
    // Build event list: +1 at entry, -1 at exit, sort by time
    const events: Array<{ts:number, delta:number}> = [];
    for(const e of evs){ events.push({ts:e.entry, delta:+1}); events.push({ts:e.exit, delta:-1}); }
    events.sort((a,b) => a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts);  // exits first on ties
    let cur = 0, peak = 0;
    for(const e of events){ cur += e.delta; if(cur > peak) peak = cur; }
    if(peak > stat.peakConcurrent) stat.peakConcurrent = peak;
  }
  overlapMap.clear();
}

// Parallel-shard finalize hook. Worker: dump partial + exit BEFORE the inline
// report/JSON-merge below (the merge run owns the dashboard JSON). Merge run:
// fold every shard dump into `results`, then fall through to the normal
// inline finalize so output is byte-identical to a serial run.
if (process.env.SWEEP_SHARD_OUT) {
  dumpResults(results, process.env.SWEEP_SHARD_OUT);
  // Shard worker also flushes its own trade buffer (each shard owns a
  // disjoint date subset → no overwrite). Merge run buffer is empty.
  flushTrades();
  process.exit(0);
}
if (process.env.SWEEP_MERGE) loadShardsInto(process.env.SWEEP_MERGE, results);
// Serial run reaches here too; trades flushed at very end (after finalize).

console.log(`\n=== IRON CONDOR/BUTTERFLY SWEEP — look-ahead protected, $${SLIPPAGE_PER_STRUCTURE}/RT slippage ===`);
const rows:any[] = [];
for(const [k,v] of results){
  const [signal,spread,exit] = k.split('|');
  const dailyArr = [...v.daily.values()];
  let cum=0,peak=0,mdd=0; for(const dp of dailyArr){cum+=dp; peak=Math.max(peak,cum); mdd=Math.max(mdd,peak-cum);}
  const pos = dailyArr.filter(x=>x>0.1).length;
  const wr = 100*v.wins/Math.max(1,v.n);
  const ratio = mdd>0 ? v.pnl/mdd : 0;
  const avgCredit = v.creditSum/Math.max(1,v.n);
  const avgWidth = v.widthSum/Math.max(1,v.n);
  const avgMaxRisk = (avgWidth - avgCredit) * 100;
  const avgDurMin = v.n > 0 ? (v.durationSumSec / v.n / 60) : 0;
  // avgConcurrent = time-weighted average open-position count during the
  // entry window (10:00 → 15:45 ET = 20700s). Derived from total
  // position-seconds across active days. Represents the EXPECTED simultaneous
  // risk at a typical moment, vs peakConcurrent which is the worst-case
  // overlap. Useful when trades are short-held (3-10 min) so peak overstates
  // typical capital tied up.
  const SESSION_SEC = 20700;  // 10:00 → 15:45 ET
  const numActiveDays = v.daily.size;
  const avgConcurrent = (numActiveDays > 0)
    ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2)
    : 0;
  const avgRiskCapacity = +(avgConcurrent * avgMaxRisk).toFixed(0);
  rows.push({signal,spread,exit,pnl:v.pnl,pnl_gross:v.pnl_gross,n:v.n,wr,dd:mdd,ratio,pos,
             avgCredit:+avgCredit.toFixed(3),avgMaxRisk:+avgMaxRisk.toFixed(0),
             avgPnlPerTrade:+(v.pnl/Math.max(1,v.n)).toFixed(2),
             peakConcurrent:v.peakConcurrent, evictions:v.evictions,
             peakRiskCapacity:+(v.peakConcurrent * avgMaxRisk).toFixed(0),
             avgConcurrent, avgRiskCapacity, numActiveDays,
             avgDurMin:+avgDurMin.toFixed(1)});
}
rows.sort((a,b)=>b.pnl-a.pnl);
console.log(`Variants: ${rows.length}.  Positive net: ${rows.filter(r=>r.pnl>0).length}.\n`);
console.log(`${'Signal'.padEnd(16)} ${'Structure'.padEnd(11)} ${'Exit'.padEnd(18)} ${'$Net'.padStart(11)} ${'N'.padStart(5)} ${'WR%'.padStart(5)} ${'$DD'.padStart(9)} ${'Ratio'.padStart(6)} ${'+days'.padStart(5)}`);
console.log('-'.repeat(96));
for(const r of rows.slice(0,30)){
  console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(11)} ${r.exit.padEnd(18)} $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
}

// Append to spread-sweep JSON so the viewer picks up everything in one place.
// Existing 2-leg credit-spread rows stay; this adds new condor/butterfly rows.
const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
const DAILY_JSON = outPath('/tmp/credit_spread_daily.json', TARGET);
let existing:any[] = [];
try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON,'utf8')); } catch {}
// De-dup: remove any prior iron rows so re-running this script is idempotent.
// MUST also match directional butterflies "IB±25 w10" / "IB±1 w5" — the old
// `startsWith('IB ')` (note the space) silently MISSED these, so stale
// directional-IB rows from pre-fix geometry accumulated forever. Credit-spread
// labels are NNoffM (1ITM/ATM/5OTM…) — never IB/IC — so a bare prefix is safe.
const isIron = (s:string) => s.startsWith('IB') || s.startsWith('IC');
existing = existing.filter((r:any) => !isIron(r.spread));
const merged = existing.concat(rows);
fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged));
// Also write to the live viewer location so the dashboard picks it up
// without a manual copy step. Kept the /tmp file too for legacy tooling.
const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}
console.log(`\nMerged into ${SWEEP_JSON} + ${STUDIO_SWEEP}: ${existing.length} prior + ${rows.length} new = ${merged.length}`);

// Build/extend daily series file
let existingDaily:any = { dates:[], series:{} };
try { existingDaily = JSON.parse(fs.readFileSync(DAILY_JSON,'utf8')); } catch {}
// Drop prior iron series keys
for(const k of Object.keys(existingDaily.series||{})){
  const parts = k.split('|');
  if(parts.length>=2 && (parts[1].startsWith('IB') || parts[1].startsWith('IC'))) delete existingDaily.series[k];
}
const allDatesSet = new Set<string>(existingDaily.dates || []);
for(const v of results.values()) for(const d of v.daily.keys()) allDatesSet.add(d);
const dates = [...allDatesSet].sort();
const di = new Map<string,number>(); dates.forEach((d,i)=>di.set(d,i));
// Re-index existing series onto new date list (in case iron adds dates that weren't in 2-leg)
const series:Record<string,number[]> = {};
for(const k of Object.keys(existingDaily.series||{})){
  const oldArr:number[] = existingDaily.series[k];
  const oldDates:string[] = existingDaily.dates || [];
  const newArr = new Array(dates.length).fill(0);
  for(let i=0;i<oldDates.length;i++){
    const idx = di.get(oldDates[i]);
    if(idx!=null) newArr[idx] = oldArr[i] || 0;
  }
  series[k] = newArr;
}
// Add iron series
for(const [k,v] of results){
  const arr = new Array(dates.length).fill(0);
  for(const [d,p] of v.daily) arr[di.get(d)!] = +p.toFixed(2);
  series[k] = arr;
}
fs.writeFileSync(DAILY_JSON, JSON.stringify({dates, series}));
const STUDIO_DAILY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'), TARGET);
try { fs.writeFileSync(STUDIO_DAILY, JSON.stringify({dates, series})); } catch {}
console.log(`Daily series rewritten: ${dates.length} dates × ${Object.keys(series).length} variants`);

// ── Per-hour aggregates ──────────────────────────────────────────────────────
// For each (signal, structure, exit), emit hourly avg credit / max risk / P&L / WR.
// Output: /tmp/iron_hourly.json — separate file so it doesn't bloat the main viewer fetch.
const HOURLY_JSON = outPath('/tmp/iron_hourly.json', TARGET);
const STUDIO_HOURLY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'), TARGET);
const hourlyOut:any[] = [];
for(const [k,v] of results){
  const [signal,structure,exit] = k.split('|');
  const byHour:Record<number, any> = {};
  for(const [h, hb] of v.perHour){
    if(hb.n === 0) continue;
    byHour[h] = {
      n: hb.n,
      avgCredit:   +(hb.creditSum / hb.n).toFixed(3),
      avgMaxRisk:  +(hb.riskSum   / hb.n).toFixed(0),
      avgPnl:      +(hb.pnlSum    / hb.n).toFixed(2),
      totalPnl:    +hb.pnlSum.toFixed(0),
      wr:          +(100 * hb.wins / hb.n).toFixed(1),
    };
  }
  hourlyOut.push({signal, structure, exit, hours: byHour});
}
fs.writeFileSync(HOURLY_JSON, JSON.stringify(hourlyOut));
try { fs.writeFileSync(STUDIO_HOURLY, JSON.stringify(hourlyOut)); } catch {}
console.log(`Hourly aggregates saved: ${hourlyOut.length} variants × up to 7 hourly buckets`);

// Brief stdout summary for top variants
console.log(`\n=== HOURLY BREAKDOWN — top 5 by net PnL ===`);
const topRows = [...results.entries()].sort((a,b) => b[1].pnl - a[1].pnl).slice(0, 5);
for(const [k, v] of topRows){
  console.log(`\n${k}`);
  console.log(`  hr   N   credit   maxRisk   $/trade   WR%`);
  for(const h of [10,11,12,13,14,15]){
    const hb = v.perHour.get(h);
    if(!hb || hb.n === 0){ console.log(`  ${h}    -        -         -         -      -`); continue; }
    const avgC = hb.creditSum/hb.n, avgR = hb.riskSum/hb.n, avgP = hb.pnlSum/hb.n;
    console.log(`  ${h}  ${String(hb.n).padStart(4)}  $${avgC.toFixed(2).padStart(5)}   $${avgR.toFixed(0).padStart(5)}   $${avgP>=0?'+':''}${avgP.toFixed(1).padStart(6)}   ${(100*hb.wins/hb.n).toFixed(0)}`);
  }
}

// Incremental / bootstrap: persist the merged accumulator so the next nightly
// run replays only the following day. Runs for single-process incremental
// AND the SWEEP_MERGE finalize (so a sharded bootstrap seeds state). Shard
// workers SWEEP_SHARD_OUT'd + process.exit(0)'d above, so they never reach
// here — guard just excludes that path.
if (STATE_FILE && !process.env.SWEEP_SHARD_OUT) {
  dumpResults(results, STATE_FILE);
  console.error(`[incremental] state saved → ${STATE_FILE}`);
}

// Serial / merge-finalize trade emission (no-op unless SWEEP_EMIT_TRADES_KEYS).
flushTrades();

/**
 * credit-spread-sweep.ts
 *
 * Sweep short call / short put credit spreads using the SAME look-ahead-protected
 * signal engine as backtest-server.ts. Two signal indicators (HMA, DEMA),
 * multiple TF×fast×slow combos, multiple spread geometries, multiple exit policies.
 *
 * Per signal: HMA bear → short call spread; HMA bull → short put spread (same for DEMA).
 * Spread: short closer-to-money leg + long width-points further OTM.
 * Slippage: $15 / round-trip per spread (covers both legs of bid-ask).
 *
 * Run: npx tsx scripts/diag/credit-spread-sweep.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { readBarCacheFile } from '../../src/replay/bar-cache-file';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile, knownDates } from './sweep-shard';
import * as fs from 'fs';
import * as path from 'path';

// ── Serial-execution guard ──────────────────────────────────────────────────
// Direct invocation takes 40+ minutes on a 280-date SPX run. ALWAYS go through
// sweep-parallel.ts (8× faster). The serial path is dead.
// SWEEP_ALLOW_SERIAL=1 escape hatch for single-date debug; almost never useful.
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: credit-spread-sweep.ts must NOT be invoked directly.
Use the parallel runner instead:

  npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine credit --shards 8

Pass-through env vars (SWEEP_FILL_MODE, SWEEP_CLOSE_HALFSPREAD, etc.) inherit
through to all workers automatically.

Override only for single-date debugging: SWEEP_ALLOW_SERIAL=1
`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval; // $ per strike: SPX 5, SPY/QQQ 1, NDX 10

const SLIPPAGE_PER_SPREAD = 15;

// Pay-through-ask close model — see iron-sweep.ts for full rationale.
// 2-leg structure → 2 legs × half_spread penalty on close. Default $0.10/leg
// → $0.20 added to exit V. Applied to TP/SL/flip/settle-MTM, NOT to cash-settled
// expiry. SWEEP_FILL_MODE: 'soft' (default) fills always at mid+penalty;
// 'hard' fills only when mid penetrates by penalty, at the order's exact limit.
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? 0.10);
const CLOSE_PENALTY_V = 2 * CLOSE_HALFSPREAD_PER_LEG;
// Default 'hard' — see iron-sweep.ts for the rationale. Soft is for diagnostic
// comparison ONLY, never for strategy selection.
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';

// ── Exit liquidity gate (shorts-fresh) ──────────────────────────────────────
// The trajectory carries forward each leg's last close until its next print, so
// a TP/SL could fire off a STALE close that wasn't tradeable that minute — a
// "false mid" that books a phantom fill and fakes short hold times. The fix that
// survived study (docs/FILL-VOLUME-STUDY.md): honor a TP/SL ONLY at a bar where
// the SHORT leg actually printed that minute (you transact the short to realize
// the exit; the long protective leg's staleness must not block/fake a fill).
//   SWEEP_EXIT_GATE = 'shorts-fresh' (default) | 'none' (legacy optimistic, no gate).
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? 'shorts-fresh') as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const MIN_ALIGN = 3, CROSS_WIN = 60;
const FAST0 = 3, SLOW0 = 15; // tier-0 unused for spreads but signal engine wants it
const CUTOFF_HHMM = 6 * 3600; // 15:30 ET (sec from sess open)
const SETTLE_HHMM = 6 * 3600 + 15 * 60; // 15:45 ET — force-exit window has liquid quotes — close before final 5 min
const TRADESTART_SEC = 1800; // 10:00 ET (30 min after 9:30)

// ── Signals to sweep ───────────────────────────────────────────────────────
type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: {tf:number;fast:number;slow:number}[]; }
const SIGNALS: SignalSpec[] = [
  // 2+3+5 multi-TF
  { label: 'HMA  2+3+5 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'HMA  2+3+5 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'HMA  2+3+5 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  { label: 'DEMA 2+3+5 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'DEMA 2+3+5 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'DEMA 2+3+5 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  // 2+3 multi-TF (faster entries, no 5m wait)
  { label: 'HMA  2+3 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'HMA  2+3 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'HMA  2+3 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
  { label: 'DEMA 2+3 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'DEMA 2+3 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'DEMA 2+3 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
  // Single-TF: HMA
  { label: 'HMA  1m 3x9',  signal: 'hma',  tfs:[{tf:1,fast:3,slow:9}] },
  { label: 'HMA  2m 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9}] },
  { label: 'HMA  3m 3x9',  signal: 'hma',  tfs:[{tf:3,fast:3,slow:9}] },
  { label: 'HMA  5m 3x9',  signal: 'hma',  tfs:[{tf:5,fast:3,slow:9}] },
  { label: 'HMA  1m 3x12', signal: 'hma',  tfs:[{tf:1,fast:3,slow:12}] },
  { label: 'HMA  2m 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12}] },
  { label: 'HMA  3m 3x12', signal: 'hma',  tfs:[{tf:3,fast:3,slow:12}] },
  { label: 'HMA  5m 3x12', signal: 'hma',  tfs:[{tf:5,fast:3,slow:12}] },
  { label: 'HMA  1m 3x21', signal: 'hma',  tfs:[{tf:1,fast:3,slow:21}] },
  { label: 'HMA  2m 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21}] },
  { label: 'HMA  3m 3x21', signal: 'hma',  tfs:[{tf:3,fast:3,slow:21}] },
  { label: 'HMA  5m 3x21', signal: 'hma',  tfs:[{tf:5,fast:3,slow:21}] },
  // Single-TF: DEMA
  { label: 'DEMA 1m 3x9',  signal: 'dema', tfs:[{tf:1,fast:3,slow:9}] },
  { label: 'DEMA 2m 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9}] },
  { label: 'DEMA 3m 3x9',  signal: 'dema', tfs:[{tf:3,fast:3,slow:9}] },
  { label: 'DEMA 5m 3x9',  signal: 'dema', tfs:[{tf:5,fast:3,slow:9}] },
  { label: 'DEMA 1m 3x12', signal: 'dema', tfs:[{tf:1,fast:3,slow:12}] },
  { label: 'DEMA 2m 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12}] },
  { label: 'DEMA 3m 3x12', signal: 'dema', tfs:[{tf:3,fast:3,slow:12}] },
  { label: 'DEMA 5m 3x12', signal: 'dema', tfs:[{tf:5,fast:3,slow:12}] },
  { label: 'DEMA 1m 3x21', signal: 'dema', tfs:[{tf:1,fast:3,slow:21}] },
  { label: 'DEMA 2m 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21}] },
  { label: 'DEMA 3m 3x21', signal: 'dema', tfs:[{tf:3,fast:3,slow:21}] },
  { label: 'DEMA 5m 3x21', signal: 'dema', tfs:[{tf:5,fast:3,slow:21}] },
];

// ── Spreads (short_offset = distance OTM from spot; width = pts to long leg) ──
interface SpreadSpec { label: string; shortOffset: number; width: number; }
// Geometry in STRIKE COUNTS (× SI → dollars). SPX (SI=5) reproduces the
// historical $ offsets/widths and labels EXACTLY (so existing SPX results +
// live OptionX configs are unchanged); SPY/QQQ (SI=1) get correct $1-grid
// spreads instead of 15-strike-wide nonsense.
//   soS = short-leg offset in strikes (neg = ITM, pos = OTM); wS = width in strikes
const SPREAD_DEFS: Array<{ soS: number; wS: number }> = [
  { soS: -3, wS: 2 }, { soS: -2, wS: 2 }, { soS: -2, wS: 4 },  // ITM
  { soS: -1, wS: 2 }, { soS: -1, wS: 1 },
  { soS:  0, wS: 1 }, { soS:  0, wS: 2 },                       // ATM
  { soS:  1, wS: 1 }, { soS:  1, wS: 2 },                       // OTM
  { soS:  2, wS: 1 }, { soS:  2, wS: 2 }, { soS:  3, wS: 2 },
];
const SPREADS: SpreadSpec[] = SPREAD_DEFS.map(({ soS, wS }) => {
  const so = soS * SI, w = wS * SI;
  const moneyness = so < 0 ? `${Math.abs(so)}ITM` : so > 0 ? `${so}OTM` : 'ATM';
  return { label: `${moneyness} w${w}`, shortOffset: so, width: w };
});

// ── Exit policies (TP/SL as fraction of credit). TP=0 means hold to settle. ──
// slRiskFrac (0-1): SL fires when V reaches credit + slRiskFrac × (width − credit).
// Properly bounded for credit structures (V capped at width). Use INSTEAD of slMult.
interface ExitSpec { label: string; tpFrac: number; slMult: number; slRiskFrac?: number; useFlip: boolean; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle',  tpFrac: 0,    slMult: 0,   useFlip: false },
  { label: 'TP5 only',        tpFrac: 0.05, slMult: 0,   useFlip: false },
  { label: 'TP6 only',        tpFrac: 0.06, slMult: 0,   useFlip: false },
  { label: 'TP7 only',        tpFrac: 0.07, slMult: 0,   useFlip: false },
  { label: 'TP8 only',        tpFrac: 0.08, slMult: 0,   useFlip: false },
  { label: 'TP10 only',       tpFrac: 0.10, slMult: 0,   useFlip: false },
  { label: 'TP15 only',       tpFrac: 0.15, slMult: 0,   useFlip: false },
  { label: 'TP20 only',       tpFrac: 0.20, slMult: 0,   useFlip: false },
  { label: 'TP25 only',       tpFrac: 0.25, slMult: 0,   useFlip: false },
  { label: 'TP35 only',       tpFrac: 0.35, slMult: 0,   useFlip: false },
  { label: 'TP50 only',       tpFrac: 0.50, slMult: 0,   useFlip: false },
  { label: 'TP75 only',       tpFrac: 0.75, slMult: 0,   useFlip: false },
  // Risk-based SL variants for TP5/10/15
  { label: 'TP5 SL50%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP5 SL60%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP5 SL70%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP5 SL80%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  { label: 'TP10 SL50%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP10 SL60%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP10 SL70%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP10 SL80%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  { label: 'TP15 SL50%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP15 SL60%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP15 SL70%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP15 SL80%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  // Flip-exit variants: close on signal reversal (first opposite alignment after entry)
  { label: 'TP10 +flip',      tpFrac: 0.10, slMult: 0,   useFlip: true  },
  { label: 'TP15 +flip',      tpFrac: 0.15, slMult: 0,   useFlip: true  },
  { label: 'TP25 +flip',      tpFrac: 0.25, slMult: 0,   useFlip: true  },
  { label: 'TP50 +flip',      tpFrac: 0.50, slMult: 0,   useFlip: true  },
  { label: 'flip only',       tpFrac: 0,    slMult: 0,   useFlip: true  },
];

// Effectively-uncapped budget so the sweep records every signal. Per-variant
// peakConcurrent + avgMaxRisk are output so the dashboard can budget-scale
// without re-running. To run a true-capped sweep, lower this to the tier.
const MAX_OPEN_RISK = 100_000;

// ── Date list ──────────────────────────────────────────────────────────────
// (dates resolved via sweep-symbol.ts listDatesFor — profile-id aware)
function prevDate(d:string){const dt=new Date(d+'T12:00:00Z');dt.setUTCDate(dt.getUTCDate()-1);if(dt.getUTCDay()===0)dt.setUTCDate(dt.getUTCDate()-2);if(dt.getUTCDay()===6)dt.setUTCDate(dt.getUTCDate()-1);return dt.toISOString().slice(0,10);}
function sessOpenTs(date:string):number{
  const[y,mo,d]=date.split('-').map(Number);
  const utcNoon=new Date(Date.UTC(y,mo-1,d,12,0,0));
  const etHour=parseInt(utcNoon.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));
  const offsetH=12-etHour;
  return Math.floor(Date.UTC(y,mo-1,d,9+offsetH,30,0)/1000);
}

// ── Signal engine ──────────────────────────────────────────────────────────
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

// Detect aligned-entry signals for one signal-spec on a day. Returns list of
// { ts:alignmentBarTs, dir, entryTs } where entryTs = ts+60 (next 1m open).
// Plus a per-bar dirLog so we can detect flip exits later.
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

// ── Contract helpers ───────────────────────────────────────────────────────
function findStrike(c1:any, type:'C'|'P', targetK:number): string|null {
  let best:string|null=null, bestD=Infinity;
  // OCC type char is always 9 chars from the end (8 strike digits + C/P),
  // so this works for SPXW(4), SPY/QQQ(3), NDXP(4) roots alike.
  for(const [s] of c1.contractBars){const sym=s as string;if(sym[sym.length-9]!==type)continue;const k=c1.contractStrikes.get(sym);const d=Math.abs(k-targetK);if(d<bestD){bestD=d;best=sym;}}
  return best;
}
function optPx(bars:any[],ts:number):number|null{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return bars[i].close;return null;}

// Build the spread-value trajectory from entryTs+1 to endTs as a list of {ts, V}.
// Linear walk through both bar arrays (O(N+M)), instead of per-timestamp re-scan.
interface TrajPoint { ts:number; V:number; shortFresh:boolean; }
// Each point flags whether the SHORT leg printed AT that exact minute (vs a
// carried-forward stale close), so applyExit can reject false-mid TP/SL fills
// on an un-tradeable short (see GATE_SHORTS).
function buildSpreadTrajectory(shortBars:any[], longBars:any[], entryTs:number, endTs:number): TrajPoint[] {
  const tsSet = new Set<number>();
  for(const b of shortBars) if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  for(const b of longBars)  if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a,b)=>a-b);
  const traj: TrajPoint[] = [];
  let si = 0, li = 0;
  let lastShort:number|null = null, lastLong:number|null = null;
  let lastShortTs = -1;
  for(const t of tsList){
    while(si < shortBars.length && shortBars[si].ts <= t){ lastShort = shortBars[si].close; lastShortTs = shortBars[si].ts; si++; }
    while(li < longBars.length  && longBars[li].ts  <= t){ lastLong  = longBars[li].close;  li++; }
    if(lastShort != null && lastLong != null) traj.push({ts: t, V: lastShort - lastLong, shortFresh: lastShortTs === t});
  }
  return traj;
}

// Find V at a given ts (latest V where ts ≤ target) — used for rotation eviction.
function currentV(traj: Array<{ts:number,V:number}>, targetTs: number): number | null {
  let v: number | null = null;
  for(const p of traj){
    if(p.ts > targetTs) break;
    v = p.V;
  }
  return v;
}

// Apply one exit policy to a precomputed trajectory.
// At true session settle (effEnd === endTs), V is computed as INTRINSIC from SPX close + strikes
// to avoid stale-leg-bar bias on deep ITM credit spreads (which can stop printing late in the day).
// At flip exits (effEnd < endTs), uses last available close on each leg.
function applyExit(traj:TrajPoint[], endTs:number,
                   shortBars:any[], longBars:any[],
                   credit:number, tpFrac:number, slMult:number, flipTs:number,
                   isCallSpread:boolean, shortStrike:number, longStrike:number,
                   spxAtSettle:number|null, width:number = 0, slRiskFrac:number = 0): {exitTs:number, exitV:number, reason:string} {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac>0 ? (1 - tpFrac) * credit : -Infinity;
  // Prefer slRiskFrac (fraction of max risk) when > 0; slMult is broken for
  // credit structures (V bounded by width). Kept for backward-compat.
  const slV = slRiskFrac > 0 && width > 0
    ? credit + slRiskFrac * (width - credit)
    : slMult > 0 ? (1 + slMult) * credit : Infinity;
  const slActive = slRiskFrac > 0 || slMult > 0;
  // Hard mode: limit must be crossed (mid penetrates by penalty) for TP, stop
  // must be cleared (mid clears stop by penalty) for SL. Fills at order level.
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  // Liquidity gate: honor a TP/SL only at a bar where the SHORT leg actually
  // printed (p.shortFresh). Rejects exits priced off a stale carried-forward
  // SHORT close (the "false mid"). GATE_SHORTS=false reproduces legacy behavior.
  for(const p of traj){
    if(p.ts > effEnd) break;
    const fillable = !GATE_SHORTS || p.shortFresh;
    if(tpFrac>0 && p.V <= tpTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? tpV : p.V + CLOSE_PENALTY_V;
      return {exitTs: p.ts, exitV: Math.max(0, exitV), reason:'TP'};
    }
    if(slActive && p.V >= slTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : p.V + CLOSE_PENALTY_V;
      return {exitTs: p.ts, exitV, reason:'SL'};
    }
  }
  // INTRINSIC settle only valid at true same-day expiry (0DTE @ 15:45,
  // extrinsic ≈ 0). For 1DTE+ the contract still has ≥1 session of life at the
  // 15:45 day-D forced exit → use the real option-bar mark instead (below),
  // else short-premium P&L is grossly inflated.
  if(effEnd === endTs && spxAtSettle != null && TARGET.dte === 0){
    // Intrinsic settle. For call spread: V = max(0, spx-K_short) - max(0, spx-K_long).
    // For put spread:  V = max(0, K_short-spx) - max(0, K_long-spx).
    let v: number;
    if(isCallSpread){
      v = Math.max(0, spxAtSettle - shortStrike) - Math.max(0, spxAtSettle - longStrike);
    } else {
      v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
    }
    return {exitTs: effEnd, exitV: Math.max(0, v), reason: 'expiry'};
  }
  // Real mark-to-market at exit ts (last printed leg closes). Covers flip
  // exits (effEnd<endTs) AND 1DTE+ settle (effEnd==endTs, dte≥1).
  const ps = optPx(shortBars, effEnd) ?? 0;
  const pl = optPx(longBars,  effEnd) ?? 0;
  // Flip + 1DTE+ settle-MTM both require crossing the spread on both legs —
  // apply pay-through-ask penalty. Cash-settled 0DTE expiry above is unpenalized.
  return {exitTs: effEnd, exitV: Math.max(0, (ps - pl) + CLOSE_PENALTY_V), reason: effEnd === endTs ? 'settle-mtm' : 'flip'};
}

// ── Aggregation ────────────────────────────────────────────────────────────
interface AggKey { signal:string; spread:string; exit:string; }
interface HourBucket { n:number; creditSum:number; riskSum:number; pnlSum:number; wins:number; }
interface Stat {
  pnl:number; n:number; wins:number; daily:Map<string,number>; creditSum:number; widthSum:number;
  peakConcurrent:number; evictions:number;
  durationSumSec:number;
  perHour: Map<number, HourBucket>;        // ET hour (9..15) → bucket
}
const results = new Map<string, Stat>();
function recK(s:string,sp:string,ex:string){return `${s}|${sp}|${ex}`;}

// Fast ET hour from unix ts (no Date/toLocaleString in the hot loop). Mirror
// of iron-sweep's helper: 09:30 ET = minute 570 of the day, so
// etHour = floor((570 + (ts−sessOpen)/60) / 60).
let _sessOpenForEtHour = 0;
function setEtHourSessOpen(sessOpenTs: number){ _sessOpenForEtHour = sessOpenTs; }
function etHour(ts: number): number {
  const minSinceOpen = (ts - _sessOpenForEtHour) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}

function rec(s:string,sp:string,ex:string, pnl:number, date:string, credit:number, width:number, durationSec:number = 0, entryTs:number = 0, maxRisk:number = 0){
  const k=recK(s,sp,ex);
  let v=results.get(k); if(!v){v={pnl:0,n:0,wins:0,daily:new Map(),creditSum:0,widthSum:0,peakConcurrent:0,evictions:0,durationSumSec:0,perHour:new Map()}; results.set(k,v);}
  v.pnl+=pnl; v.n++; if(pnl>0)v.wins++; v.daily.set(date,(v.daily.get(date)??0)+pnl);
  v.creditSum+=credit; v.widthSum+=width;
  v.durationSumSec += durationSec;
  // Per-hour bucket (clamped to 9..15 — anything outside is noise/wrong-day).
  // entryTs=0 is a back-compat default (no-op) for any caller that doesn't pass it.
  if (entryTs > 0) {
    const h = Math.max(9, Math.min(15, etHour(entryTs)));
    let hb = v.perHour.get(h); if(!hb){hb={n:0,creditSum:0,riskSum:0,pnlSum:0,wins:0}; v.perHour.set(h,hb);}
    hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl;
    if (pnl > 0) hb.wins++;
  }
}

// ── Per-trade emission (additive, env-gated) ───────────────────────────────
// Enable by setting SWEEP_EMIT_TRADES_KEYS to a newline-separated list of
// "signal|spread|exit" keys (passed via env). Trades for ONLY those variants
// are emitted; everything else is a no-op (zero overhead). Output files:
//   $SWEEP_EMIT_TRADES_DIR/{slug}/{date}.json
// where slug = signal|spread|exit with spaces/pipes → underscores.
// Each file holds one CreditSpreadDay record (header + trades[] + spxBars +
// contractBars-for-legs). UI loads exactly one per inspection.
interface TradeRecord {
  entryTs:number; exitTs:number; durationSec:number;
  dir:'bull'|'bear'; side:'put-credit'|'call-credit';
  spxAtEntry:number; spxAtExit:number;
  shortSymbol:string; shortStrike:number; shortEntryMark:number; shortExitMark:number;
  longSymbol:string;  longStrike:number;  longEntryMark:number;  longExitMark:number;
  netCredit:number; netExitDebit:number; width:number; maxRisk:number;
  tpFrac:number; slMult:number;
  pnlGross:number; pnlNet:number;
  exitReason:string;
}
interface DayEmit {
  date:string; signal:string; spread:string; exit:string;
  spxOpen:number; spxClose:number; spxSettle:number|null;
  trades: TradeRecord[];
  spxBars: any[];                        // 1m OHLCV [ts,o,h,l,c,v]
  contractBars: Record<string, any[]>;   // symbol → 1m bars (deduped: legs from all trades)
}
const EMIT_KEYS = (() => {
  const raw = process.env.SWEEP_EMIT_TRADES_KEYS;
  if (!raw) return null;
  return new Set(raw.split(/[\n,]/).map(s=>s.trim()).filter(Boolean));
})();
const EMIT_DIR = process.env.SWEEP_EMIT_TRADES_DIR
  || path.join(process.cwd(), 'scripts/autoresearch/output/spread-trades');
const EMIT_BUFFER = new Map<string, Map<string, DayEmit>>();   // key → date → DayEmit
function slugify(k:string){ return k.replace(/[|]/g,'__').replace(/\s+/g,'_'); }
function emitTrade(k:string, date:string, hdr:{spxOpen:number; spxClose:number; spxSettle:number|null}, tr:TradeRecord, spxBars:any[], shortSym:string, shortBars:any[], longSym:string, longBars:any[]){
  if (!EMIT_KEYS || !EMIT_KEYS.has(k)) return;
  let byDate = EMIT_BUFFER.get(k); if(!byDate){byDate=new Map(); EMIT_BUFFER.set(k,byDate);}
  let d = byDate.get(date);
  if(!d){
    const [signal,spread,exit] = k.split('|');
    d = { date, signal, spread, exit,
          spxOpen: hdr.spxOpen, spxClose: hdr.spxClose, spxSettle: hdr.spxSettle,
          trades: [], spxBars, contractBars: {} };
    byDate.set(date,d);
  }
  d.trades.push(tr);
  if (!d.contractBars[shortSym]) d.contractBars[shortSym] = shortBars;
  if (!d.contractBars[longSym])  d.contractBars[longSym]  = longBars;
}
// Serialize a Bar[] (object-shape with full indicators) as compact tuples
// [ts, o, h, l, c, v] — what the lightweight-charts UI actually needs. Drops
// the indicators blob which adds ~10× size.
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
  console.error(`[trades] emitted ${nTrades} trades across ${nFiles} files under ${EMIT_DIR}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
const ALL_DATES = listDatesFor(TARGET);
// Parallel-shard hook: SWEEP_MERGE skips the loop (results come from shard
// dumps); SWEEP_SHARD="i/n" runs only this worker's date subset. No env =
// serial, identical behaviour. Each shard keeps every date's FULL bar
// history, so this cannot introduce look-ahead.
const SWEEP_DATES = process.env.SWEEP_MERGE ? [] : shardDates(ALL_DATES);
// ── Incremental hook: SWEEP_STATE=<file> persists the per-variant
// accumulator. On a nightly run we load it, then replay ONLY dates not
// already in the accumulator's per-date `daily` maps (idempotent — a re-run
// or --force re-backfill of an already-counted day is skipped). After the
// normal finalize (which still writes the FULL-history dashboard JSON from
// the merged accumulator) we persist the updated state. Additive/env-gated;
// no SWEEP_STATE, or with SWEEP_SHARD/SWEEP_MERGE, = unchanged behaviour.
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
console.error(`[${TARGET.symbol}] Dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD} → ${SWEEP_DATES.length})` : ''}`);

for(let di=0; di<RUN_DATES.length; di++){
  const date = RUN_DATES[di];
  if(di%20===0) console.error(`  ${di}/${RUN_DATES.length}  ${date}`);
  let c1:any, p1:any;
  try { c1 = loadDay(TARGET,date,'1m') as any; p1 = loadDay(TARGET,prevDate(date),'1m') as any; }
  catch { continue; }
  if(!c1?.spxBars?.length) continue;
  const s1:any[]=c1.spxBars;
  const sess = sessOpenTs(date);
  setEtHourSessOpen(sess);   // arm fast etHour() for the per-hour bucket below
  const cutoff = sess + CUTOFF_HHMM;
  const settle = sess + SETTLE_HHMM;
  // SPX close at settle ts — for intrinsic-value settle in applyExit
  const spxAtSettle = optPx(s1, settle);

  // Per-variant overlap event tracking (entry/exit timestamps) for peak-concurrent calc
  const overlapMap = new Map<string, Array<{entry:number, exit:number}>>();

  for(const sig of SIGNALS){
    const {entries,dirLog} = detectSignals(date, sig, c1, p1);
    entries.sort((a,b) => a.entryTs - b.entryTs);

    for(const ev of entries){
      if(ev.entryTs >= cutoff) continue;
      const spxEntry = optPx(s1, ev.entryTs - 1);
      if(spxEntry==null) continue;

      for(const sp of SPREADS){
        const isCallSpread = ev.dir === 'bear';
        const shortLetter:'C'|'P' = isCallSpread ? 'C' : 'P';
        const shortK_target = isCallSpread ? spxEntry + sp.shortOffset : spxEntry - sp.shortOffset;
        const longK_target  = isCallSpread ? shortK_target + sp.width  : shortK_target - sp.width;
        const shortSym = findStrike(c1, shortLetter, shortK_target);
        const longSym  = findStrike(c1, shortLetter, longK_target);
        if(!shortSym||!longSym||shortSym===longSym) continue;
        const shortStrike = c1.contractStrikes.get(shortSym) as number;
        const longStrike  = c1.contractStrikes.get(longSym)  as number;
        const shortBars = c1.contractBars.get(shortSym) as any[];
        const longBars  = c1.contractBars.get(longSym)  as any[];
        const shortEntry = optPx(shortBars, ev.entryTs-1);
        const longEntry  = optPx(longBars,  ev.entryTs-1);
        if(shortEntry==null||longEntry==null) continue;
        const credit = shortEntry - longEntry;
        if(credit <= 0.05) continue;
        if(credit > sp.width * 0.95) continue;

        let flipTs = Infinity;
        for(const [t, dirs] of dirLog){
          if(t <= ev.entryTs) continue;
          if(!dirs) continue;
          const flip = ev.dir==='bull' ? dirs.every((d:any)=>d==='bear') : dirs.every((d:any)=>d==='bull');
          if(flip){flipTs = t+60; break;}
        }

        const traj = buildSpreadTrajectory(shortBars, longBars, ev.entryTs, settle);

        for(const ex of EXITS){
          // Compute natural exit, record P&L immediately, push overlap event.
          const flipTsToUse = ex.useFlip ? flipTs : Infinity;
          const nat = applyExit(traj, settle, shortBars, longBars, credit, ex.tpFrac, ex.slMult, flipTsToUse,
                                isCallSpread, shortStrike, longStrike, spxAtSettle, sp.width, ex.slRiskFrac ?? 0);
          const pnl = (credit - nat.exitV) * 100 - SLIPPAGE_PER_SPREAD;
          const pnlGross = (credit - nat.exitV) * 100;
          const durationSec = Math.max(0, nat.exitTs - ev.entryTs);
          const maxRisk = (sp.width - credit) * 100;   // per contract — defined-risk credit spread
          rec(sig.label, sp.label, ex.label, pnl, date, credit, sp.width, durationSec, ev.entryTs, maxRisk);

          const k = `${sig.label}|${sp.label}|${ex.label}`;
          let evs = overlapMap.get(k); if(!evs){evs=[]; overlapMap.set(k, evs);}
          evs.push({entry: ev.entryTs, exit: nat.exitTs});

          // Per-trade emission (no-op unless this variant key is in EMIT_KEYS).
          if (EMIT_KEYS && EMIT_KEYS.has(k)) {
            const spxAtExit = optPx(s1, nat.exitTs) ?? spxEntry;
            // Reconstruct per-leg exit marks. For intrinsic-settle (0DTE expiry),
            // derive marks from SPX vs strikes; otherwise use leg-bar close.
            let shortExitMark:number, longExitMark:number;
            if (nat.reason === 'expiry' && spxAtSettle != null) {
              if (isCallSpread) {
                shortExitMark = Math.max(0, spxAtSettle - shortStrike);
                longExitMark  = Math.max(0, spxAtSettle - longStrike);
              } else {
                shortExitMark = Math.max(0, shortStrike - spxAtSettle);
                longExitMark  = Math.max(0, longStrike  - spxAtSettle);
              }
            } else {
              shortExitMark = optPx(shortBars, nat.exitTs) ?? 0;
              longExitMark  = optPx(longBars,  nat.exitTs) ?? 0;
            }
            const tr: TradeRecord = {
              entryTs: ev.entryTs, exitTs: nat.exitTs, durationSec,
              dir: ev.dir, side: isCallSpread ? 'call-credit' : 'put-credit',
              spxAtEntry: spxEntry, spxAtExit,
              shortSymbol: shortSym, shortStrike, shortEntryMark: shortEntry, shortExitMark,
              longSymbol:  longSym,  longStrike,  longEntryMark: longEntry,  longExitMark,
              netCredit: credit, netExitDebit: nat.exitV, width: sp.width, maxRisk,
              tpFrac: ex.tpFrac, slMult: ex.slMult,
              pnlGross, pnlNet: pnl,
              exitReason: nat.reason,
            };
            const spxOpen = s1[0]?.close ?? spxEntry;
            const spxClose = s1[s1.length-1]?.close ?? spxEntry;
            emitTrade(k, date,
              { spxOpen, spxClose, spxSettle: spxAtSettle },
              tr, s1, shortSym, shortBars, longSym, longBars);
          }
        }
      }
    }
  }

  // End of day: compute per-variant peak concurrent open via sweep-line on entry/exit events.
  for(const [k, evs] of overlapMap){
    if(evs.length === 0) continue;
    const stat = results.get(k); if(!stat) continue;
    const events: Array<{ts:number, delta:number}> = [];
    for(const e of evs){ events.push({ts:e.entry, delta:+1}); events.push({ts:e.exit, delta:-1}); }
    events.sort((a,b) => a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts);
    let cur = 0, peak = 0;
    for(const e of events){ cur += e.delta; if(cur > peak) peak = cur; }
    if(peak > stat.peakConcurrent) stat.peakConcurrent = peak;
  }
  overlapMap.clear();
}

// ── Report ─────────────────────────────────────────────────────────────────
function summary(){
  const rows:any[] = [];
  for(const [k,v] of results){
    const [signal,spread,exit] = k.split('|');
    const dailyArr = [...v.daily.values()];
    let cum=0,peak=0,mdd=0; for(const dp of dailyArr){cum+=dp; peak=Math.max(peak,cum); mdd=Math.max(mdd,peak-cum);}
    const pos = dailyArr.filter(x=>x>0.1).length;
    const wr = 100*v.wins/Math.max(1,v.n);
    const ratio = mdd>0 ? v.pnl/mdd : 0;
    const avgCredit = v.creditSum / Math.max(1,v.n);
    const avgWidth  = v.widthSum  / Math.max(1,v.n);
    const avgMaxRisk = (avgWidth - avgCredit) * 100; // dollars at risk per spread (1 contract)
    const avgDurMin = v.n > 0 ? (v.durationSumSec / v.n / 60) : 0;
    // avgConcurrent: time-weighted average open positions during the entry
    // window (10:00 → 15:45 ET = 20700s). When trades are short-held, this
    // is a more realistic ongoing capital-at-work estimate than peak.
    const SESSION_SEC = 20700;
    const numActiveDays = v.daily.size;
    const avgConcurrent = (numActiveDays > 0)
      ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2)
      : 0;
    const avgRiskCapacity = +(avgConcurrent * avgMaxRisk).toFixed(0);
    rows.push({signal,spread,exit,pnl:v.pnl,n:v.n,wr,dd:mdd,ratio,pos,
      avgCredit:+avgCredit.toFixed(3),avgMaxRisk:+avgMaxRisk.toFixed(0),
      avgPnlPerTrade:+(v.pnl/Math.max(1,v.n)).toFixed(2),
      peakConcurrent:v.peakConcurrent, evictions:v.evictions,
      peakRiskCapacity:+(v.peakConcurrent * avgMaxRisk).toFixed(0),
      avgConcurrent, avgRiskCapacity, numActiveDays,
      avgDurMin:+avgDurMin.toFixed(1),
      // Fill-model provenance — see iron-sweep.ts for context.
      fillModel: FILL_MODE,
      fillHalfSpread: CLOSE_HALFSPREAD_PER_LEG});
  }
  rows.sort((a,b)=>b.pnl-a.pnl);
  console.log(`\n=== CREDIT-SPREAD SWEEP (look-ahead protected, $${SLIPPAGE_PER_SPREAD}/RT slippage) ===`);
  console.log(`Variants: ${rows.length}.  Positive net: ${rows.filter(r=>r.pnl>0).length}.\n`);
  console.log(`${'Signal'.padEnd(16)} ${'Spread'.padEnd(11)} ${'Exit'.padEnd(18)} ${'$Net'.padStart(11)} ${'N'.padStart(5)} ${'WR%'.padStart(5)} ${'$DD'.padStart(9)} ${'Ratio'.padStart(6)} ${'+days'.padStart(5)}`);
  console.log('-'.repeat(96));
  // Print top 30
  for(const r of rows.slice(0,30)){
    console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(11)} ${r.exit.padEnd(18)} $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  console.log('\n--- Bottom 10 ---');
  for(const r of rows.slice(-10)){
    console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(11)} ${r.exit.padEnd(18)} $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  // MERGE with existing file so we don't wipe iron rows added by iron-sweep.
  // Strategy: keep all rows EXCEPT prior 2-leg credit-spread rows (matching this script's spread labels).
  const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
  let existing:any[] = [];
  try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON,'utf8')); } catch {}
  // Identify 2-leg credit-spread spread labels we generate (e.g. "ATM w5", "15ITM w10")
  const isCreditSpread = (s:string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);
  existing = existing.filter((r:any) => !isCreditSpread(r.spread));
  const merged = existing.concat(rows);
  fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged,null,2));
  // Also write to viewer's expected location so dashboard sees fresh data
  // immediately without a manual copy step.
  const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
  try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}
  console.log(`\nMerged: ${existing.length} prior (iron) + ${rows.length} new (credit-spread) = ${merged.length}`);
  // Daily-series emission: shared `dates` array + per-variant pnl-by-date arrays.
  const allDates = new Set<string>();
  for(const v of results.values()) for(const d of v.daily.keys()) allDates.add(d);
  const dates = [...allDates].sort();
  const di = new Map<string,number>(); dates.forEach((d,i)=>di.set(d,i));
  const series: Record<string, number[]> = {};
  for(const [k,v] of results){
    const arr = new Array(dates.length).fill(0);
    for(const [d,p] of v.daily) arr[di.get(d)!] = +p.toFixed(2);
    series[k] = arr;
  }
  // Merge daily-series with existing file so iron series stay
  const DAILY_JSON = outPath('/tmp/credit_spread_daily.json', TARGET);
  let existingDaily:any = {dates:[], series:{}};
  try { existingDaily = JSON.parse(fs.readFileSync(DAILY_JSON,'utf8')); } catch {}
  // Drop prior 2-leg credit-spread keys (matched by spread label pattern in key)
  const isCsKey = (k:string) => {
    const parts = k.split('|');
    return parts.length>=2 && /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(parts[1]);
  };
  for(const k of Object.keys(existingDaily.series||{})) if(isCsKey(k)) delete existingDaily.series[k];
  // Build unified date list
  const allDatesSet = new Set<string>(existingDaily.dates || []);
  for(const d of dates) allDatesSet.add(d);
  const mergedDates = [...allDatesSet].sort();
  const mDi = new Map<string,number>(); mergedDates.forEach((d,i)=>mDi.set(d,i));
  const mergedSeries: Record<string, number[]> = {};
  // Re-index existing (iron) series onto merged dates
  for(const k of Object.keys(existingDaily.series||{})){
    const oldArr: number[] = existingDaily.series[k];
    const oldDates: string[] = existingDaily.dates || [];
    const newArr = new Array(mergedDates.length).fill(0);
    for(let i=0;i<oldDates.length;i++){
      const idx = mDi.get(oldDates[i]);
      if(idx!=null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  // Add new credit-spread series
  for(const k of Object.keys(series)){
    const oldArr = series[k];
    const newArr = new Array(mergedDates.length).fill(0);
    for(let i=0;i<dates.length;i++){
      const idx = mDi.get(dates[i]);
      if(idx!=null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  fs.writeFileSync(DAILY_JSON, JSON.stringify({dates: mergedDates, series: mergedSeries}));
  const STUDIO_DAILY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'), TARGET);
  try { fs.writeFileSync(STUDIO_DAILY, JSON.stringify({dates: mergedDates, series: mergedSeries})); } catch {}
  console.log(`Daily merged: ${mergedDates.length} dates × ${Object.keys(mergedSeries).length} variants`);
  console.log('Saved to /tmp/credit_spread_*.json + scripts/autoresearch/output/spread-*.json');

  // ── Per-hour aggregates — mirror iron-sweep, MERGE with existing iron rows.
  // Studio's Hourly Heatmap reads scripts/autoresearch/output/spread-hourly*.json;
  // iron writes its entries (with `structure`) — we APPEND credit-spread entries
  // (with `spread`) and drop any prior credit entries on re-run.
  const HOURLY_JSON   = outPath('/tmp/credit_spread_hourly.json', TARGET);
  const STUDIO_HOURLY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'), TARGET);
  const creditHourlyEntries: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    if (v.perHour.size === 0) continue;
    const byHour: Record<number, any> = {};
    for (const [h, hb] of v.perHour) {
      if (hb.n === 0) continue;
      byHour[h] = {
        n: hb.n,
        avgCredit:  +(hb.creditSum / hb.n).toFixed(3),
        avgMaxRisk: +(hb.riskSum   / hb.n).toFixed(0),
        avgPnl:     +(hb.pnlSum    / hb.n).toFixed(2),
        totalPnl:   +hb.pnlSum.toFixed(0),
        wr:         +(100 * hb.wins / hb.n).toFixed(1),
      };
    }
    creditHourlyEntries.push({ signal, spread, exit, hours: byHour });
  }
  const isCsHourly = (s: string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);
  let mergedHourly: any[] = [];
  try {
    const existingRaw = JSON.parse(fs.readFileSync(STUDIO_HOURLY, 'utf8'));
    if (Array.isArray(existingRaw)) {
      mergedHourly = existingRaw.filter((e: any) => !isCsHourly(e?.spread || e?.structure || ''));
    } else if (existingRaw && typeof existingRaw === 'object') {
      mergedHourly = Object.values(existingRaw).filter((e: any) => !isCsHourly(e?.spread || e?.structure || ''));
    }
  } catch { /* missing/parse-fail → start fresh from iron's entries via this run if any */ }
  mergedHourly = mergedHourly.concat(creditHourlyEntries);
  fs.writeFileSync(HOURLY_JSON, JSON.stringify(mergedHourly));
  try { fs.writeFileSync(STUDIO_HOURLY, JSON.stringify(mergedHourly)); } catch {}
  console.log(`Hourly merged: ${mergedHourly.length} variants (${creditHourlyEntries.length} credit-spread + ${mergedHourly.length - creditHourlyEntries.length} prior)`);
}

// Per-trade emission (no-op unless SWEEP_EMIT_TRADES_KEYS env is set).
// Each shard flushes its own date subset; the merge step is a no-op because
// shards don't share the EMIT_BUFFER. Outside the summary() gate so it fires
// in both shard-worker and serial runs.
flushTrades();

if (process.env.SWEEP_SHARD_OUT) {
  // Worker: dump this shard's partial accumulator; do NOT run the
  // dashboard-merge finalize (the merge run owns the final JSON).
  dumpResults(results, process.env.SWEEP_SHARD_OUT);
} else {
  if (process.env.SWEEP_MERGE) loadShardsInto(process.env.SWEEP_MERGE, results);
  summary();
  // Incremental: persist the merged (prior + new dates) accumulator so the
  // next nightly run only replays the following day.
  if (STATE_FILE) { dumpResults(results, STATE_FILE); console.error(`[incremental] state saved → ${STATE_FILE}`); }
}

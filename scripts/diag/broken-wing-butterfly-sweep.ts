/**
 * broken-wing-butterfly-sweep.ts
 *
 * Sweeps 4-leg asymmetric broken-wing butterfly credit structures.
 *
 * Standard iron butterfly: short put @ SPX, short call @ SPX, equal wings
 *   - Symmetric profit zone around SPX. Tight sweet spot.
 *
 * Broken-wing butterfly: short strikes at SPX (ATM) but ASYMMETRIC wings
 *   (e.g., 5-pt wing on put side, 10-pt wing on call side)
 *   - Directional bias: tighter wing on expected direction, wider wing
 *     as protection. Reduce max risk, lower credit. Asymmetry trades cost
 *     for reduced tail risk in a biased direction.
 *   - Spreads the profit zone: if the wider wing is the protection (call side),
 *     the structure profits over a wider upside range but less on downside.
 *
 * Math:
 *   short put @ SPX, long put @ (SPX − putWingWidth)
 *   short call @ SPX, long call @ (SPX + callWingWidth)
 *
 *   Entry credit = C(SPX) − C(SPX+cw) + P(SPX) − P(SPX−pw)
 *   Max loss = min(cw, pw) × 100 − credit × 100 (narrower wing caps risk)
 *
 * Exit logic: same as iron-sweep. V trajectory, TP/SL/flip/settle via same
 * applyExit() function (shared library). Output appends to spread-sweep.json
 * (existing iron variants kept), with structure labels like "BWB 5w10" (5-pt
 * put wing, 10-pt call wing).
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { readBarCacheFile } from '../../src/replay/bar-cache-file';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath, instrumentClass } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile, knownDates } from './sweep-shard';
import { CAP_POLICIES, capDayNet, capSummary, type CapEvent } from './side-cap';
import * as fs from 'fs';
import * as path from 'path';

// ── Serial-execution guard ──────────────────────────────────────────────────
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: broken-wing-butterfly-sweep.ts must NOT be invoked directly.
Use the parallel runner instead:

  npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --shards 8

Pass-through env vars (SWEEP_FILL_MODE, SWEEP_CLOSE_HALFSPREAD, etc.) inherit
through to all workers automatically.

Override only for single-date debugging: SWEEP_ALLOW_SERIAL=1
`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

const SLIPPAGE_PER_STRUCTURE = 25;
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? 0.10);
const CLOSE_PENALTY_V = 4 * CLOSE_HALFSPREAD_PER_LEG;
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? 'shorts-fresh') as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;
const TREND_GATE_MIN = process.env.SWEEP_TREND_GATE_MIN ? parseInt(process.env.SWEEP_TREND_GATE_MIN) : 0;
const TREND_GATE_THRESH = parseFloat(process.env.SWEEP_TREND_GATE_THRESH ?? '5');

function trendGateBlocks(s1: any[], entryTs: number, dir: 'bull' | 'bear'): boolean {
  if (TREND_GATE_MIN <= 0) return false;
  const spxNow = optPx(s1, entryTs - 1);
  const spxPast = optPx(s1, entryTs - 1 - TREND_GATE_MIN * 60);
  if (spxNow == null || spxPast == null) return false;
  const drift = spxNow - spxPast;
  if (dir === 'bear' && drift > TREND_GATE_THRESH) return true;
  if (dir === 'bull' && drift < -TREND_GATE_THRESH) return true;
  return false;
}

const MIN_ALIGN = 3, CROSS_WIN = 60;
const FAST0 = 3, SLOW0 = 15;
const CUTOFF_HHMM = 6 * 3600;
const SETTLE_HHMM = 6 * 3600 + 15 * 60;
const TRADESTART_SEC = 1800;

type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: {tf:number;fast:number;slow:number}[]; }
const SIGNALS: SignalSpec[] = [
  { label: 'HMA  2+3+5 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'HMA  2+3+5 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'HMA  2+3+5 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  { label: 'DEMA 2+3+5 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
  { label: 'DEMA 2+3+5 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
  { label: 'DEMA 2+3+5 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
  { label: 'HMA  2+3 3x9',  signal: 'hma',  tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'HMA  2+3 3x12', signal: 'hma',  tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'HMA  2+3 3x21', signal: 'hma',  tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
  { label: 'DEMA 2+3 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
  { label: 'DEMA 2+3 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
  { label: 'DEMA 2+3 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
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

// ── Broken-wing butterfly structures ────────────────────────────────────────
// putWingWidth:  distance from short put to long put
// callWingWidth: distance from short call to long call
// (asymmetry trades tighter protection for lower cost and directional bias)
interface BWBSpec {
  label: string;
  putWingWidth: number;   // strike count, × SI → dollars
  callWingWidth: number;  // strike count, × SI → dollars
  // Optional: directional bodyOffset to shift the center ±N for signal direction
  // (more complex; for now keep bodies ATM, just vary wings)
}
const ETF = instrumentClass(TARGET) === 'etf';
const WING_WIDTHS_S = ETF ? [1, 2, 3, 4, 5]       : [1, 2, 3, 4, 5, 6, 8, 10];
const STRUCTURES: BWBSpec[] = [
  // Symmetric (both wings equal): mimics standard butterfly, but labeled differently
  ...WING_WIDTHS_S.flatMap(w => {
    const pw = w * SI, cw = w * SI;
    return [{ label: `BWB ${pw}w${cw}`, putWingWidth: pw, callWingWidth: cw }];
  }),
  // Asymmetric (tighter put wing = bullish bias)
  ...WING_WIDTHS_S.flatMap(pw_s =>
    WING_WIDTHS_S.flatMap(cw_s => {
      if (pw_s >= cw_s) return [];  // only wider-call (bullish) variants
      const pw = pw_s * SI, cw = cw_s * SI;
      return [{ label: `BWB ${pw}w${cw}`, putWingWidth: pw, callWingWidth: cw }];
    })
  ),
  // Asymmetric (tighter call wing = bearish bias)
  ...WING_WIDTHS_S.flatMap(pw_s =>
    WING_WIDTHS_S.flatMap(cw_s => {
      if (cw_s >= pw_s) return [];  // only wider-put (bearish) variants
      const pw = pw_s * SI, cw = cw_s * SI;
      return [{ label: `BWB ${pw}w${cw}`, putWingWidth: pw, callWingWidth: cw }];
    })
  ),
];

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
  { label: 'TP10 +flip',      tpFrac: 0.10, slMult: 0,   useFlip: true  },
  { label: 'TP15 +flip',      tpFrac: 0.15, slMult: 0,   useFlip: true  },
  { label: 'TP25 +flip',      tpFrac: 0.25, slMult: 0,   useFlip: true  },
  { label: 'TP50 +flip',      tpFrac: 0.50, slMult: 0,   useFlip: true  },
  { label: 'TP25 SL3x',       tpFrac: 0.25, slMult: 3.0, useFlip: false },
  { label: 'TP50 SL3x',       tpFrac: 0.50, slMult: 3.0, useFlip: false },
  { label: 'TP50 SL4x',       tpFrac: 0.50, slMult: 4.0, useFlip: false },
  { label: 'flip only',       tpFrac: 0,    slMult: 0,   useFlip: true  },
];

const MAX_OPEN_RISK = 100_000;

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
  for(const [s] of c1.contractBars){const sym=s as string;if(sym[sym.length-9]!==type)continue;const k=c1.contractStrikes.get(sym);const d=Math.abs(k-targetK);if(d<bestD){bestD=d;best=sym;}}
  return best;
}
function optPx(bars:any[],ts:number):number|null{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return bars[i].close;return null;}
function markAge(bars:any[],ts:number):number{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return ts-bars[i].ts;return Infinity;}

interface Leg { bars:any[]; sign:number; strike:number; symbol:string; }
interface TrajPoint { ts:number; V:number; shortsFresh:boolean; }
function buildTrajectory(legs:Leg[], entryTs:number, endTs:number): TrajPoint[] {
  const tsSet = new Set<number>();
  for(const lg of legs) for(const b of lg.bars) if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a,b)=>a-b);
  const ptr = new Array(legs.length).fill(0);
  const last = new Array<number|null>(legs.length).fill(null);
  const lastTs = new Array<number>(legs.length).fill(-1);
  const traj: TrajPoint[] = [];
  for(const t of tsList){
    for(let i=0;i<legs.length;i++){
      while(ptr[i] < legs[i].bars.length && legs[i].bars[ptr[i]].ts <= t){
        last[i] = legs[i].bars[ptr[i]].close;
        lastTs[i] = legs[i].bars[ptr[i]].ts;
        ptr[i]++;
      }
    }
    if(last.every(v=>v!=null)){
      let V = 0;
      for(let i=0;i<legs.length;i++) V += legs[i].sign * (last[i] as number);
      let shortsFresh = false;
      for(let i=0;i<legs.length;i++) if(legs[i].sign === +1 && lastTs[i] === t){ shortsFresh = true; break; }
      traj.push({ts:t, V, shortsFresh});
    }
  }
  return traj;
}

function applyExit(traj:TrajPoint[], endTs:number, legs:Leg[],
                   credit:number, tpFrac:number, slMult:number, flipTs:number,
                   spxAtSettle:number|null, riskWing:number = 0, slRiskFrac:number = 0)
                  : {exitTs:number, exitV:number, reason:string} {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac>0 ? (1 - tpFrac) * credit : -Infinity;
  // SL level in points, identical to iron-sweep: V at which loss = slRiskFrac of
  // defined max risk. riskWing = narrower wing (points). Do NOT pass wing−credit.
  const slV = slRiskFrac > 0 && riskWing > 0
    ? credit + slRiskFrac * (riskWing - credit)
    : slMult > 0 ? (1 + slMult) * credit : Infinity;
  const slActive = slRiskFrac > 0 || slMult > 0;
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  for(const p of traj){
    if(p.ts > effEnd) break;
    const fillable = !GATE_SHORTS || p.shortsFresh;
    if(tpFrac>0 && p.V <= tpTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? tpV : p.V + CLOSE_PENALTY_V;
      return {exitTs:p.ts, exitV:Math.max(0,exitV), reason:'TP'};
    }
    if(slActive && p.V >= slTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : p.V + CLOSE_PENALTY_V;
      return {exitTs:p.ts, exitV, reason:'SL'};
    }
  }
  if(effEnd === endTs && spxAtSettle != null && TARGET.dte === 0){
    let V = 0;
    for(const lg of legs){
      const isPut = (lg.symbol[lg.symbol.length - 9] === 'P');
      const intrinsic = isPut ? Math.max(0, lg.strike - spxAtSettle)
                              : Math.max(0, spxAtSettle - lg.strike);
      V += lg.sign * intrinsic;
    }
    return {exitTs:effEnd, exitV: Math.max(0,V), reason: 'expiry'};
  } else {
    let V = 0; let ok = true;
    for(const lg of legs){
      const c = optPx(lg.bars, effEnd);
      if(c==null){ ok = false; break; }
      V += lg.sign * c;
    }
    const reason = effEnd === endTs ? 'settle-mtm' : 'flip';
    return {exitTs:effEnd, exitV: ok ? Math.max(0, V + CLOSE_PENALTY_V) : 0, reason};
  }
}

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
  durationSumSec: number;
  capNets: number[];
}
const results = new Map<string, Stat>();
function recK(sig:string,struct:string,ex:string){return `${sig}|${struct}|${ex}`;}

let _sessOpenForEtHour = 0;
function setEtHourSessOpen(sessOpenTs: number){ _sessOpenForEtHour = sessOpenTs; }
function etHour(ts: number): number {
  const minSinceOpen = (ts - _sessOpenForEtHour) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}

function rec(sig:string,struct:string,ex:string, pnl_gross:number, date:string, credit:number, width:number, entryTs:number, maxRisk:number, durationSec:number = 0){
  const k=recK(sig,struct,ex);
  let v=results.get(k); if(!v){v={pnl:0,pnl_gross:0,n:0,wins:0,daily:new Map(),creditSum:0,widthSum:0,perHour:new Map(),peakConcurrent:0,evictions:0,durationSumSec:0,capNets:new Array(CAP_POLICIES.length).fill(0)}; results.set(k,v);}
  const pnl_net = pnl_gross - SLIPPAGE_PER_STRUCTURE;
  v.pnl += pnl_net; v.pnl_gross += pnl_gross; v.n++; if(pnl_net>0)v.wins++; v.daily.set(date,(v.daily.get(date)??0)+pnl_net);
  v.creditSum += credit; v.widthSum += width;
  v.durationSumSec += durationSec;
  const h = Math.max(9, Math.min(15, etHour(entryTs)));
  let hb = v.perHour.get(h); if(!hb){hb={n:0,creditSum:0,riskSum:0,pnlSum:0,wins:0}; v.perHour.set(h,hb);}
  hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl_net;
  if(pnl_net > 0) hb.wins++;
}

// SWEEP_ONLY_DATES="2026-05-14,2026-05-13" → restrict to these dates (debug /
// cross-engine validation). Applied before sharding so a 1-day serial run is fast.
const ONLY = (process.env.SWEEP_ONLY_DATES || '').split(',').map(s => s.trim()).filter(Boolean);
const ALL_DATES_RAW = listDatesFor(TARGET);
const ALL_DATES = ONLY.length ? ALL_DATES_RAW.filter(d => ONLY.includes(d)) : ALL_DATES_RAW;
const SWEEP_DATES = process.env.SWEEP_MERGE ? [] : shardDates(ALL_DATES);
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
console.error(`[${TARGET.symbol}] BWB sweep — dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD})` : ''}, signals: ${SIGNALS.length}, structures: ${STRUCTURES.length}, exits: ${EXITS.length} | exitGate=${EXIT_GATE} entryStaleSec=${ENTRY_STALE_SEC || 'off'} fill=${FILL_MODE}`);

for(let di=0; di<RUN_DATES.length; di++){
  const date = RUN_DATES[di];
  if(di%20===0) console.error(`  ${di}/${RUN_DATES.length}  ${date}`);
  let c1:any, p1:any;
  try { c1 = loadDay(TARGET,date,'1m') as any; p1 = loadDay(TARGET,prevDate(date),'1m') as any; }
  catch { continue; }
  if(!c1?.spxBars?.length) continue;
  const s1:any[]=c1.spxBars;
  const sess = sessOpenTs(date), cutoff = sess + CUTOFF_HHMM, settle = sess + SETTLE_HHMM;
  setEtHourSessOpen(sess);
  const spxAtSettle = optPx(s1, settle);

  // Cap tracking requires side/pnl metadata; BWB omits it for simplicity.
  // This is optional for dashboard—results still aggregate correctly.
  const overlapMap = new Map<string, {entry:number; exit:number}[]>();

  for(const sig of SIGNALS){
    const {entries,dirLog} = detectSignals(date, sig, c1, p1);
    entries.sort((a,b) => a.entryTs - b.entryTs);

    for(const ev of entries){
      if(ev.entryTs >= cutoff) continue;

      const spxEntry = optPx(s1, ev.entryTs - 1);
      if(spxEntry==null) continue;

      if(trendGateBlocks(s1, ev.entryTs, ev.dir)) continue;

      let flipTs = Infinity;
      for(const [t, dirs] of Array.from(dirLog)){
        if(t <= ev.entryTs) continue;
        if(!dirs) continue;
        const flip = ev.dir==='bull' ? dirs.every((d:any)=>d==='bear') : dirs.every((d:any)=>d==='bull');
        if(flip){flipTs = t+60; break;}
      }

      for(const st of STRUCTURES){
        // Broken-wing butterfly: short @ SPX (ATM), asymmetric wings
        const Kshort_put  = spxEntry;
        const Klong_put   = Kshort_put - st.putWingWidth;
        const Kshort_call = spxEntry;
        const Klong_call  = Kshort_call + st.callWingWidth;
        const sym_sp = findStrike(c1, 'P', Kshort_put);
        const sym_lp = findStrike(c1, 'P', Klong_put);
        const sym_sc = findStrike(c1, 'C', Kshort_call);
        const sym_lc = findStrike(c1, 'C', Klong_call);
        if(!sym_sp || !sym_lp || !sym_sc || !sym_lc) continue;
        const syms = new Set([sym_sp, sym_lp, sym_sc, sym_lc]);
        if(syms.size !== 4) continue;

        const legs:Leg[] = [
          { symbol:sym_sp, strike:Kshort_put,  sign:+1, bars: c1.contractBars.get(sym_sp) as any[] },
          { symbol:sym_lp, strike:Klong_put,   sign:-1, bars: c1.contractBars.get(sym_lp) as any[] },
          { symbol:sym_sc, strike:Kshort_call, sign:+1, bars: c1.contractBars.get(sym_sc) as any[] },
          { symbol:sym_lc, strike:Klong_call,  sign:-1, bars: c1.contractBars.get(sym_lc) as any[] },
        ];
        const entries_px = legs.map(lg => optPx(lg.bars, ev.entryTs - 1));
        if(entries_px.some(p => p==null)) continue;


        // Entry stale-mark gate (optional)
        if (ENTRY_STALE_SEC > 0) {
          const shortLegs = [legs[0], legs[2]];  // short put, short call
          if (shortLegs.some(lg => markAge(lg.bars, ev.entryTs - 1) > ENTRY_STALE_SEC)) continue;
        }

        const credit = (entries_px[0] as number) - (entries_px[1] as number) + (entries_px[2] as number) - (entries_px[3] as number);
        // Entry-credit guards — IDENTICAL to iron-sweep. Reject degenerate credits:
        // ≤$0.10 (no edge) and ≥95% of the defined-risk wing (near-zero risk, almost
        // always a stale/bad mark). Without the upper guard, near-max-credit entries
        // with tiny risk skew the stats and break parity with IB wN. The guard uses
        // the NARROWER wing (the one that actually caps loss).
        const riskWingGuard = Math.min(st.putWingWidth, st.callWingWidth);
        if (credit <= 0.10) continue;
        if (credit >= riskWingGuard * 0.95) continue;

        // Defined-risk wing = the NARROWER wing (caps loss). This is the exact
        // analogue of iron-sweep's `wingWidth`: applyExit computes the SL level as
        // credit + slRiskFrac*(riskWing − credit), and dollar max risk = (riskWing
        // − credit)*100. MUST pass the raw wing width (points), NOT wing−credit,
        // or the SL threshold double-subtracts credit and biases win rate upward.
        const riskWing = Math.min(st.putWingWidth, st.callWingWidth);
        const maxRiskDollars = (riskWing - credit) * 100;
        if (maxRiskDollars <= 0) continue;

        const traj = buildTrajectory(legs, ev.entryTs, settle);
        if (!traj.length) continue;

        for(const ex of EXITS){
          // Flip cutoff applies ONLY to +flip / flip-only exit specs. Non-flip
          // exits (TP-only, TP+SL, hold-to-settle) must run to settle — passing
          // flipTs unconditionally truncated EVERY trade at the first signal flip,
          // so TP/SL never fired and all exits collapsed to the flip MTM (the bug
          // that made BWB diverge from iron: 0 wins vs iron's real win rates).
          const flipUse = ex.useFlip ? flipTs : Infinity;
          const {exitTs, exitV, reason} = applyExit(traj, settle, legs, credit, ex.tpFrac, ex.slMult, flipUse, spxAtSettle, riskWing, ex.slRiskFrac);
          const pnl_gross = (credit - exitV) * 100;
          const durationSec = Math.max(0, exitTs - ev.entryTs);
          rec(sig.label, st.label, ex.label, pnl_gross, date, credit, Math.max(st.putWingWidth, st.callWingWidth), ev.entryTs, maxRiskDollars, durationSec);

          // Track overlap for peakConcurrent analysis (basic: no side/pnl cap scoring)
          const k = recK(sig.label, st.label, ex.label);
          if (!overlapMap.has(k)) overlapMap.set(k, []);
          overlapMap.get(k)!.push({entry: ev.entryTs, exit: exitTs});
        }
      }
    }
  }

  // Update peak concurrent per variant (simple: count overlaps, no cap policy evaluation)
  for (const [k, events] of Array.from(overlapMap)) {
    const stat = results.get(k)!;
    // Simple peak: max concurrent open trades (no side-specific capping)
    let peak = 0;
    for (let t = sess; t <= settle; t += 60) {
      let open = 0;
      for (const ev of events) {
        if (ev.entry <= t && ev.exit > t) open++;
      }
      peak = Math.max(peak, open);
    }
    stat.peakConcurrent = Math.max(stat.peakConcurrent, peak);
  }
}

// Shard worker dump (SWEEP_SHARD_OUT phase): dump results dict to shard file
if (process.env.SWEEP_SHARD_OUT) {
  dumpResults(results, process.env.SWEEP_SHARD_OUT);
  console.error(`[bwb-sweep] shard dumped ${results.size} variants to ${process.env.SWEEP_SHARD_OUT}`);
}

// Merge finalize hook (SWEEP_MERGE phase): load shards, convert to array, append to spread-sweep.json
if (process.env.SWEEP_MERGE) {
  loadShardsInto(process.env.SWEEP_MERGE, results);

  // Finalize each accumulator → display row. MUST mirror iron-sweep's finalize
  // (lines ~808-848) so BWB rows carry the same derived fields (wr, ratio, pos,
  // avgCredit, avgMaxRisk, …). The dashboard calls .toFixed() on these, so a
  // raw accumulator dump (missing wr/ratio) crashes the React table.
  const SESSION_SEC = 20700;  // 10:00 → 15:45 ET
  const rows: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    const dailyArr = Array.from(v.daily.values()) as number[];
    let cum = 0, peak = 0, mdd = 0;
    for (const dp of dailyArr) { cum += dp; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
    const pos = dailyArr.filter(x => x > 0.1).length;
    const wr = 100 * v.wins / Math.max(1, v.n);
    const ratio = mdd > 0 ? v.pnl / mdd : 0;
    const avgCredit = v.creditSum / Math.max(1, v.n);
    const avgWidth = v.widthSum / Math.max(1, v.n);
    const avgMaxRisk = (avgWidth - avgCredit) * 100;
    const avgDurMin = v.n > 0 ? (v.durationSumSec / v.n / 60) : 0;
    const numActiveDays = v.daily.size;
    const avgConcurrent = (numActiveDays > 0)
      ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2)
      : 0;
    const avgRiskCapacity = +(avgConcurrent * avgMaxRisk).toFixed(0);
    const cap = capSummary(v.capNets, 'bull', 'bear');
    rows.push({
      signal, spread, exit,
      pnl: v.pnl, pnl_gross: v.pnl_gross, n: v.n, wr, dd: mdd, ratio, pos,
      ...cap,
      avgCredit: +avgCredit.toFixed(3), avgMaxRisk: +avgMaxRisk.toFixed(0),
      avgPnlPerTrade: +(v.pnl / Math.max(1, v.n)).toFixed(2),
      peakConcurrent: v.peakConcurrent, evictions: v.evictions,
      peakRiskCapacity: +(v.peakConcurrent * avgMaxRisk).toFixed(0),
      avgConcurrent, avgRiskCapacity, numActiveDays,
      avgDurMin: +avgDurMin.toFixed(1),
      fillModel: FILL_MODE,
      fillHalfSpread: CLOSE_HALFSPREAD_PER_LEG,
      exitGate: EXIT_GATE,
      entryStaleSec: ENTRY_STALE_SEC,
    });
  }

  // Append to spread-sweep JSON so the viewer picks up everything in one place.
  // Existing iron/credit rows stay; this adds new BWB rows.
  const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
  const DAILY_JSON = outPath('/tmp/credit_spread_daily.json', TARGET);
  let existing: any[] = [];
  try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON, 'utf8')); } catch {}

  // De-dup: remove any prior BWB rows so re-running this script is idempotent
  // Keep iron/credit/time-based rows intact
  const isBWB = (s: string) => s.startsWith('BWB');
  existing = existing.filter((r: any) => !isBWB(r.spread));

  // Merge: prepend existing rows, append new BWB rows
  const merged = existing.concat(rows);
  fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged));

  // Also write to the live viewer location so the dashboard picks it up
  // without a manual copy step. Kept the /tmp file too for legacy tooling.
  const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
  try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}

  console.error(`[bwb-sweep] merged: ${existing.length} prior + ${rows.length} new = ${merged.length} total rows`);
}

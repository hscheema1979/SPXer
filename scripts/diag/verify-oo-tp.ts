// Verify OptionOmega's 50% TP exits are REAL (spread actually reached half-credit),
// not phantom mid fills — cross-checked against the dense SPX path via BS repricing.
import * as dotenv from 'dotenv';
import { resolveSymbolTarget, loadDay } from './sweep-symbol';
import { sessOpenTs } from './flat-file-reader';
import { bsPutPrice, impliedVolFromPut } from './black-scholes';
import * as fs from 'fs';
dotenv.config();
const SPX0 = resolveSymbolTarget(['--symbol','SPX','--dte','0']) as any;
const RATE=0.04, BETA=1.0, ET_1PM=3*3600+1800, SETTLE=6*3600+15*60, MPY=252*390;
const MON:any={Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
const spxC=new Map<string,any[]>(); const sb=(d:string)=>{if(spxC.has(d))return spxC.get(d)!;let b:any[]=[];try{b=loadDay(SPX0,d,'1m')?.spxBars??[]}catch{}spxC.set(d,b);return b};
const px=(bars:any[],ts:number):number|null=>{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return bars[i].close;return null};
function parse(l:string){const o=[];let c="",q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o}
const txt=fs.readFileSync('.termchat-uploads/trade-log_3_.csv','utf8').replace(/^﻿/,'');
const L=txt.split(/\r?\n/).filter(x=>x.trim()); const H=parse(L[0]).map(s=>s.replace(/"/g,'')); const ix=(n:string)=>H.indexOf(n);
const rows=L.slice(1).map(parse).filter(r=>r.length>=H.length);
function tradingDates(a:string,b:string){const out=[];let d=new Date(a+'T00:00:00Z');const end=new Date(b+'T00:00:00Z');while(d<=end){const wd=d.getUTCDay();if(wd>=1&&wd<=5)out.push(d.toISOString().slice(0,10));d=new Date(d.getTime()+86400000)}return out}
let checked=0, confirmed=0, early=0, late=0, noData=0; const misses:string[]=[];
for(const r of rows){
  if(r[ix('Reason For Close')].replace(/"/g,'')!=='Profit Target')continue;
  const od=r[ix('Date Opened')]; if(od<'2025-03-27')continue;       // my data window
  const legs=r[ix('Legs')].replace(/"/g,''); const spot=+r[ix('Opening Price')]; const prem=+r[ix('Premium')];
  const sto=legs.split('|').find(p=>/STO/.test(p))!, bto=legs.split('|').find(p=>/BTO/.test(p))!;
  const mS=sto.match(/([A-Z][a-z]{2})\s+(\d+)\s+(\d+(?:\.\d+)?)\s+P\s+STO/), mB=bto.match(/(\d+(?:\.\d+)?)\s+P\s+BTO/);
  if(!mS||!mB)continue;
  const expMon=MON[mS[1]], expDay=+mS[2], Ks=+mS[3], Kl=+mB[1];
  let yr=+od.slice(0,4); if(expMon<+od.slice(5,7))yr++;
  const expDate=`${yr}-${String(expMon).padStart(2,'0')}-${String(expDay).padStart(2,'0')}`;
  const credit=prem/100; const tpTarget=0.5*credit;                  // 50% TP → spread value halves
  const entryTs=sessOpenTs(od)+ET_1PM, settleTs=sessOpenTs(expDate)+SETTLE;
  // SPX path entry->expiry
  const sd=tradingDates(od,expDate); const path:any[]=[];
  for(const d of sd)for(const b of sb(d))if(b.ts>entryTs&&b.ts<=settleTs)path.push(b);
  path.sort((a,b)=>a.ts-b.ts); if(path.length<10){noData++;continue}
  const spxEntry=px(sb(od),entryTs-1); if(spxEntry==null){noData++;continue}
  const T0=path.length/MPY;
  const ivS=impliedVolFromPut(/*short mark unknown→use credit-implied via ATM approx*/Math.max(credit,0.2)+ (spot-Ks>0?spot-Ks:0),spxEntry,Ks,T0,RATE)??0.12;
  // We don't have per-leg entry marks; approximate by solving IV so BS spread == credit at entry.
  // Bisection on a single IV applied to both legs.
  let lo=0.02,hi=2.0,iv=0.15;
  for(let k=0;k<40;k++){iv=(lo+hi)/2;const v=bsPutPrice(spxEntry,Ks,T0,iv,RATE)-bsPutPrice(spxEntry,Kl,T0,iv,RATE);if(v>credit)hi=iv;else lo=iv}
  // walk path, find first ts where BS spread value <= tpTarget
  let hitTs=0;
  for(let i=0;i<path.length;i++){const sp=path[i].close,T=Math.max((path.length-(i+1))/MPY,0),pc=(sp-spxEntry)/spxEntry;
    const V=Math.max(0,bsPutPrice(sp,Ks,T,Math.max(0.01,iv-BETA*pc),RATE)-bsPutPrice(sp,Kl,T,Math.max(0.01,iv-BETA*pc),RATE));
    if(V<=tpTarget){hitTs=path[i].ts;break}}
  checked++;
  if(hitTs===0){misses.push(`${od} ${Ks}/${Kl} cr=${credit.toFixed(2)} NEVER hit 50% (BS)`);continue}
  confirmed++;
  const hitDate=new Date(hitTs*1000).toISOString().slice(0,10); const ooClose=r[ix('Date Closed')];
  if(hitDate<ooClose)early++; else if(hitDate>ooClose)late++;
}
console.log(`PT trades checked (2025-03-27+): ${checked}`);
console.log(`  BS confirms 50% TP was reachable: ${confirmed} (${(100*confirmed/checked).toFixed(1)}%)`);
console.log(`  BS hit TP on/before OO close: ${confirmed-late}/${confirmed}   (BS-earlier:${early} same/later:${late})`);
console.log(`  no SPX data: ${noData}`);
if(misses.length)console.log('  NEVER-HIT (suspicious):\n   '+misses.slice(0,10).join('\n   '));

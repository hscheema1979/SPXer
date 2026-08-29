import { impliedVolFromPut, bsPutDelta } from '/home/ubuntu/SPXer/scripts/diag/black-scholes';
import * as fs from 'fs';
function parse(l:string){const o:string[]=[];let c="",q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o}
const RATE=0.04;
function analyze(f:string){
  const txt=fs.readFileSync('.termchat-uploads/'+f,'utf8').replace(/^﻿/,'');
  const L=txt.split(/\r?\n/).filter(x=>x.trim());const H=parse(L[0]).map(s=>s.replace(/"/g,''));const ix=(n:string)=>H.indexOf(n);
  const recs=L.slice(1).map(parse).filter(r=>r.length>=H.length).map(r=>({do:r[ix('Date Opened')],dc:r[ix('Date Closed')],spot:+r[ix('Opening Price')],legs:r[ix('Legs')].replace(/"/g,''),days:+r[ix('Days in Trade')],pl:+r[ix('P/L')],margin:+r[ix('Margin Req.')]})).sort((a,b)=>a.dc<b.dc?-1:1);
  let dsum=0,dn=0;for(const r of recs){const sto=r.legs.split('|').find((p:string)=>/STO/.test(p));if(!sto)continue;const m=sto.match(/(\d+(?:\.\d+)?)\s+P\s+STO\s+(\d+(?:\.\d+)?)/);if(!m)continue;const Ks=+m[1],prem=+m[2];const T=Math.max(r.days,0.5)/365;const iv=impliedVolFromPut(prem,r.spot,Ks,T,RATE);if(iv!=null){dsum+=Math.abs(bsPutDelta(r.spot,Ks,T,iv,RATE));dn++}}
  const pls=recs.map(r=>r.pl);const n=pls.length,wr=100*pls.filter(x=>x>0).length/n,tot=pls.reduce((a,b)=>a+b,0);
  let peak=-1e18,cum=0,dd=0;for(const r of recs){cum+=r.pl;if(cum>peak)peak=cum;if(peak-cum>dd)dd=peak-cum}
  const byDay:any={};for(const r of recs)byDay[r.dc]=(byDay[r.dc]||0)+r.pl;const daily=Object.values(byDay) as number[];
  const dm=daily.reduce((a,b)=>a+b,0)/daily.length;const sd=Math.sqrt(daily.reduce((a,b)=>a+(b-dm)**2,0)/daily.length);
  const sharpe=sd>0?(dm/sd)*Math.sqrt(252):0;
  const avgMargin=recs.reduce((a,b)=>a+b.margin,0)/n;
  return {delta:dsum/dn,n,wr,tot,dd,sharpe,avgMargin,avgPnl:tot/n};
}
const sets=[
  {d:'0.50', w5:'trade-log_12_-mqfxt5qz.csv', w10:'trade-log_1_.csv'},
  {d:'0.55', w5:'trade-log_10_-mqfxt5s7.csv', w10:'trade-log_4_.csv'},
  {d:'0.60', w5:'trade-log_11_-mqfxt5ow.csv', w10:'trade-log_5_.csv'},
];
console.log("=== 5-wide vs 10-wide, 20DTE hold-to-settle, 2022-2026 (per 1 contract) ===\n");
console.log("Δ     width  WR%   PnL      maxDD   Sharpe  avgMargin  ROM%(PnL/margin/trade)");
for(const s of sets){
  for(const [lbl,f] of [['5w',s.w5],['10w',s.w10]] as [string,string][]){
    const a=analyze(f);
    const rom=100*a.avgPnl/a.avgMargin;
    console.log(`  ${a.delta.toFixed(2)} ${lbl.padEnd(5)} ${a.wr.toFixed(0).padStart(3)}  $${String(Math.round(a.tot)).padStart(6)}  $${String(Math.round(a.dd)).padStart(6)}  ${a.sharpe.toFixed(2).padStart(5)}   $${String(Math.round(a.avgMargin)).padStart(4)}     ${rom.toFixed(1)}%`);
  }
  // 2x comparison: 5w x2 vs 10w x1 (matched ~capital)
  const a5=analyze(s.w5),a10=analyze(s.w10);
  console.log(`     → ${s.d}Δ: 5w×2contracts = PnL $${Math.round(a5.tot*2)}, DD $${Math.round(a5.dd*2)}, margin $${Math.round(a5.avgMargin*2)}  |  10w×1 = PnL $${Math.round(a10.tot)}, DD $${Math.round(a10.dd)}, margin $${Math.round(a10.avgMargin)}\n`);
}

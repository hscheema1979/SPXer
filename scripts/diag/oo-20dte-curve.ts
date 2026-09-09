import { impliedVolFromPut, bsPutDelta } from '/home/ubuntu/SPXer/scripts/diag/black-scholes';
import * as fs from 'fs';
function parse(l:string){const o:string[]=[];let c="",q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o}
const RATE=0.04;
// 20DTE files (user-labeled): 8=0.20, 7=0.25, 9=0.30, 1=0.50, 4=0.55, 5=0.60, 6=0.70
const files=['trade-log_8_.csv','trade-log_7_.csv','trade-log_9_.csv','trade-log_1_.csv','trade-log_4_.csv','trade-log_5_.csv','trade-log_6_.csv'];
const rows:any[]=[];
for(const f of files){
  const txt=fs.readFileSync('.termchat-uploads/'+f,'utf8').replace(/^﻿/,'');
  const L=txt.split(/\r?\n/).filter(x=>x.trim());const H=parse(L[0]).map(s=>s.replace(/"/g,''));const ix=(n:string)=>H.indexOf(n);
  const recs=L.slice(1).map(parse).filter(r=>r.length>=H.length).map(r=>({do:r[ix('Date Opened')],dc:r[ix('Date Closed')],spot:+r[ix('Opening Price')],legs:r[ix('Legs')].replace(/"/g,''),days:+r[ix('Days in Trade')],pl:+r[ix('P/L')]})).sort((a,b)=>a.dc<b.dc?-1:1);
  // delta
  let dsum=0,dn=0;
  for(const r of recs){const sto=r.legs.split('|').find((p:string)=>/STO/.test(p));if(!sto)continue;const m=sto.match(/(\d+(?:\.\d+)?)\s+P\s+STO\s+(\d+(?:\.\d+)?)/);if(!m)continue;const Ks=+m[1],prem=+m[2];const T=Math.max(r.days,0.5)/365;const iv=impliedVolFromPut(prem,r.spot,Ks,T,RATE);if(iv!=null){dsum+=Math.abs(bsPutDelta(r.spot,Ks,T,iv,RATE));dn++}}
  const delta=dsum/dn;
  const pls=recs.map(r=>r.pl);const n=pls.length,wr=100*pls.filter(x=>x>0).length/n,tot=pls.reduce((a,b)=>a+b,0);
  let peak=-1e18,cum=0,dd=0;for(const r of recs){cum+=r.pl;if(cum>peak)peak=cum;if(peak-cum>dd)dd=peak-cum}
  const byDay:any={};for(const r of recs)byDay[r.dc]=(byDay[r.dc]||0)+r.pl;const daily=Object.values(byDay) as number[];
  const dm=daily.reduce((a,b)=>a+b,0)/daily.length;const sd=Math.sqrt(daily.reduce((a,b)=>a+(b-dm)**2,0)/daily.length);
  const sharpe=sd>0?(dm/sd)*Math.sqrt(252):0;
  rows.push({delta,n,wr,tot,dd,ndd:tot/dd,sharpe});
}
rows.sort((a,b)=>a.delta-b.delta);
console.log("=== SPX 20DTE FULL DELTA CURVE — your OptionOmega data, 2022-2026, hold-to-settle, 1pm, 10-wide ===\n");
console.log("delta   WR%     PnL      maxDD    net/DD   Sharpe   n");
for(const r of rows) console.log(`  ${r.delta.toFixed(2)}   ${r.wr.toFixed(0).padStart(3)}   $${String(Math.round(r.tot)).padStart(6)}   $${String(Math.round(r.dd)).padStart(6)}   ${r.ndd.toFixed(2).padStart(5)}   ${r.sharpe.toFixed(2).padStart(5)}   ${r.n}`);
const best=rows.reduce((a,b)=>b.sharpe>a.sharpe?b:a);
console.log(`\n  BEST SHARPE: ${best.delta.toFixed(2)}d → Sharpe ${best.sharpe.toFixed(2)} ($${Math.round(best.tot)} PnL, $${Math.round(best.dd)} DD)`);

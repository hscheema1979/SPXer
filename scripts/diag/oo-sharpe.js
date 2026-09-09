// Annualized Sharpe (daily-realized) from OptionOmega trade logs.
const fs = require("fs");
function parse(l){const o=[];let c="",q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o}
const files={'trade-log.csv':'0.25d 3DTE','trade-log_2_.csv':'0.45d 10DTE','trade-log_1_.csv':'0.50d 20DTE','trade-log_4_.csv':'0.55d 20DTE','trade-log_5_.csv':'0.60d 20DTE','trade-log_6_.csv':'0.70d 20DTE'};
for(const [f,lbl] of Object.entries(files)){
  const txt=fs.readFileSync('.termchat-uploads/'+f,'utf8').replace(/^﻿/,'');
  const L=txt.split(/\r?\n/).filter(x=>x.trim());const H=parse(L[0]).map(s=>s.replace(/"/g,''));const ix=n=>H.indexOf(n);
  const recs=L.slice(1).map(parse).filter(r=>r.length>=H.length).map(r=>({dc:r[ix('Date Closed')],pl:+r[ix('P/L')]})).sort((a,b)=>a.dc<b.dc?-1:1);
  const byDay={};for(const r of recs)byDay[r.dc]=(byDay[r.dc]||0)+r.pl;
  const daily=Object.values(byDay);const n=daily.length;
  const mean=daily.reduce((a,b)=>a+b,0)/n;const sd=Math.sqrt(daily.reduce((a,b)=>a+(b-mean)**2,0)/n);
  const sharpe=sd>0?(mean/sd)*Math.sqrt(252):0;
  const tot=recs.reduce((a,b)=>a+b.pl,0);
  let peak=-1e18,cum=0,dd=0;for(const r of recs){cum+=r.pl;if(cum>peak)peak=cum;if(peak-cum>dd)dd=peak-cum}
  console.log(`  ${lbl.padEnd(12)} PnL $${String(Math.round(tot)).padStart(6)}  DD $${String(Math.round(dd)).padStart(6)}  net/DD ${(tot/dd).toFixed(2).padStart(5)}  Sharpe ${sharpe.toFixed(2)}`);
}

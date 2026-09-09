import * as dotenv from 'dotenv'; dotenv.config({quiet:true} as any);
import { resolveSymbolTarget, loadDay } from './sweep-symbol';
import { optPx, applyExit, buildLegs } from './flat-fly-study';
const T=resolveSymbolTarget(['--symbol','SPX']);
const c1:any=loadDay(T,'2026-06-11','1m'); const s1=c1.spxBars;
function sess(d:string){const[y,mo,da]=d.split('-').map(Number);const n=new Date(Date.UTC(y,mo-1,da,12,0,0));const eh=parseInt(n.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));return Math.floor(Date.UTC(y,mo-1,da,9+(12-eh),30,0)/1000);}
const s=sess('2026-06-11'); const entryTs=s+21600; const settle=s+6*3600+15*60;
const body=optPx(s1,entryTs-1)!; const spxSettle=optPx(s1,settle)!;
console.log(`3:30 entry body=${body.toFixed(2)}  settle(3:45)=${spxSettle.toFixed(2)}  move=${(spxSettle-body>=0?'+':'')+(spxSettle-body).toFixed(2)}`);
console.log('  w    credit   lower_BE  upper_BE    settle  net$');
for(const w of [10,15,20,30]){
  const legs=buildLegs(c1,body,w); if(!legs){continue;}
  const epx=legs.map(l=>optPx(l.bars,entryTs-1)); const credit=legs.reduce((a,l,i)=>a+l.sign*(epx[i] as number),0);
  const nat=applyExit([],settle,settle,legs,credit,0,spxSettle,w,0);
  const net=Math.round((credit-nat.exitV)*100-25);
  const sp=legs[0].strike, sc=legs[2].strike; // short put/call strikes
  console.log(`  w${String(w).padEnd(2)}  $${credit.toFixed(2).padStart(5)}   ${(sp-credit).toFixed(1)}  ${(sc+credit).toFixed(1)}   ${spxSettle.toFixed(1)}  ${(net>=0?'+':'')+net}`);
}

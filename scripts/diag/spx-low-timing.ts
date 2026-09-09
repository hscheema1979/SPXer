import { resolveSymbolTarget, loadDay, listDatesFor } from './sweep-symbol';
const T = resolveSymbolTarget(['--symbol','SPX','--dte','0']) as any;
const dates = listDatesFor(T);
const SESS = 6.5*3600;
const buckets = ['9:30-10','10-10:30','10:30-11','11-11:30','11:30-12','12-12:30','12:30-1','1-1:30','1:30-2','2-2:30','2:30-3','3-3:30','3:30-4'];
function bucketOf(min:number){const i=Math.min(12,Math.floor(min/30));return buckets[i];}
const hist:any={}; for(const b of buckets)hist[b]=0;
const histDn:any={},histUp:any={}; for(const b of buckets){histDn[b]=0;histUp[b]=0;}
let n=0, lowBefore1pm=0, lowAfter1pm=0;
let sumDrop1pmToLow=0, nDropAfter=0, sum1pmToClose=0, closeAbove1pm=0;
let sumLowToClose=0, sumOpenToLow=0;
for(const d of dates){
  let bars:any[]=[]; try{bars=loadDay(T,d,'1m')?.spxBars??[]}catch{}
  if(bars.length<300)continue;
  const t0=bars[0].ts;
  const sess=bars.filter(b=>b.ts>=t0 && b.ts<=t0+SESS);
  if(!sess.length)continue;
  let lo=Infinity,loi=0; for(let i=0;i<sess.length;i++){const v=sess[i].low??sess[i].close;if(v<lo){lo=v;loi=i}}
  const lowMin=(sess[loi].ts-t0)/60;
  const open=sess[0].open??sess[0].close, close=sess[sess.length-1].close;
  // price at 1pm = 210 min from open
  const at1pm=(sess.find(b=>(b.ts-t0)/60>=210)??sess[sess.length-1]).close;
  n++;
  hist[bucketOf(lowMin)]++;
  (close<open?histDn:histUp)[bucketOf(lowMin)]++;
  if(lowMin<210)lowBefore1pm++; else lowAfter1pm++;
  if(lowMin>=210){sumDrop1pmToLow+=(lo-at1pm)/at1pm*100;nDropAfter++}
  sum1pmToClose+=(close-at1pm)/at1pm*100;
  if(close>=at1pm)closeAbove1pm++;
  sumLowToClose+=(close-lo)/lo*100;
  sumOpenToLow+=(lo-open)/open*100;
}
console.log(`=== SPX intraday LOW timing — ${n} days (${dates[0]} → ${dates[dates.length-1]}) ===\n`);
console.log('time-of-day of session LOW (all days):');
for(const b of buckets){const pct=100*hist[b]/n;const bar='█'.repeat(Math.round(pct/2));console.log(`  ${b.padEnd(9)} ${pct.toFixed(1).padStart(5)}%  ${bar}`);}
console.log(`\n  low BEFORE 1pm: ${(100*lowBefore1pm/n).toFixed(1)}%   low AFTER 1pm: ${(100*lowAfter1pm/n).toFixed(1)}%`);
console.log(`\n=== relative to your 1pm entry ===`);
console.log(`  days SPX closes >= its 1pm price: ${(100*closeAbove1pm/n).toFixed(1)}%`);
console.log(`  avg move 1pm → close: ${(sum1pmToClose/n).toFixed(2)}%`);
console.log(`  when low is AFTER 1pm (${(100*lowAfter1pm/n).toFixed(0)}% of days): avg drop 1pm → low = ${(sumDrop1pmToLow/nDropAfter).toFixed(2)}%`);
console.log(`  avg recovery low → close: +${(sumLowToClose/n).toFixed(2)}%   avg open → low: ${(sumOpenToLow/n).toFixed(2)}%`);
console.log(`\n=== low timing on DOWN days vs UP days ===`);
console.log('  bucket     down-day%  up-day%');
for(const b of buckets){const dn=histDn[b],up=histUp[b];const dnT=Object.values(histDn).reduce((a:any,x:any)=>a+x,0) as number;const upT=Object.values(histUp).reduce((a:any,x:any)=>a+x,0) as number;console.log(`  ${b.padEnd(9)} ${(100*dn/dnT).toFixed(1).padStart(6)}%   ${(100*up/upT).toFixed(1).padStart(6)}%`);}

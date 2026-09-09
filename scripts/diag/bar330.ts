import * as dotenv from 'dotenv'; dotenv.config({quiet:true} as any);
import { resolveSymbolTarget, loadDay } from './sweep-symbol';
const T = resolveSymbolTarget(['--symbol','SPX']);
const c1:any = loadDay(T,'2026-06-11','1m'); const s1=c1.spxBars;
function sess(d:string){const[y,mo,da]=d.split('-').map(Number);const n=new Date(Date.UTC(y,mo-1,da,12,0,0));const eh=parseInt(n.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));return Math.floor(Date.UTC(y,mo-1,da,9+(12-eh),30,0)/1000);}
const s=sess('2026-06-11');
const et=(ts:number)=>{const m=570+(ts-s)/60;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
console.log('  ET     open     high     low      close');
for(const b of s1){ if(b.ts>=s+21480 && b.ts<=s+21720){ console.log(`  ${et(b.ts)}  ${b.open.toFixed(2)} ${b.high.toFixed(2)} ${b.low.toFixed(2)} ${b.close.toFixed(2)}`);}}

/**
 * ndx-combo-spread.ts — Reconstruct the NET combo bid/ask for NDX 0DTE
 * iron flies (BWB) and 2-leg credit spreads from real per-leg ThetaData NBBO.
 *
 * Synthetic net spread (leg-summed) is the UPPER BOUND on the combo spread —
 * the real complex-order-book quote is typically TIGHTER due to MM price
 * improvement. So if the leg-summed ## is reasonable vs the credit, the real
 * fill is better. Reports the ## net bid/ask spread in DOLLARS per contract.
 *
 * Combo net price (credit structures, you SELL the package):
 *   net_bid = sum(short bids) - sum(long asks)   (worst you'd receive)
 *   net_ask = sum(short asks) - sum(long bids)    (best you'd receive)
 *   net spread = net_ask - net_bid (in pts) * 100 = $ per contract
 */
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

const REST = process.env.THETADATA_REST_URL || 'http://127.0.0.1:25503';
const T = resolveSymbolTarget(['', '', '--symbol', 'NDX']);
const SI = T.strikeInterval; // 10

interface Quote { tsMin: number; bid: number; ask: number; }
// cache of strike,right -> minute -> {bid,ask}
async function fetchLegQuotes(date: string, right: 'put'|'call', strike: number): Promise<Map<number,{bid:number,ask:number}>> {
  const m = new Map<number,{bid:number,ask:number}>();
  const url = `${REST}/v3/option/history/quote?symbol=NDXP&expiration=${date}&right=${right}&strike=${strike}&interval=1m&start_date=${date}&end_date=${date}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return m;
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return m;
    const hdr = lines[0].split(',');
    const bI = hdr.indexOf('bid'), aI = hdr.indexOf('ask'), tI = hdr.indexOf('timestamp');
    for (let i=1;i<lines.length;i++){
      const c = lines[i].split(',');
      const bid = parseFloat(c[bI]), ask = parseFloat(c[aI]);
      const ts = c[tI]?.replace(/"/g,'');
      const hm = /T(\d{2}):(\d{2})/.exec(ts||'');
      if (!hm) continue;
      const minOfDay = parseInt(hm[1])*60 + parseInt(hm[2]);
      if (bid>0 && ask>0 && ask>=bid) m.set(minOfDay, {bid, ask});
    }
  } catch {}
  return m;
}

// Structures: define legs relative to ATM body (offset in pts, +OTM call side, -OTM put side)
// Credit structures we SELL.
interface Leg { right:'put'|'call'; offset:number; sign:number; } // sign +1 = short (sell), -1 = long (buy)
interface Struct { label:string; legs:Leg[]; }

const STRUCTS: Struct[] = [
  // ── 4-leg iron flies (ATM body, asymmetric wings) ──
  // BWB PwC: short put@ATM, long put@-P; short call@ATM, long call@+C
  { label:'BWB 50w50', legs:[ {right:'put',offset:0,sign:+1},{right:'put',offset:-50,sign:-1},{right:'call',offset:0,sign:+1},{right:'call',offset:+50,sign:-1} ]},
  { label:'BWB 60w50', legs:[ {right:'put',offset:0,sign:+1},{right:'put',offset:-60,sign:-1},{right:'call',offset:0,sign:+1},{right:'call',offset:+50,sign:-1} ]},
  { label:'BWB 60w60', legs:[ {right:'put',offset:0,sign:+1},{right:'put',offset:-60,sign:-1},{right:'call',offset:0,sign:+1},{right:'call',offset:+60,sign:-1} ]},
  { label:'BWB 80w80', legs:[ {right:'put',offset:0,sign:+1},{right:'put',offset:-80,sign:-1},{right:'call',offset:0,sign:+1},{right:'call',offset:+80,sign:-1} ]},
  // ── 2-leg credit spreads (call side, bear) ──
  { label:'20OTM w20 (call)', legs:[ {right:'call',offset:+20,sign:+1},{right:'call',offset:+40,sign:-1} ]},
  { label:'30OTM w20 (call)', legs:[ {right:'call',offset:+30,sign:+1},{right:'call',offset:+50,sign:-1} ]},
  { label:'40OTM w20 (call)', legs:[ {right:'call',offset:+40,sign:+1},{right:'call',offset:+60,sign:-1} ]},
  { label:'50OTM w20 (call)', legs:[ {right:'call',offset:+50,sign:+1},{right:'call',offset:+70,sign:-1} ]},
];

interface Sample { netSpreadPts:number; netMidPts:number; hour:number; }
const byStruct: Record<string, Sample[]> = {};
for (const s of STRUCTS) byStruct[s.label] = [];

async function main(){
  const all = listDatesFor(T);
  const N = parseInt(process.env.SAMPLE_DAYS||'30');
  const step = Math.floor(all.length/N);
  const dates:string[] = [];
  for(let i=0;i<N;i++) dates.push(all[i*step]);

  console.error(`Combo-spread sample: ${dates.length} dates`);
  for(const date of dates){
    const c1 = loadDay(T, date, '1m') as any;
    if(!c1?.spxBars?.length){ console.error(`  ${date} no bars`); continue; }
    const spot = c1.spxBars[Math.floor(c1.spxBars.length/2)].close;
    const atm = Math.round(spot/SI)*SI;

    // gather all needed (right,strike) leg quote series
    const needed = new Map<string,{right:'put'|'call',strike:number}>();
    for(const s of STRUCTS) for(const lg of s.legs){
      const strike = atm + lg.offset;
      needed.set(`${lg.right}:${strike}`, {right:lg.right, strike});
    }
    const series = new Map<string, Map<number,{bid:number,ask:number}>>();
    // fetch with limited concurrency
    const entries = [...needed.entries()];
    for(let i=0;i<entries.length;i+=4){
      const batch = entries.slice(i,i+4);
      const got = await Promise.all(batch.map(([,v]) => fetchLegQuotes(date, v.right, v.strike)));
      batch.forEach(([k],j)=> series.set(k, got[j]));
    }

    // For each structure, for each minute where ALL legs quoted, compute net combo spread
    for(const s of STRUCTS){
      const legSeries = s.legs.map(lg => series.get(`${lg.right}:${atm+lg.offset}`)!);
      if(legSeries.some(x=>!x||x.size===0)) continue;
      // common minutes
      let mins = [...legSeries[0].keys()];
      for(let i=1;i<legSeries.length;i++){ const set = legSeries[i]; mins = mins.filter(m=>set.has(m)); }
      for(const min of mins){
        const hour = Math.floor(min/60);
        if(hour<10||hour>15) continue;
        let netBid=0, netAsk=0;
        s.legs.forEach((lg,i)=>{
          const q = legSeries[i].get(min)!;
          if(lg.sign>0){ // short: receive bid (worst), receive ask (best)
            netBid += q.bid; netAsk += q.ask;
          } else { // long: pay ask (worst), pay bid (best)
            netBid -= q.ask; netAsk -= q.bid;
          }
        });
        const spread = netAsk - netBid;
        const mid = (netAsk + netBid)/2;
        if(spread<=0 || mid<=0) continue;
        byStruct[s.label].push({ netSpreadPts: spread, netMidPts: mid, hour });
      }
    }
    console.error(`  ${date} done`);
  }

  const pct=(a:number[],p:number)=>{ if(!a.length)return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*p)]; };

  console.log('\n=== NDX COMBO NET BID/ASK SPREAD (leg-summed = UPPER BOUND; real combo is tighter) ===');
  console.log('Spread shown in $ per contract (= net_ask - net_bid, ×100). RTH 10:00-15:45.\n');
  console.log('structure          n      mid$    spread$_p25  p50    p75    p90   sprd%mid_p50');
  for(const s of STRUCTS){
    const arr = byStruct[s.label];
    if(!arr.length){ console.log(s.label.padEnd(18)+' no data'); continue; }
    const sp = arr.map(x=>x.netSpreadPts*100);
    const mid = arr.map(x=>x.netMidPts*100);
    const avgMid = mid.reduce((a,b)=>a+b,0)/mid.length;
    const relP50 = pct(arr.map(x=>x.netSpreadPts/x.netMidPts*100),0.5);
    console.log(
      s.label.padEnd(18)+
      String(arr.length).padStart(6)+
      ('$'+avgMid.toFixed(0)).padStart(8)+
      ('$'+pct(sp,0.25).toFixed(0)).padStart(12)+
      ('$'+pct(sp,0.50).toFixed(0)).padStart(7)+
      ('$'+pct(sp,0.75).toFixed(0)).padStart(7)+
      ('$'+pct(sp,0.90).toFixed(0)).padStart(7)+
      (relP50.toFixed(0)+'%').padStart(11)
    );
  }

  // ToD for the flies
  console.log('\n=== Combo spread $ by ET hour (BWB 50w50 vs 30OTM w20) ===');
  console.log('hour    BWB50w50_p50   BWB50w50_p75    30OTMw20_p50   30OTMw20_p75');
  for(let h=10;h<=15;h++){
    const fly = byStruct['BWB 50w50'].filter(x=>x.hour===h).map(x=>x.netSpreadPts*100);
    const cs  = byStruct['30OTM w20 (call)'].filter(x=>x.hour===h).map(x=>x.netSpreadPts*100);
    if(!fly.length && !cs.length) continue;
    console.log(`${h}:00 ${('$'+pct(fly,0.5).toFixed(0)).padStart(13)} ${('$'+pct(fly,0.75).toFixed(0)).padStart(14)} ${('$'+pct(cs,0.5).toFixed(0)).padStart(14)} ${('$'+pct(cs,0.75).toFixed(0)).padStart(14)}`);
  }
}
main();

const fs=require('fs');
const duckdb=require('duckdb');
const db=new duckdb.Database(':memory:');
const sql=`SELECT ts, open o, high h, low l, close c, volume v FROM read_parquet('data/parquet/bars/spy-1dte/*.parquet')
           WHERE symbol='SPY' AND timeframe='1m' AND close IS NOT NULL ORDER BY ts`;
db.all(sql,(e,rows)=>{
  if(e){console.error(e.message);process.exit(1);}
  const bars=rows.map(r=>({ts:Number(r.ts),o:r.o,h:r.h,l:r.l,c:r.c,v:Number(r.v||0)}));
  console.log('cached SPY 1m bars:',bars.length,'range',new Date(bars[0].ts*1000).toISOString().slice(0,10),'→',new Date(bars[bars.length-1].ts*1000).toISOString().slice(0,10));
  function agg(b,f){const out=[];for(let i=0;i<b.length;i+=f){const c=b.slice(i,i+f);if(!c.length)break;out.push({ts:c[0].ts,o:c[0].o,h:Math.max(...c.map(x=>x.h)),l:Math.min(...c.map(x=>x.l)),c:c[c.length-1].c,v:c.reduce((s,x)=>s+x.v,0)});}return out;}
  // only aggregate within-day (don't span overnight gaps): group by UTC date then factor
  const byDay=new Map();
  for(const b of bars){const d=new Date(b.ts*1000).toISOString().slice(0,10);if(!byDay.has(d))byDay.set(d,[]);byDay.get(d).push(b);}
  function aggTF(factor){const out=[];for(const d of byDay.keys()){const day=byDay.get(d);out.push(...agg(day,factor));}return out;}
  const h1=aggTF(60),h2=aggTF(120),h4=aggTF(240);
  fs.writeFileSync('scripts/autoresearch/output/spy-1h.json',JSON.stringify(h1));
  fs.writeFileSync('scripts/autoresearch/output/spy-2h.json',JSON.stringify(h2));
  fs.writeFileSync('scripts/autoresearch/output/spy-4h.json',JSON.stringify(h4));
  console.log('1h',h1.length,'2h',h2.length,'4h',h4.length);
  fs.appendFileSync('scripts/autoresearch/output/spy-research-progress.md',`${new Date().toISOString()} | switched to cached SPY 1m aggregation | 1m=${bars.length} → 1h=${h1.length} 2h=${h2.length} 4h=${h4.length}\n`);
});

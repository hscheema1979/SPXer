import fs from 'fs';
const files = process.argv.slice(2);
const byStrat = {};
const dayMap = {}; // strat -> {date: pnl}
for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of rows) {
    if (r.error && !r.trades?.length) continue;
    const s = (byStrat[r.strategy] ??= { pnl:0, n:0, wins:0, winSum:0, lossSum:0 });
    (dayMap[r.strategy] ??= {})[r.date] = r.dayPnl || 0;
    for (const t of (r.trades||[])) {
      s.n++; s.pnl += t.pnl;
      if (t.pnl > 0) { s.wins++; s.winSum += t.pnl; } else { s.lossSum += -t.pnl; }
    }
  }
}
function maxDD(daily) {
  const dates = Object.keys(daily).sort();
  let eq=0, peak=0, dd=0, green=0, red=0;
  for (const d of dates) { eq += daily[d]; peak = Math.max(peak, eq); dd = Math.min(dd, eq-peak); if(daily[d]>0)green++; else if(daily[d]<0)red++; }
  return { dd, days: dates.length, green, red };
}
console.log('config     | total PnL | trades | win% | avgWin | avgLoss | PF   | maxDD    | avg/day | green/red');
console.log('-'.repeat(108));
for (const name of ['3x9_1m','3x12_1m','3x21_1m']) {
  const s = byStrat[name]; if (!s) { console.log(`${name}: no data`); continue; }
  const { dd, days, green, red } = maxDD(dayMap[name]);
  const aw = s.wins ? s.winSum/s.wins : 0;
  const al = (s.n-s.wins) ? s.lossSum/(s.n-s.wins) : 0;
  const pf = s.lossSum ? s.winSum/s.lossSum : Infinity;
  console.log(
    `${name.padEnd(10)} | $${s.pnl.toFixed(0).padStart(7)} | ${String(s.n).padStart(5)}  | ${(s.wins/s.n*100).toFixed(0).padStart(3)}% | $${aw.toFixed(0).padStart(5)} | $${al.toFixed(0).padStart(5)}  | ${pf.toFixed(2)} | $${dd.toFixed(0).padStart(7)} | $${(s.pnl/days).toFixed(0).padStart(5)} | ${green}/${red}`
  );
}

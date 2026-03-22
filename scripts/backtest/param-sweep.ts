/**
 * Parameter sweep — tests multiple parameter combinations against the backtester.
 * Imports the core logic from backtest-multi.ts pattern but with configurable params.
 */
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve('/home/ubuntu/SPXer/data/spxer.db');

interface Params {
  label: string;
  trendThreshold: number;
  rsiOversoldTrigger: number;
  rsiOverboughtTrigger: number;
  rsiEmergencyOversold: number;
  rsiEmergencyOverbought: number;
  rsiMorningEmergencyOversold: number;
  rsiMorningEmergencyOverbought: number;
  priceMin: number;
  priceMax: number;
  idealPrice: number;
  emergencyIdealPrice: number;
  stopPct: number;
  tpMultiplier: number;
  maxRiskPerTrade: number;
  cooldownBars: number;
  morningEndMinute: number;
  gammaStartMinute: number;
  noTradeMinute: number;
  closeMinute: number;
  allowMorning: boolean;
  allowGamma: boolean;
}

const BASE: Params = {
  label: 'current',
  trendThreshold: 0.15, rsiOversoldTrigger: 20, rsiOverboughtTrigger: 80,
  rsiEmergencyOversold: 15, rsiEmergencyOverbought: 85,
  rsiMorningEmergencyOversold: 10, rsiMorningEmergencyOverbought: 92,
  priceMin: 0.20, priceMax: 8.00, idealPrice: 1.50, emergencyIdealPrice: 1.00,
  stopPct: 0.50, tpMultiplier: 10, maxRiskPerTrade: 300, cooldownBars: 10,
  morningEndMinute: 615, gammaStartMinute: 840, noTradeMinute: 930, closeMinute: 945,
  allowMorning: false, allowGamma: false,
};

const VARIANTS: Params[] = [
  { ...BASE, label: 'A-current' },
  { ...BASE, label: 'B-wider-stop', stopPct: 0.70 },
  { ...BASE, label: 'C-wider-stop-lower-tp', stopPct: 0.70, tpMultiplier: 5 },
  { ...BASE, label: 'D-relaxed-rsi', rsiOversoldTrigger: 25, rsiOverboughtTrigger: 75, stopPct: 0.70, tpMultiplier: 5 },
  { ...BASE, label: 'E-relaxed+morning', rsiOversoldTrigger: 25, rsiOverboughtTrigger: 75, stopPct: 0.70, tpMultiplier: 5, allowMorning: true },
  { ...BASE, label: 'F-relaxed+gamma', rsiOversoldTrigger: 25, rsiOverboughtTrigger: 75, stopPct: 0.70, tpMultiplier: 5, allowGamma: true },
  { ...BASE, label: 'G-all-open', rsiOversoldTrigger: 25, rsiOverboughtTrigger: 75, stopPct: 0.70, tpMultiplier: 5, allowMorning: true, allowGamma: true, cooldownBars: 5 },
  { ...BASE, label: 'H-aggressive', rsiOversoldTrigger: 30, rsiOverboughtTrigger: 70, stopPct: 0.80, tpMultiplier: 3, allowMorning: true, allowGamma: true, cooldownBars: 5 },
  { ...BASE, label: 'I-emerg-only', rsiOversoldTrigger: 15, rsiOverboughtTrigger: 85, rsiEmergencyOversold: 20, rsiEmergencyOverbought: 80, stopPct: 0.70, tpMultiplier: 5 },
  { ...BASE, label: 'J-tight-emerg', rsiEmergencyOversold: 18, rsiEmergencyOverbought: 82, stopPct: 0.70, tpMultiplier: 5, cooldownBars: 5 },
];

// ── helpers ──
interface SpxBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface ContractBar { symbol: string; type: string; strike: number; close: number; volume: number; high: number; low: number; }

function computeRSI(closes: number[], period=14): number|null {
  if (closes.length < period+1) return null;
  let g=0, l=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d=closes[i]-closes[i-1]; d>0 ? g+=d : l-=d;
  }
  g/=period; l/=period;
  if (l===0) return 100;
  return 100-(100/(1+g/l));
}

function linRegSlope(values: number[], period: number): number {
  const n=Math.min(values.length,period); if(n<5) return 0;
  const s=values.slice(-n); let sx=0,sy=0,sxy=0,sx2=0;
  for(let i=0;i<n;i++){sx+=i;sy+=s[i];sxy+=i*s[i];sx2+=i*i;}
  return (n*sxy-sx*sy)/(n*sx2-sx*sx);
}

function getETMinute(ts:number):number {
  const d=new Date(ts*1000);
  const et=d.toLocaleString('en-US',{timeZone:'America/New_York',hour12:false});
  const tp=et.split(', ')[1]||et;
  const [h,m]=tp.split(':').map(Number);
  return h*60+m;
}

type Regime = 'MORNING_MOMENTUM'|'MEAN_REVERSION'|'TRENDING_UP'|'TRENDING_DOWN'|'GAMMA_EXPIRY'|'NO_TRADE';

function classifyRegime(P:Params, minute:number, slope:number): Regime {
  if (minute >= P.noTradeMinute) return 'NO_TRADE';
  if (minute >= P.gammaStartMinute) {
    if (slope > P.trendThreshold) return 'TRENDING_UP';
    if (slope < -P.trendThreshold) return 'TRENDING_DOWN';
    return 'GAMMA_EXPIRY';
  }
  if (minute < P.morningEndMinute) {
    if (slope > P.trendThreshold) return 'TRENDING_UP';
    if (slope < -P.trendThreshold) return 'TRENDING_DOWN';
    return 'MORNING_MOMENTUM';
  }
  if (slope > P.trendThreshold) return 'TRENDING_UP';
  if (slope < -P.trendThreshold) return 'TRENDING_DOWN';
  return 'MEAN_REVERSION';
}

function isSignalAllowed(P:Params, regime:Regime, rsi:number, dir:'call'|'put', minute:number): boolean {
  const isMorning = minute < P.morningEndMinute;
  const eo = isMorning ? P.rsiMorningEmergencyOversold : P.rsiEmergencyOversold;
  const eob = isMorning ? P.rsiMorningEmergencyOverbought : P.rsiEmergencyOverbought;
  if (rsi < eo && dir === 'call') return true;
  if (rsi > eob && dir === 'put') return true;
  if (regime === 'NO_TRADE') return false;
  switch (regime) {
    case 'MORNING_MOMENTUM': return P.allowMorning;
    case 'MEAN_REVERSION': return true;
    case 'TRENDING_UP': return dir === 'call';
    case 'TRENDING_DOWN': return dir === 'put';
    case 'GAMMA_EXPIRY': return P.allowGamma;
  }
}

function selectStrike(P:Params, contracts:ContractBar[], dir:'call'|'put', spxPrice:number, rsi:number) {
  const isEmerg = rsi < P.rsiEmergencyOversold || rsi > P.rsiEmergencyOverbought;
  const cands = contracts.filter(c => c.type===dir && c.close>=P.priceMin && c.close<=P.priceMax)
    .filter(c => dir==='call' ? c.strike>spxPrice : c.strike<spxPrice);
  if (!cands.length) return null;
  const tp = isEmerg ? P.emergencyIdealPrice : P.idealPrice;
  const scored = cands.map(c => {
    const ps = 1-Math.abs(c.close-tp)/P.priceMax;
    const od = Math.abs(c.strike-spxPrice);
    const ds = isEmerg ? Math.min(1,od/30) : Math.min(1,od/25);
    return { ...c, score: ps*0.5+ds*0.4 };
  });
  scored.sort((a,b)=>b.score-a.score);
  const best=scored[0];
  const sl=best.close*(1-P.stopPct);
  const tpr=best.close*P.tpMultiplier;
  const rpc=best.close*100*P.stopPct;
  const qty=Math.max(1,Math.min(3,Math.floor(P.maxRiskPerTrade/rpc)));
  return { symbol:best.symbol, strike:best.strike, side:best.type, price:best.close, qty, stopLoss:sl, takeProfit:tpr };
}

function runVariant(db:Database.Database, P:Params, dates:string[]) {
  let totalTrades=0, totalWins=0, totalPnl=0, emergTotal=0, emergCaught=0;
  let maxDayLoss=0;

  for (const date of dates) {
    const expiry6=date.slice(2).replace(/-/g,'');
    const startTs=Math.floor(new Date(date+'T09:30:00-04:00').getTime()/1000);
    const endTs=startTs+390*60;
    const bars=db.prepare('SELECT ts,open,high,low,close,volume FROM bars WHERE symbol=? AND timeframe=? AND ts>=? AND ts<=? ORDER BY ts').all('SPX','1m',startTs,endTs) as SpxBar[];
    if (bars.length<30) continue;

    const closes:number[]=[];
    let position:any=null, lastSigBar=-999, dayPnl=0, dayTrades=0, dayWins=0;

    for (let i=0; i<bars.length; i++) {
      const bar=bars[i]; closes.push(bar.close);
      const minute=getETMinute(bar.ts);
      const rsi=computeRSI(closes);
      const slope=linRegSlope(closes,20);
      const regime=classifyRegime(P,minute,slope);

      if (position) {
        const contracts=db.prepare('SELECT b.symbol,c.type,c.strike,b.close,b.volume,b.high,b.low FROM bars b JOIN contracts c ON b.symbol=c.symbol WHERE b.symbol LIKE ? AND b.timeframe=? AND b.ts=(SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe=? AND b2.ts<=?) AND c.strike BETWEEN ? AND ? ORDER BY c.type,c.strike').all('SPXW'+expiry6+'%','1m','1m',bar.ts,bar.close-200,bar.close+200) as ContractBar[];
        const cm=new Map(contracts.map(c=>[c.type+'_'+c.strike,c]));
        const cur=cm.get(position.side+'_'+position.strike);
        const cp=cur?.close??position.price;
        let reason:string|null=null;
        if(cp<=position.stopLoss) reason='stop';
        else if(cp>=position.takeProfit) reason='tp';
        else if(minute>=P.closeMinute) reason='time';
        if(reason){
          const pnl=(cp-position.price)*position.qty*100;
          dayPnl+=pnl; dayTrades++; if(pnl>0) dayWins++;
          position=null;
        }
        continue;
      }

      if(!rsi) continue;
      if(i-lastSigBar<P.cooldownBars) continue;
      const isOS=rsi<P.rsiOversoldTrigger, isOB=rsi>P.rsiOverboughtTrigger;
      if(!isOS && !isOB) continue;
      const isEOS=rsi<P.rsiEmergencyOversold, isEOB=rsi>P.rsiEmergencyOverbought;
      if(isEOS||isEOB) emergTotal++;
      const dir:(('call'|'put'))=isOS?'call':'put';
      if(!isSignalAllowed(P,regime,rsi,dir,minute)){lastSigBar=i;continue;}
      const contracts=db.prepare('SELECT b.symbol,c.type,c.strike,b.close,b.volume,b.high,b.low FROM bars b JOIN contracts c ON b.symbol=c.symbol WHERE b.symbol LIKE ? AND b.timeframe=? AND b.ts=(SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe=? AND b2.ts<=?) AND c.strike BETWEEN ? AND ? ORDER BY c.type,c.strike').all('SPXW'+expiry6+'%','1m','1m',bar.ts,bar.close-200,bar.close+200) as ContractBar[];
      const sel=selectStrike(P,contracts,dir,bar.close,rsi);
      if(!sel){lastSigBar=i;continue;}
      if(isEOS||isEOB) emergCaught++;
      position={...sel};
      lastSigBar=i;
    }

    if(position){
      const lb=bars[bars.length-1];
      const contracts=db.prepare('SELECT b.symbol,c.type,c.strike,b.close,b.volume,b.high,b.low FROM bars b JOIN contracts c ON b.symbol=c.symbol WHERE b.symbol LIKE ? AND b.timeframe=? AND b.ts=(SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe=? AND b2.ts<=?) AND c.strike BETWEEN ? AND ? ORDER BY c.type,c.strike').all('SPXW'+expiry6+'%','1m','1m',lb.ts,lb.close-200,lb.close+200) as ContractBar[];
      const cm=new Map(contracts.map(c=>[c.type+'_'+c.strike,c]));
      const cur=cm.get(position.side+'_'+position.strike);
      const cp=cur?.close??0;
      const pnl=(cp-position.price)*position.qty*100;
      dayPnl+=pnl; dayTrades++; if(pnl>0) dayWins++;
    }

    totalTrades+=dayTrades; totalWins+=dayWins; totalPnl+=dayPnl;
    if(dayPnl<maxDayLoss) maxDayLoss=dayPnl;
  }

  const wr=totalTrades>0?totalWins/totalTrades:0;
  const avgPnl=dates.length>0?totalPnl/dates.length:0;
  return { label:P.label, trades:totalTrades, wins:totalWins, wr, totalPnl, avgPnl, maxDayLoss, emergCaught, emergTotal };
}

// ── Main ──
const db = new Database(DB_PATH, { readonly: true });
const allDays = db.prepare("SELECT DISTINCT substr(symbol,5,6) as e FROM contracts WHERE symbol LIKE 'SPXW%' AND type='call' ORDER BY e").all() as any[];
let dates = allDays.map((r:any) => '20'+r.e.slice(0,2)+'-'+r.e.slice(2,4)+'-'+r.e.slice(4,6));
const startTs = (d:string) => Math.floor(new Date(d+'T09:30:00-04:00').getTime()/1000);
dates = dates.filter(d => {
  const rows = db.prepare('SELECT count(*) as n FROM bars WHERE symbol=? AND timeframe=? AND ts>=? AND ts<=?').get('SPX','1m',startTs(d),startTs(d)+390*60) as any;
  return rows.n > 30;
});

console.log(`Parameter sweep: ${VARIANTS.length} variants × ${dates.length} days\n`);
console.log('Label                    | Trades | W/L    | WR     | Total P&L | Avg/day | Max Loss | Emerg  | Targets');
console.log('─'.repeat(110));

for (const v of VARIANTS) {
  const r = runVariant(db, v, dates);
  const wrOk = r.wr > 0.40 ? '✅' : '❌';
  const avgOk = r.avgPnl > 0 ? '✅' : '❌';
  const lossOk = r.maxDayLoss > -500 ? '✅' : '❌';
  const emergOk = r.emergTotal === 0 || r.emergCaught/r.emergTotal > 0.80 ? '✅' : '❌';
  const allPass = r.wr>0.40 && r.avgPnl>0 && r.maxDayLoss>-500 && (r.emergTotal===0||r.emergCaught/r.emergTotal>0.80);
  console.log(
    `${r.label.padEnd(24)} | ${String(r.trades).padStart(6)} | ${r.wins}/${r.trades-r.wins}`.padEnd(50) +
    ` | ${(r.wr*100).toFixed(1).padStart(5)}% | $${r.totalPnl.toFixed(0).padStart(8)} | $${r.avgPnl.toFixed(0).padStart(6)} | $${r.maxDayLoss.toFixed(0).padStart(7)} | ${r.emergCaught}/${r.emergTotal}`.padEnd(20) +
    ` | ${wrOk}${avgOk}${lossOk}${emergOk} ${allPass ? '🎯' : ''}`
  );
}

db.close();

import axios from 'axios';
import type { ScreenerSnapshot } from '../types';

const TV_SCAN_BASE = 'https://scanner.tradingview.com';
const COLUMNS = [
  'name','close','change','RSI','MACD.macd','EMA50','BB.upper','BB.lower',
  'Volatility.D','Recommend.All','volume',
];

async function scan(market: string, names: string[], exchangeFilter?: string): Promise<ScreenerSnapshot[]> {
  const filter: object[] = [{ left: 'name', operation: 'in_range', right: names }];
  if (exchangeFilter) {
    filter.push({ left: 'exchange', operation: 'equal', right: exchangeFilter });
  }
  const body = {
    filter,
    columns: COLUMNS,
    sort: { sortBy: 'name', sortOrder: 'asc' },
    range: [0, names.length],
  };
  const { data } = await axios.post(
    `${TV_SCAN_BASE}/${market}/scan`,
    body,
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  const ts = Math.floor(Date.now() / 1000);
  return (data?.data || []).map((row: any) => {
    const [name, close, change, rsi, macd, ema50,,, volD, rec] = row.d;
    return { symbol: name, close, change, rsi, macd, ema50, volatilityD: volD, recommendation: rec, ts };
  });
}

export async function fetchScreenerSnapshot(): Promise<ScreenerSnapshot[]> {
  const [futures, equities] = await Promise.all([
    scan('futures', ['ES1!','NQ1!','RTY1!','VX1!','MES1!'], 'CME_MINI'),
    scan('america', ['SPY','QQQ','XLF','XLK','XLE','XLV','XLI','XLY','XLP','GLD','TLT']),
  ]);
  return [...futures, ...equities];
}

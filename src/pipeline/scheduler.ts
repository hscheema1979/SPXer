import { MARKET_HOLIDAYS, EARLY_CLOSE_DAYS } from '../config';
import { nowET, todayET } from '../utils/et-time';

export type MarketMode = 'overnight' | 'preopen' | 'rth' | 'weekend';

export function isMarketHoliday(date: string): boolean {
  return MARKET_HOLIDAYS.has(date);
}

export function isEarlyCloseDay(date: string): boolean {
  return EARLY_CLOSE_DAYS.has(date);
}

export function getMarketMode(now: Date = new Date()): MarketMode {
  const et = nowET(now);
  const dateStr = todayET(now);
  // Get day of week from the ET date (not from the possibly-shifted Date object)
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun, 6=Sat

  if (day === 0 || day === 6) return 'weekend';
  if (isMarketHoliday(dateStr)) return 'overnight';

  const h = et.h, m = et.m;
  const mins = h * 60 + m;

  const rthEnd = isEarlyCloseDay(dateStr) ? 13 * 60 : 17 * 60;

  // RTH starts at 8:00 AM ET (Tradier SPX data begins)
  // preopen is 7:55-8:00 AM ET (5-min warmup window)
  if (mins >= 7 * 60 + 55 && mins < 8 * 60) return 'preopen';
  if (mins >= 8 * 60 && mins < rthEnd) return 'rth';
  return 'overnight';
}

export function getActiveExpirations(today: string, available: string[]): string[] {
  const todayDate = new Date(today);
  const dayOfWeek = todayDate.getDay(); // 5=Friday
  const maxDTE = dayOfWeek === 5 ? 3 : 2;

  return available.filter(exp => {
    const diff = (new Date(exp).getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= maxDTE;
  });
}

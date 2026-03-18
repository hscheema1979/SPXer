import { MARKET_HOLIDAYS, EARLY_CLOSE_DAYS } from '../config';

export type MarketMode = 'overnight' | 'preopen' | 'rth' | 'weekend';

export function isMarketHoliday(date: string): boolean {
  return MARKET_HOLIDAYS.has(date);
}

export function isEarlyCloseDay(date: string): boolean {
  return EARLY_CLOSE_DAYS.has(date);
}

function toET(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function getMarketMode(now: Date = new Date()): MarketMode {
  const et = toET(now);
  const day = et.getDay(); // 0=Sun, 6=Sat
  // Use local date components (not toISOString which returns UTC) to get the ET calendar date
  const dateStr = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;

  if (day === 0 || day === 6) return 'weekend';
  if (isMarketHoliday(dateStr)) return 'overnight';

  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;

  const rthEnd = isEarlyCloseDay(dateStr) ? 13 * 60 : 16 * 60 + 15;

  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 30) return 'preopen';
  if (mins >= 9 * 60 + 30 && mins < rthEnd) return 'rth';
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

/**
 * ohlc-aggregate.ts
 *
 * Aggregate 1-minute bars into higher timeframes for multi-DTE swing signals:
 * 2h/4h (intraday, anchored to the 09:30 session open), daily, and weekly.
 *
 * A multi-day position is driven by swing-scale signals; minute crosses are
 * noise over a 5-60 day hold. These aggregators feed the higher-TF HMA/DEMA.
 */

export interface OHLCBar {
  ts: number;     // unix seconds (bucket start for aggregated bars)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** ET calendar date 'YYYY-MM-DD' for a unix-seconds timestamp. */
function etDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA → ISO
}

/** Fold a group of bars (assumed time-ordered) into one OHLC bar. */
function fold(group: OHLCBar[]): OHLCBar {
  const open = group[0].open;
  const close = group[group.length - 1].close;
  let high = -Infinity, low = Infinity, volume = 0;
  for (const b of group) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return { ts: group[0].ts, open, high, low, close, volume };
}

/**
 * Aggregate intraday bars into `bucketMinutes` buckets anchored to each
 * session's 09:30 ET open. Buckets never span two sessions. `sessionOpenTs` is
 * the 09:30 ET unix-seconds for the FIRST session; per-session open is derived
 * from each bar's own date so multi-day input is handled.
 */
export function aggregateIntraday(
  bars: OHLCBar[],
  bucketMinutes: number,
  sessionOpenTs: number
): OHLCBar[] {
  if (bars.length === 0) return [];
  const bucketSec = bucketMinutes * 60;
  // Seconds-of-day offset of the anchor open (e.g. 09:30 ET → same offset each
  // session). We bucket by (date, floor((ts - thatDay'sOpen)/bucketSec)).
  const anchorSecOfDay = ((sessionOpenTs % 86400) + 86400) % 86400;

  const groups = new Map<string, OHLCBar[]>();
  const order: string[] = [];
  for (const b of bars) {
    const date = etDate(b.ts);
    // The session open for b's date shares the anchor's seconds-of-day.
    const dayStart = b.ts - (((b.ts % 86400) + 86400) % 86400);
    const dayOpen = dayStart + anchorSecOfDay;
    const idx = Math.floor((b.ts - dayOpen) / bucketSec);
    const key = `${date}#${idx}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(b);
  }
  return order.map(k => fold(groups.get(k)!));
}

/** Aggregate into one bar per ET trading date. */
export function aggregateDaily(bars: OHLCBar[]): OHLCBar[] {
  if (bars.length === 0) return [];
  const groups = new Map<string, OHLCBar[]>();
  const order: string[] = [];
  for (const b of bars) {
    const key = etDate(b.ts);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(b);
  }
  return order.map(k => fold(groups.get(k)!));
}

/** ISO week key 'GGGG-Www' (Mon-anchored) for a unix-seconds timestamp. */
function isoWeekKey(ts: number): string {
  // Compute ISO week from the ET date to keep week boundaries on ET Mondays.
  const [y, m, d] = etDate(ts).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // ISO: Thursday determines the week-year.
  const day = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  dt.setUTCDate(dt.getUTCDate() - day + 3); // move to Thursday of this week
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const firstThuDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDay + 3);
  const week = 1 + Math.round((dt.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Aggregate into one bar per ISO week (Mon-anchored). */
export function aggregateWeekly(bars: OHLCBar[]): OHLCBar[] {
  if (bars.length === 0) return [];
  const groups = new Map<string, OHLCBar[]>();
  const order: string[] = [];
  for (const b of bars) {
    const key = isoWeekKey(b.ts);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(b);
  }
  return order.map(k => fold(groups.get(k)!));
}

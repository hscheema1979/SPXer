/**
 * Shared Eastern Time (ET) helpers.
 *
 * All ET↔UTC conversions go through Intl.DateTimeFormat which
 * handles EST/EDT automatically. Never use the fragile
 * `new Date(toLocaleString(...))` round-trip pattern.
 */

/**
 * Get the current UTC↔ET offset in milliseconds.
 * Handles DST automatically via Intl.DateTimeFormat.
 * Returns ~14,400,000 (4h) during EDT or ~18,000,000 (5h) during EST.
 */
export function getETOffsetMs(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const etNowMs = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
  return now.getTime() - etNowMs;
}

/** Today's date in ET as YYYY-MM-DD */
export function todayET(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Current ET time as { h, m, s } */
export function nowET(now = new Date()): { h: number; m: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

/** Convert an ET time (e.g., "16:00") on today's ET date to a Unix timestamp (seconds) */
export function etTimeToUnixTs(timeET: string, now = new Date()): number {
  const date = todayET(now);
  const offsetMs = getETOffsetMs(now);
  return Math.floor((Date.parse(`${date}T${timeET}:00`) + offsetMs) / 1000);
}

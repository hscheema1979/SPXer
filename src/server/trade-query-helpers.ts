/**
 * Trade query helpers — pure functions for filtering, bucketing,
 * scaling, and aggregating trade data for the time-chunk analysis API.
 *
 * No DB dependencies — all functions take plain arrays/objects.
 */

// ── Constants ────────────────────────────────────────────────────────────────
/** Market session start in ms from midnight ET (09:30) */
export const SESSION_START_MS = (9 * 60 + 30) * 60 * 1000;
/** Market session end in ms from midnight ET (16:00) */
export const SESSION_END_MS = 16 * 60 * 60 * 1000;
/** Minimum trades for a chunk to be considered statistically reliable */
export const MIN_TRADES_THRESHOLD = 5;
/** Minimum configs in a chunk to consider it for kill-zone detection */
export const MIN_CONFIGS_FOR_KILL_ZONE = 3;

// ── Types ────────────────────────────────────────────────────────────────────
export interface TradeLike {
  entryET?: string;
  exitET?: string;
  strike: number;
  qty: number;
  entryPrice: number;
  pnlPct?: number;
  'pnl$'?: number;
  [key: string]: unknown;
}

export interface ChunkMetrics {
  totalTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
}

export interface ChunkResult extends ChunkMetrics {
  chunk: string;
  chunkLabel: string;
  dayCount: number;
  avgPnlPerDay: number;
  skipView: { totalTrades: number; totalPnl: number };
  scaleView: { totalTrades: number; totalPnl: number };
}

export interface ConfigChunkData {
  configId: string;
  name: string;
  chunk: string;
  avgPnlPerDay: number;
  winRate: number;
  tradeCount: number;
}

// ── Pure functions ───────────────────────────────────────────────────────────

/**
 * Parse ET time string "HH:MM" → ms from midnight.
 * Returns 0 for unparseable inputs.
 */
export function etToMs(et: string): number {
  const parts = et.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
  return (parts[0] * 60 + parts[1]) * 60 * 1000;
}

/**
 * Filter trades to those whose entryET falls within [activeStart, activeEnd).
 * activeStart/activeEnd are "HH:MM" ET strings.
 * Trades without entryET (using exitET fallback) are included.
 */
export function filterTradesByWindow(
  trades: TradeLike[],
  activeStart?: string,
  activeEnd?: string,
): TradeLike[] {
  if (!activeStart && !activeEnd) return trades;
  const startMs = activeStart ? etToMs(activeStart) : 0;
  const endMs = activeEnd ? etToMs(activeEnd) : SESSION_END_MS;

  return trades.filter((t) => {
    const et = t.entryET || t.exitET;
    if (!et) return true; // keep trades without time data
    const ms = etToMs(et);
    return ms >= startMs && ms < endMs;
  });
}

/**
 * Filter trades by strike range [strikeMin, strikeMax].
 * Undefined bounds are not applied.
 */
export function filterTradesByStrike(
  trades: TradeLike[],
  strikeMin?: number,
  strikeMax?: number,
): TradeLike[] {
  return trades.filter((t) => {
    if (strikeMin !== undefined && t.strike < strikeMin) return false;
    if (strikeMax !== undefined && t.strike > strikeMax) return false;
    return true;
  });
}

/**
 * Compute the scale factor for a single trade given max contracts and max dollars.
 * Returns a value in [0, 1] — 1.0 means no scaling needed.
 */
export function computeScaleFactor(
  trade: TradeLike,
  maxContracts?: number,
  maxDollarsPerTrade?: number,
): number {
  let factor = 1.0;
  if (maxContracts && trade.qty > maxContracts) {
    factor = Math.min(factor, maxContracts / trade.qty);
  }
  if (maxDollarsPerTrade && trade.entryPrice > 0 && trade.qty > 0) {
    const dollarExposure = trade.entryPrice * trade.qty * 100;
    if (dollarExposure > maxDollarsPerTrade) {
      factor = Math.min(factor, maxDollarsPerTrade / dollarExposure);
    }
  }
  return factor;
}

/**
 * Get the pnl$ value from a trade (handles both 'pnl$' and pnl$ keys).
 */
export function getPnl(trade: TradeLike): number {
  return (trade as any)['pnl$'] ?? (trade as any).pnl$ ?? 0;
}

/**
 * Apply sizing filter to trades.
 * - 'skip': remove trades exceeding max contracts or max dollar exposure
 * - 'scale': keep all trades but proportionally reduce pnl$ for oversized ones
 * Returns { trades, totalPnl } — trades may have a __scaledPnl property for scale mode.
 */
export function applySizingFilter(
  trades: TradeLike[],
  mode: 'skip' | 'scale',
  maxContracts?: number,
  maxDollarsPerTrade?: number,
): { trades: TradeLike[]; totalPnl: number } {
  if (!maxContracts && !maxDollarsPerTrade) {
    let totalPnl = 0;
    for (const t of trades) totalPnl += getPnl(t);
    return { trades, totalPnl };
  }

  const result: TradeLike[] = [];
  let totalPnl = 0;

  for (const t of trades) {
    const scaleFactor = computeScaleFactor(t, maxContracts, maxDollarsPerTrade);

    if (mode === 'skip') {
      if (scaleFactor < 1.0) continue;
      result.push(t);
      totalPnl += getPnl(t);
    } else {
      const rawPnl = getPnl(t);
      const scaledPnl = rawPnl * scaleFactor;
      result.push({ ...t, __scaledPnl: scaledPnl });
      totalPnl += scaledPnl;
    }
  }

  return { trades: result, totalPnl };
}

/**
 * Bucket trades into time chunks of `windowSizeMinutes` starting from SESSION_START_MS.
 * Returns Map<chunkKey, TradeLike[]> where chunkKey is "HH:MM-HH:MM".
 */
export function bucketTradesIntoChunks(
  trades: TradeLike[],
  windowSizeMinutes: number,
): Map<string, TradeLike[]> {
  const chunkMs = windowSizeMinutes * 60 * 1000;
  const buckets = new Map<string, TradeLike[]>();

  for (const t of trades) {
    const et = t.entryET || t.exitET;
    if (!et) continue;
    const entryMs = etToMs(et);
    if (entryMs < SESSION_START_MS || entryMs >= SESSION_END_MS) continue;

    const offset = entryMs - SESSION_START_MS;
    const chunkIdx = Math.floor(offset / chunkMs);
    const chunkStart = SESSION_START_MS + chunkIdx * chunkMs;

    const cs_h = Math.floor(chunkStart / (60 * 60 * 1000));
    const cs_m = Math.floor((chunkStart % (60 * 60 * 1000)) / (60 * 1000));
    const ce = chunkStart + chunkMs;
    const ce_h = Math.floor(ce / (60 * 60 * 1000));
    const ce_m = Math.floor((ce % (60 * 60 * 1000)) / (60 * 1000));

    const key = `${String(cs_h).padStart(2, '0')}:${String(cs_m).padStart(2, '0')}-${String(ce_h).padStart(2, '0')}:${String(ce_m).padStart(2, '0')}`;

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }

  return buckets;
}

/**
 * Compute aggregate metrics from an array of trades.
 * For scale mode, uses __scaledPnl if present.
 */
export function aggregateChunkMetrics(trades: TradeLike[]): ChunkMetrics {
  let totalPnl = 0;
  let wins = 0;
  let totalTrades = trades.length;

  for (const t of trades) {
    const pnl = (t as any).__scaledPnl !== undefined
      ? (t as any).__scaledPnl
      : getPnl(t);
    totalPnl += pnl;
    if (pnl > 0) wins++;
  }

  return {
    totalTrades,
    wins,
    winRate: totalTrades > 0 ? wins / totalTrades : 0,
    totalPnl,
    avgPnlPerTrade: totalTrades > 0 ? totalPnl / totalTrades : 0,
  };
}

/**
 * Generate a human-readable chunk label from a chunk key.
 * "09:30-10:00" → "9:30 AM"
 */
export function chunkLabel(chunkKey: string): string {
  const [start] = chunkKey.split('-');
  const [h, m] = start.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * Detect kill zones — chunks where ALL configs with ≥minTrades trades
 * have negative avgPnlPerDay, and there are ≥minConfigs configs in the chunk.
 */
export function detectKillZones(
  configChunks: ConfigChunkData[],
  minTrades: number = MIN_TRADES_THRESHOLD,
  minConfigs: number = MIN_CONFIGS_FOR_KILL_ZONE,
): string[] {
  // Group by chunk
  const byChunk = new Map<string, ConfigChunkData[]>();
  for (const cc of configChunks) {
    if (!byChunk.has(cc.chunk)) byChunk.set(cc.chunk, []);
    byChunk.get(cc.chunk)!.push(cc);
  }

  const killZones: string[] = [];
  for (const [chunk, configs] of byChunk) {
    const qualified = configs.filter((c) => c.tradeCount >= minTrades);
    if (qualified.length < minConfigs) continue;
    const allNegative = qualified.every((c) => c.avgPnlPerDay < 0);
    if (allNegative) killZones.push(chunk);
  }

  return killZones.sort();
}

/**
 * Rank top N configs per chunk by avgPnlPerDay (descending).
 */
export function findBestConfigsPerChunk(
  configChunks: ConfigChunkData[],
  topN: number = 3,
  minTrades: number = MIN_TRADES_THRESHOLD,
): ConfigChunkData[] {
  // Group by chunk
  const byChunk = new Map<string, ConfigChunkData[]>();
  for (const cc of configChunks) {
    if (!byChunk.has(cc.chunk)) byChunk.set(cc.chunk, []);
    byChunk.get(cc.chunk)!.push(cc);
  }

  const results: ConfigChunkData[] = [];
  for (const [, configs] of byChunk) {
    const qualified = configs
      .filter((c) => c.tradeCount >= minTrades)
      .sort((a, b) => b.avgPnlPerDay - a.avgPnlPerDay)
      .slice(0, topN);
    results.push(...qualified);
  }

  return results;
}

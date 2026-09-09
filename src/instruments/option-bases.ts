/**
 * The five option profiles that resolve WITHOUT a sweep-registry.json row.
 *
 * scripts/diag/sweep-symbol.ts::resolveSymbolTarget consults this table first
 * and only falls back to the registry, so anything that lists "what profiles
 * exist" from the registry alone silently omits them — that is exactly why the
 * studio Tickers page had no SPX 0DTE row. Canonical copy lives here in src/
 * because tsconfig's rootDir is src/: scripts may import from src, not the
 * other way round.
 */
export interface SymbolBase {
  symbol: string;
  optionPrefix: string;
  defaultDte: number;
  strikeInterval: number;
}

export const BASES: Record<string, SymbolBase> = {
  SPX: { symbol: 'SPX', optionPrefix: 'SPXW', defaultDte: 0, strikeInterval: 5 },
  SPY: { symbol: 'SPY', optionPrefix: 'SPY', defaultDte: 0, strikeInterval: 1 },
  QQQ: { symbol: 'QQQ', optionPrefix: 'QQQ', defaultDte: 0, strikeInterval: 1 },
  XSP: { symbol: 'XSP', optionPrefix: 'XSP', defaultDte: 0, strikeInterval: 1 },
  NDX: { symbol: 'NDX', optionPrefix: 'NDXP', defaultDte: 0, strikeInterval: 10 },
};

/** Cash indices carry wider OI than ETFs — drives the liquid width caps. */
export const INDEX_SYMBOLS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'XSP']);

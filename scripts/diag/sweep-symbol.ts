/**
 * sweep-symbol.ts — shared underlying resolution for credit-spread-sweep.ts
 * and iron-sweep.ts so the same sweep runs on SPX, SPY, or QQQ.
 *
 * SPX path is preserved exactly (binary .brc cache for speed). SPY/QQQ load
 * directly from parquet via loadBarCacheFromParquetSync (no .brc — the cache
 * filename scheme is SPX-only and we must not collide with it).
 *
 * Output files are namespaced per symbol so an ETF sweep never clobbers the
 * SPX viewer data:
 *   SPX → spread-sweep.json        (unchanged — default viewer)
 *   SPY → spread-sweep-spy.json
 *   QQQ → spread-sweep-qqq.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { readBarCacheFile } from '../../src/replay/bar-cache-file';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';
import { buildSymbolRange } from '../../src/replay/metrics';

export interface SymbolTarget {
  symbol: string;          // 'SPX' | 'SPY' | 'QQQ'
  dte: number;             // 0 | 1
  profileId: string;       // parquet dir: 'spx-0dte' | 'spy-1dte' | …
  optionPrefix: string;    // OCC root: 'SPXW' | 'SPY' | 'QQQ'
  outSuffix: string;       // '' for SPX-0dte (legacy), else '-{sym}[-{n}dte]'
  strikeInterval: number;  // $ between adjacent strikes: SPX 5, SPY/QQQ 1, NDX 10
}

interface SymbolBase { symbol: string; optionPrefix: string; defaultDte: number; strikeInterval: number }
const BASES: Record<string, SymbolBase> = {
  SPX: { symbol: 'SPX', optionPrefix: 'SPXW', defaultDte: 0, strikeInterval: 5 },
  SPY: { symbol: 'SPY', optionPrefix: 'SPY',  defaultDte: 0, strikeInterval: 1 },
  QQQ: { symbol: 'QQQ', optionPrefix: 'QQQ',  defaultDte: 0, strikeInterval: 1 },
  NDX: { symbol: 'NDX', optionPrefix: 'NDXP', defaultDte: 0, strikeInterval: 10 },
};

/**
 * Instrument class drives the LIQUID width caps in the sweeps (ETF has a tight
 * 1–5 strike liquid range; an index carries wider OI). Geometry itself is
 * always strike-COUNT × strikeInterval, so NDX ($10) vs QQQ ($1) already scale
 * correctly — class only bounds how wide we sweep. Sourced from
 * sweep-registry.json so adding a ticker is declarative; falls back to a
 * sensible heuristic (known cash indices = index, everything else = etf) if
 * the registry has no entry yet.
 */
const INDEX_SYMBOLS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'XSP']);
export function instrumentClass(t: { symbol: string; dte: number }): 'index' | 'etf' {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sweep-registry.json'), 'utf8'));
    const hit = (reg.profiles || []).find((p: any) => p.symbol === t.symbol && p.dte === t.dte)
             || (reg.profiles || []).find((p: any) => p.symbol === t.symbol);
    if (hit && (hit.class === 'index' || hit.class === 'etf')) return hit.class;
  } catch { /* registry optional */ }
  return INDEX_SYMBOLS.has(t.symbol) ? 'index' : 'etf';
}

/**
 * Blocker-3 fix: synthesize a SymbolBase from sweep-registry.json for any
 * ticker NOT in the hardcoded BASES table. Returns undefined if the registry
 * has no entry for that symbol (caller then throws a helpful error).
 */
function registrySymbolBase(symbol: string): SymbolBase | undefined {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sweep-registry.json'), 'utf8'));
    const p = (reg.profiles || []).find((x: any) => String(x.symbol).toUpperCase() === symbol);
    if (!p) return undefined;
    return {
      symbol,
      optionPrefix: p.optionPrefix || symbol,
      defaultDte: Number.isFinite(p.dte) ? p.dte : 0,
      strikeInterval: Number(p.strikeInterval) || 1,
    };
  } catch { return undefined; }
}

/**
 * Resolve --symbol [--dte N] from argv. profileId = `{sym}-{dte}dte`
 * (matches the parquet partition dirs). outSuffix keeps SPX-0dte writing the
 * legacy unsuffixed viewer file; everything else is namespaced.
 */
export function resolveSymbolTarget(argv: string[]): SymbolTarget {
  const sFlag = argv.find(a => a.startsWith('--symbol='));
  const sIdx = argv.indexOf('--symbol');
  const rawSym = sFlag ? sFlag.split('=')[1] : (sIdx >= 0 ? argv[sIdx + 1] : 'SPX');
  const key = (rawSym || 'SPX').toUpperCase();
  // BASES is the fast path for the 4 hardcoded profiles. For any other ticker
  // synthesize a SymbolBase from sweep-registry.json so a registered ticker
  // needs ZERO code edits here (Blocker 3 fix).
  const base = BASES[key] || registrySymbolBase(key);
  if (!base) throw new Error(`Unknown --symbol ${rawSym}. Add it to sweep-registry.json (and BASES for a fast path).`);

  const dFlag = argv.find(a => a.startsWith('--dte='));
  const dIdx = argv.indexOf('--dte');
  const rawDte = dFlag ? dFlag.split('=')[1] : (dIdx >= 0 ? argv[dIdx + 1] : undefined);
  const dte = rawDte != null ? parseInt(rawDte, 10) : base.defaultDte;
  if (!Number.isFinite(dte) || dte < 0) throw new Error(`Bad --dte ${rawDte}`);

  const lower = base.symbol.toLowerCase();
  const profileId = `${lower}-${dte}dte`;
  // SPX-0dte keeps the original unsuffixed output (default viewer dataset).
  const outSuffix = (key === 'SPX' && dte === 0)
    ? ''
    : `-${lower}${dte === 0 ? '' : `-${dte}dte`}`;
  return { symbol: base.symbol, dte, profileId, optionPrefix: base.optionPrefix, outSuffix, strikeInterval: base.strikeInterval };
}

/** List trading dates available in this symbol's parquet dir. */
export function listDatesFor(t: SymbolTarget): string[] {
  const dir = path.join(process.cwd(), 'data/parquet/bars', t.profileId);
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map(f => f.slice(0, 10))
    .sort();
  // SWEEP_DAYS=N → only the most-recent N trading days. credit-spread-sweep,
  // iron-sweep AND concurrent-distribution all import this fn, so the subset
  // stays identical across them — used to validate the whole pipeline before
  // committing to a full multi-month regen.
  const n = parseInt(process.env.SWEEP_DAYS || '', 10);
  if (Number.isFinite(n) && n > 0 && n < all.length) return all.slice(-n);
  return all;
}

/**
 * Load one day's bar cache for the target symbol. Returns the same shape the
 * sweeps already consume: { spxBars, contractBars, contractStrikes }.
 * `spxBars` is the underlying series regardless of symbol (legacy field name).
 */
// Weekend-aware next-trading-day (holidays not modeled — matches backfill).
function expiryForDate(date: string, dte: number): string {
  if (dte <= 0) return date;
  const dt = new Date(date + 'T12:00:00Z');
  let added = 0;
  while (added < dte) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return dt.toISOString().slice(0, 10);
}

export function loadDay(t: SymbolTarget, date: string, tf: string): any {
  if (t.symbol === 'SPX' && t.dte === 0) {
    // Preserve the fast .brc cached path for SPX 0DTE only.
    return readBarCacheFile(date, tf, true) as any;
  }
  const fp = path.join(process.cwd(), 'data/parquet/bars', t.profileId, `${date}.parquet`);
  if (!fs.existsSync(fp)) return null;
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const dayEnd = dayStart + 86400 - 1;
  // Contract symbols embed the EXPIRY date. For 1DTE that's the next trading
  // day, not the trade date — build the range off the expiry.
  const range = buildSymbolRange(expiryForDate(date, t.dte), t.optionPrefix);
  return loadBarCacheFromParquetSync({
    profileId: t.profileId,
    date,
    underlyingSymbol: t.symbol,
    symbolRange: { lo: range.lo, hi: range.hi },
    timeframe: tf,
    startTs: dayStart,
    endTs: dayEnd,
    skipContractIndicators: true,
  });
}

/** Per-symbol output path: SPX keeps the original name, ETFs get a suffix. */
export function outPath(base: string, t: SymbolTarget): string {
  // base e.g. 'scripts/autoresearch/output/spread-sweep.json'
  const ext = path.extname(base);
  const stem = base.slice(0, -ext.length);
  return `${stem}${t.outSuffix}${ext}`;
}

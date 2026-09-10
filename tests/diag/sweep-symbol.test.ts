/**
 * Phase-1 regression guard: data-driven symbol resolution.
 *
 * Proves the "zero code edits to onboard a new ticker" contract:
 *   - the 4 hardcoded BASES profiles still resolve byte-identically
 *     (SPX-0dte MUST keep the legacy unsuffixed output path),
 *   - a ticker present ONLY in sweep-registry.json (not in BASES) resolves
 *     via the registry-synthesized SymbolBase,
 *   - a truly unknown ticker throws a helpful error,
 *   - instrumentClass() reads the registry, falling back to the cash-index
 *     heuristic when the registry has no entry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, instrumentClass, listDatesFor, resolveDayFile, histProfileId, histEnabled, expiryForDate } from '../../scripts/diag/sweep-symbol';

const REGISTRY = path.join(__dirname, '../../scripts/diag/sweep-registry.json');

/** Snapshot the registry bytes and restore them after a mutation test. */
function withTempRegistryProfile<T>(profile: Record<string, unknown>, fn: () => T): T {
  const original = fs.readFileSync(REGISTRY, 'utf8');
  try {
    const j = JSON.parse(original);
    j.profiles = [...j.profiles, profile];
    fs.writeFileSync(REGISTRY, JSON.stringify(j, null, 2) + '\n');
    return fn();
  } finally {
    fs.writeFileSync(REGISTRY, original); // exact byte restore
  }
}

describe('resolveSymbolTarget — hardcoded BASES (must stay stable)', () => {
  it('SPX-0dte keeps the legacy unsuffixed output path', () => {
    const t = resolveSymbolTarget(['--symbol', 'SPX']);
    expect(t).toMatchObject({
      symbol: 'SPX', dte: 0, profileId: 'spx-0dte',
      optionPrefix: 'SPXW', outSuffix: '', strikeInterval: 5,
    });
  });

  it('NDX resolves to the nominal $10 index profile (real grid derived per-expiry at sweep time)', () => {
    const t = resolveSymbolTarget(['--symbol', 'NDX']);
    expect(t).toMatchObject({ optionPrefix: 'NDXP', strikeInterval: 10, profileId: 'ndx-0dte' });
  });

  it('QQQ --dte 1 is namespaced (cannot collide with SPX files)', () => {
    const t = resolveSymbolTarget(['--symbol', 'QQQ', '--dte', '1']);
    expect(t).toMatchObject({
      symbol: 'QQQ', dte: 1, profileId: 'qqq-1dte',
      optionPrefix: 'QQQ', outSuffix: '-qqq-1dte', strikeInterval: 1,
    });
  });

  it('supports --symbol=X and --dte=N equals syntax', () => {
    const t = resolveSymbolTarget(['--symbol=SPY', '--dte=1']);
    expect(t).toMatchObject({ symbol: 'SPY', dte: 1, profileId: 'spy-1dte' });
  });

  it('rejects a negative / non-numeric dte', () => {
    expect(() => resolveSymbolTarget(['--symbol', 'SPX', '--dte', 'x'])).toThrow(/Bad --dte/);
  });
});

describe('resolveSymbolTarget — registry-synthesized base (Phase 1 enabler)', () => {
  it('resolves a ticker present ONLY in the registry, no BASES edit', () => {
    const t = withTempRegistryProfile(
      { symbol: 'ZZZX', dte: 1, class: 'etf', strikeInterval: 1, optionPrefix: 'ZZZX', protected: false },
      () => resolveSymbolTarget(['--symbol', 'ZZZX', '--dte', '1']),
    );
    expect(t).toMatchObject({
      symbol: 'ZZZX', dte: 1, profileId: 'zzzx-1dte',
      optionPrefix: 'ZZZX', strikeInterval: 1, outSuffix: '-zzzx-1dte',
    });
  });

  it('throws a helpful error for a ticker absent from BOTH BASES and registry', () => {
    expect(() => resolveSymbolTarget(['--symbol', 'NOPE']))
      .toThrow(/Unknown --symbol NOPE.*sweep-registry\.json/s);
  });
});

describe('instrumentClass — registry-driven with heuristic fallback', () => {
  it('reads class from the registry for known profiles', () => {
    expect(instrumentClass({ symbol: 'SPX', dte: 0 })).toBe('index');
    expect(instrumentClass({ symbol: 'SPY', dte: 1 })).toBe('etf');
  });

  it('falls back to the cash-index heuristic when registry has no entry', () => {
    expect(instrumentClass({ symbol: 'RUT', dte: 0 })).toBe('index'); // known cash index
    expect(instrumentClass({ symbol: 'NVDA', dte: 0 })).toBe('etf');  // single stock → etf width caps
  });

  it('honors a registry class override for a synthesized ticker', () => {
    const cls = withTempRegistryProfile(
      { symbol: 'ZZZX', dte: 0, class: 'index', strikeInterval: 5, optionPrefix: 'ZZZX', protected: false },
      () => instrumentClass({ symbol: 'ZZZX', dte: 0 }),
    );
    expect(cls).toBe('index');
  });
});

/**
 * Archive-profile reach (docs/DATA-STORES.md open item 1). Builds a throwaway
 * PARQUET_ROOT with a live profile and its `-hist` archive; file contents are
 * irrelevant to date listing / file resolution, so empty files suffice.
 */
describe('spx-0dte-hist archive fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-symbol-hist-'));
  const mk = (profile: string, date: string) => {
    fs.mkdirSync(path.join(root, profile), { recursive: true });
    fs.writeFileSync(path.join(root, profile, `${date}.parquet`), '');
  };
  mk('spx-0dte', '2025-03-27'); mk('spx-0dte', '2026-09-09');
  mk('spx-0dte-hist', '2022-09-01'); mk('spx-0dte-hist', '2025-03-26');
  mk('spx-0dte-hist', '2025-03-27'); // overlap: live must win
  const T = resolveSymbolTarget(['--symbol', 'SPX']);
  const saved = { root: process.env.PARQUET_ROOT, hist: process.env.SWEEP_HIST, days: process.env.SWEEP_DAYS };
  const setEnv = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => { setEnv('PARQUET_ROOT', saved.root); setEnv('SWEEP_HIST', saved.hist); setEnv('SWEEP_DAYS', saved.days); });

  it('histProfileId appends -hist', () => {
    expect(histProfileId('spx-0dte')).toBe('spx-0dte-hist');
  });

  it('histEnabled requires SWEEP_HIST=1 exactly', () => {
    expect(histEnabled({})).toBe(false);
    expect(histEnabled({ SWEEP_HIST: 'true' })).toBe(false);
    expect(histEnabled({ SWEEP_HIST: '1' })).toBe(true);
  });

  it('listDatesFor is the live profile only by default (nightly incremental sweeps unchanged)', () => {
    setEnv('PARQUET_ROOT', root); setEnv('SWEEP_HIST', undefined); setEnv('SWEEP_DAYS', undefined);
    expect(listDatesFor(T)).toEqual(['2025-03-27', '2026-09-09']);
  });

  it('listDatesFor merges the archive under SWEEP_HIST=1, sorted and de-duplicated', () => {
    setEnv('PARQUET_ROOT', root); setEnv('SWEEP_HIST', '1'); setEnv('SWEEP_DAYS', undefined);
    expect(listDatesFor(T)).toEqual(['2022-09-01', '2025-03-26', '2025-03-27', '2026-09-09']);
  });

  it('SWEEP_DAYS still slices the merged list from the newest end', () => {
    setEnv('PARQUET_ROOT', root); setEnv('SWEEP_HIST', '1'); setEnv('SWEEP_DAYS', '2');
    expect(listDatesFor(T)).toEqual(['2025-03-27', '2026-09-09']);
  });

  it('resolveDayFile prefers the live profile, falls back to -hist, else null (always on)', () => {
    setEnv('PARQUET_ROOT', root); setEnv('SWEEP_HIST', undefined);
    expect(resolveDayFile(T, '2025-03-27')?.profileId).toBe('spx-0dte');   // overlap → live wins
    expect(resolveDayFile(T, '2022-09-01')?.profileId).toBe('spx-0dte-hist');
    expect(resolveDayFile(T, '2022-09-01')?.fp).toBe(path.join(root, 'spx-0dte-hist', '2022-09-01.parquet'));
    expect(resolveDayFile(T, '2021-01-04')).toBeNull();
  });
});

describe('expiryForDate — holiday-aware (must match the backfill)', () => {
  it('0DTE expires on the trade date', () => {
    expect(expiryForDate('2026-09-04', 0)).toBe('2026-09-04');
  });
  it('1DTE on the Friday before Labor Day 2026 is Tuesday 09-08, not the holiday Monday', () => {
    expect(expiryForDate('2026-09-04', 1)).toBe('2026-09-08');
  });
  it('1DTE skips a plain weekend', () => {
    expect(expiryForDate('2026-09-11', 1)).toBe('2026-09-14');
  });
  it('honours an injected holiday set', () => {
    expect(expiryForDate('2026-09-10', 1, new Set(['2026-09-11']))).toBe('2026-09-14');
    expect(expiryForDate('2026-09-10', 1, new Set())).toBe('2026-09-11');
  });
});

afterEach(() => {
  // Defensive: ensure no test left a synthesized profile behind.
  const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  expect(j.profiles.some((p: { symbol: string }) => p.symbol === 'ZZZX')).toBe(false);
});

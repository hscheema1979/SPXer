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
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, instrumentClass } from '../../scripts/diag/sweep-symbol';

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

afterEach(() => {
  // Defensive: ensure no test left a synthesized profile behind.
  const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  expect(j.profiles.some((p: { symbol: string }) => p.symbol === 'ZZZX')).toBe(false);
});

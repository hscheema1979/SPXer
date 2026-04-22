/**
 * Tests for the instrument registry and profile shape.
 *
 * These tests validate:
 *   1. The SPX profile is registered and discoverable.
 *   2. Registry invariants (unique id, unique accountId) work.
 *   3. The SPX profile's structural facts match what spx_agent.ts hardcodes,
 *      so when Phase 2 migrates the agent onto the registry, behavior is
 *      byte-identical.
 */
import { describe, it, expect } from 'vitest';
import {
  getProfile,
  requireProfile,
  listProfiles,
  profileForAccount,
  canGoLive,
  SPX_0DTE_PROFILE,
  SPY_1DTE_PROFILE,
} from '../../src/instruments';

describe('instrument registry', () => {
  it('lists at least the SPX 0DTE and SPY 1DTE profiles', () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('spx-0dte');
    expect(ids).toContain('spy-1dte');
  });

  it('getProfile returns undefined for unknown ids', () => {
    expect(getProfile('does-not-exist')).toBeUndefined();
  });

  it('requireProfile throws for unknown ids with a helpful message', () => {
    expect(() => requireProfile('does-not-exist')).toThrow(/Unknown profile id/);
  });

  it('requireProfile returns the SPX profile for spx-0dte', () => {
    const p = requireProfile('spx-0dte');
    expect(p.id).toBe('spx-0dte');
    expect(p).toBe(SPX_0DTE_PROFILE);
  });

  it('profileForAccount finds SPX by its account id', () => {
    const accountId = SPX_0DTE_PROFILE.execution.accountId!;
    const p = profileForAccount(accountId);
    expect(p?.id).toBe('spx-0dte');
  });

  it('canGoLive: SPX with account → true; SPY without → false', () => {
    expect(canGoLive(SPX_0DTE_PROFILE)).toBe(true);
    expect(canGoLive(SPY_1DTE_PROFILE)).toBe(false);
  });

  it('SPY 1DTE has no accountId (backtest-only placeholder)', () => {
    expect(SPY_1DTE_PROFILE.execution.accountId).toBeUndefined();
  });
});

describe('SPX 0DTE profile — parity with spx_agent.ts hardcoded values', () => {
  it('uses SPXW as option prefix', () => {
    expect(SPX_0DTE_PROFILE.options.prefix).toBe('SPXW');
  });

  it('uses strikeDivisor=1, strikeInterval=5', () => {
    expect(SPX_0DTE_PROFILE.options.strikeDivisor).toBe(1);
    expect(SPX_0DTE_PROFILE.options.strikeInterval).toBe(5);
  });

  it('underlyingSymbol is SPX', () => {
    expect(SPX_0DTE_PROFILE.execution.underlyingSymbol).toBe('SPX');
  });

  it('routes to the margin account (env override or default 6YA51425)', () => {
    // spx_agent.ts:74 —  process.env.TRADIER_ACCOUNT_ID || '6YA51425'
    const expected = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
    expect(SPX_0DTE_PROFILE.execution.accountId).toBe(expected);
  });

  it('has a defined accountId (SPX is live-capable)', () => {
    expect(SPX_0DTE_PROFILE.execution.accountId).toBeDefined();
    expect(SPX_0DTE_PROFILE.execution.accountId).not.toBe('');
  });

  it('offers daily expiries (0DTE)', () => {
    expect(SPX_0DTE_PROFILE.offeredExpiryCadences).toContain('daily');
  });

  it('has two-phase stream setup at 08:00 / 09:30 ET', () => {
    expect(SPX_0DTE_PROFILE.streamPhases?.phase1StartET).toBe('08:00');
    expect(SPX_0DTE_PROFILE.streamPhases?.phase2LockET).toBe('09:30');
  });

  it('uses ±$100 sticky band', () => {
    expect(SPX_0DTE_PROFILE.bandWidthDollars).toBe(100);
  });

  it('base timeframe is 1m', () => {
    expect(SPX_0DTE_PROFILE.baseTimeframe).toBe('1m');
  });
});

/**
 * The Length control has to reach the engines. It used to reach only the
 * shares engine (--start/--end) and be dropped for long-option, so every
 * option run swept the profile's entire history regardless of what the dialog
 * said. These tests pin the argv both engines actually get.
 */
import { describe, it, expect } from 'vitest';
import { buildArgs, resolveWindow, datesInWindow } from '../../scripts/backtest-lab/engines.ts';
import { defaultSpec, specToRunRequest, type BacktestSpec } from '../../scripts/backtest-lab/contract.ts';
import { coverageFor } from '../../scripts/backtest-lab/capabilities.ts';

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('resolveWindow', () => {
  it('passes an explicit range through untouched', () => {
    expect(resolveWindow('spx-0dte', { startDate: '2026-08-01', endDate: '2026-09-05' }))
      .toEqual({ from: '2026-08-01', to: '2026-09-05' });
  });

  it('"all" and a missing preset mean no window', () => {
    expect(resolveWindow('spx-0dte', { lengthPreset: 'all' })).toEqual({});
    expect(resolveWindow('spx-0dte', {})).toEqual({});
  });

  it('anchors a preset to the profile last date, not today', () => {
    const cov = coverageFor('spx-0dte');
    if (!cov) return; // no parquet on this box → nothing to anchor to
    const w = resolveWindow('spx-0dte', { lengthPreset: '3m' });
    expect(w.to).toBe(cov.lastDate);
    expect(w.from! < w.to!).toBe(true);
    // ytd starts on Jan 1 of the last date's year
    expect(resolveWindow('spx-0dte', { lengthPreset: 'ytd' }).from)
      .toBe(`${cov.lastDate.slice(0, 4)}-01-01`);
  });
});

describe('buildArgs — shares', () => {
  it('sends the range as --start/--end', () => {
    const spec = defaultSpec('shares') as BacktestSpec;
    spec.length = { mode: 'range', from: '2026-04-01', to: '2026-05-22' };
    const { args } = buildArgs(specToRunRequest(spec), 'job-test');
    expect(argOf(args, '--start')).toBe('2026-04-01');
    expect(argOf(args, '--end')).toBe('2026-05-22');
  });

  it('sends no date flags for the "all" preset', () => {
    const spec = defaultSpec('shares') as BacktestSpec;
    spec.length = { mode: 'preset', preset: 'all' };
    const { args } = buildArgs(specToRunRequest(spec), 'job-test');
    expect(args).not.toContain('--start');
    expect(args).not.toContain('--end');
  });
});

describe('buildArgs — long-option', () => {
  const spx = coverageFor('spx-0dte');

  it.skipIf(!spx)('turns a range into an explicit --dates list', () => {
    const spec = defaultSpec('long-option') as BacktestSpec;
    const all = datesInWindow('spx-0dte', {});
    const window = { from: all[all.length - 10], to: all[all.length - 1] };
    spec.length = { mode: 'range', ...window };
    const { args } = buildArgs(specToRunRequest(spec), 'job-test');
    const dates = argOf(args, '--dates')!.split(',');
    expect(dates.length).toBe(10);          // NOT the whole history
    expect(dates[0]).toBe(window.from);
    expect(dates[dates.length - 1]).toBe(window.to);
  });

  it.skipIf(!spx)('omits --dates for the "all" preset', () => {
    const spec = defaultSpec('long-option') as BacktestSpec;
    spec.length = { mode: 'preset', preset: 'all' };
    const { args } = buildArgs(specToRunRequest(spec), 'job-test');
    expect(args).not.toContain('--dates');
  });

  it.skipIf(!spx)('throws rather than silently sweeping everything on an empty window', () => {
    const spec = defaultSpec('long-option') as BacktestSpec;
    spec.length = { mode: 'range', from: '1990-01-01', to: '1990-01-31' };
    expect(() => buildArgs(specToRunRequest(spec), 'job-test')).toThrow(/no spx-0dte dates/);
  });
});

/**
 * Unit tests for sweep-params.ts — structured row params + profit factor
 * (FR-002 / OA Phase 0) and the annotate-sweep-params backfill behavior.
 *
 * The label fixtures below are real labels the credit/iron engines emit
 * (see SIGNALS/SPREADS/STRUCTURES/EXITS in credit-spread-sweep.ts and
 * iron-sweep.ts). The parsed shape must mirror optionx's ParsedSignal /
 * ParsedSpread / ParsedExit exactly — that equality is what lets the promote
 * mapper prefer row.params over its own regex with identical output.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  parseSweepRowParams, parseSignal, parseSpread, parseExit, profitFactor, accumulatePf,
} from '../../scripts/diag/sweep-params';

describe('parseSignal — engine label fixtures', () => {
  it('multi-TF intraday (double-space collapses)', () => {
    const p = parseSignal('HMA  2+3+5 3x12')!;
    expect(p).toMatchObject({
      kind: 'intraday', indicator: 'HMA', timeframes: ['2m', '3m', '5m'],
      hmaFast: 3, hmaSlow: 12, trigger: 'cross', swingTf: 'daily',
    });
  });

  it('single-TF DEMA', () => {
    const p = parseSignal('DEMA 1m 3x9')!;
    expect(p).toMatchObject({ kind: 'intraday', indicator: 'DEMA', timeframes: ['1m'], hmaFast: 3, hmaSlow: 9, trigger: 'cross' });
  });

  it('state trigger + entry window suffix', () => {
    const p = parseSignal('HMA 3m 3x12 st 10:00-10:30')!;
    expect(p).toMatchObject({ trigger: 'state', gateStart: '10:00', gateEnd: '10:30', hmaFast: 3, hmaSlow: 12 });
  });

  it('time signal', () => {
    expect(parseSignal('1pm daily')).toMatchObject({ kind: 'time', entryTimeET: '13:00', direction: 'bullish' });
  });
});

describe('parseSpread — engine label fixtures', () => {
  it('credit spread ITM/OTM/ATM', () => {
    expect(parseSpread('15ITM w10')).toEqual({ kind: 'creditSpread', shortOffset: -15, width: 10 });
    expect(parseSpread('10OTM w5')).toEqual({ kind: 'creditSpread', shortOffset: 10, width: 5 });
    expect(parseSpread('ATM w5')).toEqual({ kind: 'creditSpread', shortOffset: 0, width: 5 });
  });

  it('directional iron butterfly (the live bot\'s shape)', () => {
    expect(parseSpread('IB±25 w10')).toEqual({
      kind: 'iron', engineKind: 'butterfly', centerOffset: 25, wingWidth: 10, shortOffset: 0,
    });
  });

  it('static butterfly', () => {
    expect(parseSpread('IB w10')).toEqual({
      kind: 'iron', engineKind: 'butterfly', centerOffset: 0, wingWidth: 10, shortOffset: 0,
    });
  });

  it('static condor — space form the optionx regex never matched', () => {
    expect(parseSpread('IC 20w10')).toEqual({
      kind: 'iron', engineKind: 'condor', centerOffset: 0, shortOffset: 20, wingWidth: 10,
    });
  });
});

describe('parseExit — engine label fixtures', () => {
  it('TP only / flip / hold', () => {
    expect(parseExit('TP75 only')).toEqual({ tpFrac: 0.75, slMult: 0, useFlip: false });
    expect(parseExit('TP10 +flip')).toEqual({ tpFrac: 0.1, slMult: 0, useFlip: true });
    expect(parseExit('hold-to-settle')).toEqual({ tpFrac: 0, slMult: 0, useFlip: false });
    expect(parseExit('flip only')).toEqual({ tpFrac: 0, slMult: 0, useFlip: true });
  });

  it('risk-fraction SL (backtest-only — refused live, never mis-mapped)', () => {
    expect(parseExit('TP10 SL70%')).toEqual({ tpFrac: 0.1, slMult: 0, slRiskFrac: 0.7, useFlip: false });
  });

  it('long-form TP/SL and multiplier SL', () => {
    expect(parseExit('TP50/SL25 only')).toEqual({ tpFrac: 0.5, slPct: 0.25, slMult: 0, useFlip: false, isLong: true });
    expect(parseExit('TP10 SL1.5x')).toEqual({ tpFrac: 0.1, slMult: 1.5, useFlip: false });
  });
});

describe('parseSweepRowParams + profitFactor', () => {
  it('full row parse', () => {
    const p = parseSweepRowParams('HMA  2m 3x12', '15ITM w10', 'TP10 only')!;
    expect(p.signal.hmaSlow).toBe(12);
    expect(p.spread).toEqual({ kind: 'creditSpread', shortOffset: -15, width: 10 });
    expect(p.exit).toEqual({ tpFrac: 0.1, slMult: 0, useFlip: false });
  });

  it('any unparsable label → null (row stays label-only)', () => {
    expect(parseSweepRowParams('GARBAGE', '15ITM w10', 'TP10 only')).toBeNull();
    expect(parseSweepRowParams('HMA  2m 3x12', '??', 'TP10 only')).toBeNull();
  });

  it('pf math: null on zero losses / no trades, rounded otherwise', () => {
    expect(profitFactor(100, 0)).toBeNull();
    expect(profitFactor(0, 0)).toBeNull();
    expect(profitFactor(300, 100)).toBe(3);
    expect(profitFactor(1, 3)).toBe(0.33);
  });

  it('accumulatePf splits winners/losers, ignores scratches', () => {
    const acc = { gw: 0, gl: 0 };
    for (const p of [50, -20, 0, 100, -30]) accumulatePf(acc, p);
    expect(acc).toEqual({ gw: 150, gl: 50 });
    expect(profitFactor(acc.gw, acc.gl)).toBe(3);
  });
});

describe('annotate-sweep-params backfill (fixture round-trip)', () => {
  function run(tmp: string) {
    execSync('npx tsx scripts/diag/annotate-sweep-params.ts', {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, ANNOTATE_OUT_DIR: tmp },
      stdio: 'pipe',
    });
  }

  it('stamps params on every parseable row and pf from trade files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-annot-'));
    try {
      const rows = [
        { signal: 'HMA  2m 3x12', spread: '15ITM w10', exit: 'TP10 only', pnl: 100, n: 2 },
        { signal: 'HMA  1m 3x9', spread: 'IB±25 w10', exit: 'TP75 only', pnl: -50, n: 2 },
        { signal: 'NOT A SIGNAL', spread: 'IB w10', exit: 'TP10 only', pnl: 0, n: 0 },
      ];
      fs.writeFileSync(path.join(tmp, 'spread-sweep.json'), JSON.stringify(rows));
      // per-trade files for the first variant only → pf there, null elsewhere
      const slug = 'HMA  2m 3x12|15ITM w10|TP10 only'.replace(/[|]/g, '__').replace(/\s+/g, '_');
      const tdir = path.join(tmp, 'spread-trades', slug);
      fs.mkdirSync(tdir, { recursive: true });
      fs.writeFileSync(path.join(tdir, '2025-09-18.json'),
        JSON.stringify({ date: '2025-09-18', trades: [{ pnlNet: 60 }, { pnlNet: -20 }] }));

      run(tmp);

      const out = JSON.parse(fs.readFileSync(path.join(tmp, 'spread-sweep.json'), 'utf8'));
      expect(out).toHaveLength(3);
      expect(out[0].params.exit).toEqual({ tpFrac: 0.1, slMult: 0, useFlip: false });
      expect(out[0].pf).toBe(3);                       // 60 / 20 from trade files
      expect(out[1].params.spread.engineKind).toBe('butterfly');
      expect(out[1].pf).toBeNull();                    // no trade files for this slug
      expect(out[2].params).toBeUndefined();           // unparsable signal stays bare
      expect(out[2].pf).toBeNull();
      // idempotent: second run produces byte-identical output
      const first = fs.readFileSync(path.join(tmp, 'spread-sweep.json'), 'utf8');
      run(tmp);
      expect(fs.readFileSync(path.join(tmp, 'spread-sweep.json'), 'utf8')).toBe(first);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

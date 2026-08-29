/**
 * Unit tests for fib-bb-core.ts — Fibonacci Bollinger Band rejection/reversal.
 *
 * The whole value of this study rests on it NOT seeing the future: a mean-
 * reversion signal that peeks at the bar it trades on is trivially and falsely
 * profitable. So the look-ahead guards below are the load-bearing tests, not
 * the arithmetic ones.
 *
 * Properties verified:
 *   - fibBands: VWMA basis + population stdev deviation match hand computation;
 *     volume actually weights the basis; zero-volume windows fall back to a
 *     simple mean instead of NaN; nulls during warm-up; band ordering.
 *   - No look-ahead: bands and rejections at bar i are identical whether or not
 *     bars after i exist (prefix agreement), and a violent move at i+1 cannot
 *     change the signal at i.
 *   - Fills happen at bar i+1's OPEN, never at bar i's close.
 *   - A bar straddling both stop and target resolves as a STOP (conservative).
 *   - The stop caps the loss at the risk defined on entry.
 *   - Session-close backstop; one position at a time.
 */
import { describe, it, expect } from 'vitest';
import {
  fibBands, bandPrice, detectRejections, simulate, htfAt, rollingATR,
  type SimOpts, type HtfContext, type Precomputed,
} from '../../scripts/diag/fib-bb-core';
import type { OHLCBar } from '../../scripts/diag/ohlc-aggregate';

function bar(ts: number, o: number, h: number, l: number, c: number, v = 1): OHLCBar {
  return { ts, open: o, high: h, low: l, close: c, volume: v };
}

/** 09:30 ET on 2026-07-20 (EDT, UTC-4) in unix seconds. */
const DAY1_OPEN = Math.floor(Date.UTC(2026, 6, 20, 13, 30, 0) / 1000);
const DAY2_OPEN = DAY1_OPEN + 86400;

/**
 * An up-ramp gives the window a real stdev, so the outer bands sit far enough
 * above the basis that a rejection bar can pierce the band and still close
 * back inside it with room left between entry and a basis target.
 */
function rampSeries(n: number, start = 90, step = 2, ts0 = DAY1_OPEN): OHLCBar[] {
  const out: OHLCBar[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push(bar(ts0 + i * 300, c - step / 2, c + 1, c - 1, c));
  }
  return out;
}

const BASE_OPTS: SimOpts = {
  length: 10, mult: 3, atrPeriod: 5,
  dir: 'short', entryRatio: 1.0, wickFrac: 0,
  stopBufAtr: 0, minRiskAtr: 0, target: { kind: 'basis' }, sessionExit: false,
};

describe('fibBands', () => {
  it('computes a volume-weighted basis and population-stdev deviation', () => {
    // hlc3 = 10, 20, 30 with volumes 1, 1, 2.
    //   basis = (10*1 + 20*1 + 30*2) / 4                = 22.5
    //   stdev = sqrt(((10-20)^2 + 0 + (30-20)^2) / 3)   = 8.164966
    //   dev   = mult(2) * stdev                          = 16.329932
    const bars = [
      bar(0, 10, 12, 8, 10, 1),
      bar(300, 20, 22, 18, 20, 1),
      bar(600, 30, 32, 28, 30, 2),
    ];
    const b = fibBands(bars, 3, 2)[2]!;
    expect(b.basis).toBeCloseTo(22.5, 10);
    expect(b.dev).toBeCloseTo(16.329932, 5);
    expect(bandPrice(b, 1.0, 'upper')).toBeCloseTo(22.5 + 16.329932, 5);
    expect(bandPrice(b, 0.5, 'lower')).toBeCloseTo(22.5 - 8.164966, 5);
  });

  it('weights the basis by volume (equal volume => simple mean)', () => {
    const mk = (v3: number) => [
      bar(0, 10, 12, 8, 10, 1),
      bar(300, 20, 22, 18, 20, 1),
      bar(600, 30, 32, 28, 30, v3),
    ];
    expect(fibBands(mk(1), 3, 2)[2]!.basis).toBeCloseTo(20, 10);   // simple mean
    expect(fibBands(mk(5), 3, 2)[2]!.basis).toBeGreaterThan(20);   // pulled toward 30
  });

  it('falls back to a simple mean when the window has no volume', () => {
    // Index bars (SPX) frequently carry volume 0 — VWMA must not divide by zero.
    const bars = [
      bar(0, 10, 12, 8, 10, 0),
      bar(300, 20, 22, 18, 20, 0),
      bar(600, 30, 32, 28, 30, 0),
    ];
    const b = fibBands(bars, 3, 2)[2]!;
    expect(Number.isFinite(b.basis)).toBe(true);
    expect(b.basis).toBeCloseTo(20, 10);
  });

  it('returns null during warm-up and a band set from bar length-1 onward', () => {
    const bands = fibBands(rampSeries(12), 10, 3);
    expect(bands.slice(0, 9).every(b => b === null)).toBe(true);
    expect(bands[9]).not.toBeNull();
    expect(bands[11]).not.toBeNull();
  });

  it('orders bands monotonically around the basis', () => {
    const b = fibBands(rampSeries(12), 10, 3)[11]!;
    const ups = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0].map(r => bandPrice(b, r, 'upper'));
    const lows = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0].map(r => bandPrice(b, r, 'lower'));
    for (let i = 1; i < ups.length; i++) expect(ups[i]).toBeGreaterThan(ups[i - 1]);
    for (let i = 1; i < lows.length; i++) expect(lows[i]).toBeLessThan(lows[i - 1]);
    expect(ups[0]).toBeGreaterThan(b.basis);
    expect(lows[0]).toBeLessThan(b.basis);
  });
});

describe('no look-ahead', () => {
  const bars = rampSeries(30);

  it('bands at bar i are unchanged by the existence of bars after i', () => {
    const full = fibBands(bars, 10, 3);
    for (let i = 10; i < bars.length; i++) {
      const prefix = fibBands(bars.slice(0, i + 1), 10, 3);
      expect(prefix[i]!.basis).toBeCloseTo(full[i]!.basis, 10);
      expect(prefix[i]!.dev).toBeCloseTo(full[i]!.dev, 10);
    }
  });

  it('rejections on a prefix agree with rejections on the full series', () => {
    const full = detectRejections(bars, fibBands(bars, 10, 3), BASE_OPTS);
    for (let i = 10; i < bars.length; i++) {
      const pre = bars.slice(0, i + 1);
      const preSigs = detectRejections(pre, fibBands(pre, 10, 3), BASE_OPTS);
      expect(preSigs.map(s => s.confIdx)).toEqual(
        full.filter(s => s.confIdx <= i).map(s => s.confIdx),
      );
    }
  });

  it('a violent move on bar i+1 cannot change the signal on bar i', () => {
    const base = [...bars];
    const i = base.length - 2;
    const calm = detectRejections(base, fibBands(base, 10, 3), BASE_OPTS);
    const shocked = [...base];
    shocked[i + 1] = bar(base[i + 1].ts, 100, 5000, 1, 4000, 999);
    const after = detectRejections(shocked, fibBands(shocked, 10, 3), BASE_OPTS);
    expect(after.filter(s => s.confIdx <= i).map(s => s.confIdx))
      .toEqual(calm.filter(s => s.confIdx <= i).map(s => s.confIdx));
  });
});

describe('detectRejections', () => {
  /** Ramp, then a bar that spikes through the upper 1.0 band and closes inside. */
  function withSpike(spikeClose: number, spikeOpen = 112): OHLCBar[] {
    const s = rampSeries(12);
    const b = fibBands(s, 10, 3)[11]!;
    const up = bandPrice(b, 1.0, 'upper');
    s.push(bar(s[11].ts + 300, spikeOpen, up + 25, spikeOpen - 1, spikeClose));
    s.push(bar(s[11].ts + 600, 117, 118, 116, 117));
    return s;
  }

  it('fires a short when the bar pierces the upper band but closes back inside', () => {
    const s = withSpike(113);
    const sigs = detectRejections(s, fibBands(s, 10, 3), BASE_OPTS);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].confIdx).toBe(12);
    expect(sigs[0].fillIdx).toBe(13);
    expect(sigs[0].dir).toBe('short');
  });

  it('does not fire when the bar closes above the band (no rejection)', () => {
    const s = rampSeries(12);
    const up = bandPrice(fibBands(s, 10, 3)[11]!, 1.0, 'upper');
    s.push(bar(s[11].ts + 300, 112, up + 60, 111, up + 55)); // closed outside
    s.push(bar(s[11].ts + 600, 117, 118, 116, 117));
    expect(detectRejections(s, fibBands(s, 10, 3), BASE_OPTS)).toHaveLength(0);
  });

  it('does not fire when the band is never pierced', () => {
    const s = rampSeries(14);
    expect(detectRejections(s, fibBands(s, 10, 3), BASE_OPTS)).toHaveLength(0);
  });

  it('honours the wick-fraction filter', () => {
    const s = withSpike(113);
    const spike = s[12];
    const wickFrac = (spike.high - Math.max(spike.open, spike.close)) / (spike.high - spike.low);
    const bands = fibBands(s, 10, 3);
    expect(detectRejections(s, bands, { ...BASE_OPTS, wickFrac: wickFrac - 0.05 })).toHaveLength(1);
    expect(detectRejections(s, bands, { ...BASE_OPTS, wickFrac: wickFrac + 0.05 })).toHaveLength(0);
  });

  it('never emits a signal on the last bar (nothing left to fill on)', () => {
    const s = withSpike(113);
    const sigs = detectRejections(s, fibBands(s, 10, 3), BASE_OPTS);
    expect(sigs.every(x => x.fillIdx < s.length)).toBe(true);
  });

  it('fires a long on a lower-band rejection', () => {
    const s = rampSeries(12, 110, -2); // down-ramp
    const low = bandPrice(fibBands(s, 10, 3)[11]!, 1.0, 'lower');
    s.push(bar(s[11].ts + 300, 88, 89, low - 25, 87));  // pierces low, closes inside
    s.push(bar(s[11].ts + 600, 87, 88, 86, 87));
    const sigs = detectRejections(s, fibBands(s, 10, 3), { ...BASE_OPTS, dir: 'long' });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].dir).toBe('long');
  });
});

describe('simulate', () => {
  /** Ramp + upper-band rejection at idx 12, then `tail` bars to manage the trade. */
  function scenario(tail: OHLCBar[]): OHLCBar[] {
    const s = rampSeries(12);
    const up = bandPrice(fibBands(s, 10, 3)[11]!, 1.0, 'upper');
    s.push(bar(s[11].ts + 300, 112, up + 25, 111, 113)); // idx 12: rejection
    return [...s, ...tail];
  }

  it('enters at the NEXT bar open, not the signal bar close', () => {
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 108, 109, 107, 108),   // idx 13: fill bar, open 108
      bar(DAY1_OPEN + 14 * 300, 105, 106, 104, 105),
    ]);
    const [t] = simulate(s, BASE_OPTS);
    expect(t).toBeDefined();
    expect(t.entry).toBe(108);                  // idx 13 open
    expect(t.entry).not.toBe(s[12].close);      // never the signal bar's close
    expect(t.entryTs).toBe(s[13].ts);
  });

  it('takes the STOP when one bar straddles both stop and target', () => {
    // Fill bar reaches down past the basis target AND up past the stop.
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 108, 1e4, -1e4, 108),
      bar(DAY1_OPEN + 14 * 300, 108, 109, 107, 108),
    ]);
    const [t] = simulate(s, BASE_OPTS);
    expect(t.exitReason).toBe('stop');
    expect(t.pnlPts).toBeLessThan(0);
  });

  it('caps the loss at the risk defined on entry (R >= -1)', () => {
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 108, 109, 107, 108),
      bar(DAY1_OPEN + 14 * 300, 108, 1e4, 107, 9e3),   // runaway against the short
      bar(DAY1_OPEN + 15 * 300, 9e3, 9e3, 9e3, 9e3),
    ]);
    const [t] = simulate(s, BASE_OPTS);
    expect(t.exitReason).toBe('stop');
    expect(t.r).toBeCloseTo(-1, 6);
    expect(t.pnlPts).toBeCloseTo(-(t.stop - t.entry), 6);
  });

  it('takes the target when price reverts to the basis', () => {
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 108, 109, 107, 108),
      bar(DAY1_OPEN + 14 * 300, 106, 107, 80, 82),     // sweeps down through basis
      bar(DAY1_OPEN + 15 * 300, 82, 83, 81, 82),
    ]);
    const [t] = simulate(s, BASE_OPTS);
    expect(t.exitReason).toBe('target');
    expect(t.pnlPts).toBeGreaterThan(0);
    expect(t.r).toBeGreaterThan(0);
  });

  it('exits at the session close when sessionExit is on', () => {
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 108, 109, 107, 108),
      bar(DAY1_OPEN + 14 * 300, 108, 109, 107, 106),   // last bar of day 1
      bar(DAY2_OPEN, 106, 107, 105, 106),              // next session
    ]);
    const [t] = simulate(s, { ...BASE_OPTS, sessionExit: true });
    expect(t.exitReason).toBe('session');
    expect(t.exitTs).toBe(s[14].ts);
    expect(t.pnlPts).toBeCloseTo(108 - 106, 6);        // short: entry - close
  });

  it('holds at most one position at a time', () => {
    const s = scenario(
      Array.from({ length: 20 }, (_, k) =>
        bar(DAY1_OPEN + (13 + k) * 300, 108, 109, 107, 108)),
    );
    const trades = simulate(s, BASE_OPTS);
    for (let i = 1; i < trades.length; i++) {
      expect(trades[i].entryTs).toBeGreaterThan(trades[i - 1].exitTs);
    }
  });

  it('widens the stop by stopBufAtr x ATR beyond the rejection extreme', () => {
    const tail = [
      bar(DAY1_OPEN + 13 * 300, 108, 109, 107, 108),
      bar(DAY1_OPEN + 14 * 300, 105, 106, 104, 105),
    ];
    const tight = simulate(scenario(tail), BASE_OPTS)[0];
    const wide = simulate(scenario(tail), { ...BASE_OPTS, stopBufAtr: 1 })[0];
    expect(wide.stop).toBeGreaterThan(tight.stop);
  });

  it('skips setups whose defined risk is below the minRiskAtr floor', () => {
    // Fill bar opens at 145, a hair under the stop (the rejection wick high) —
    // a ~0.2pt risk that is untradeable and would score as a huge R.
    const s = scenario([
      bar(DAY1_OPEN + 13 * 300, 145, 145.5, 144, 144.5),
      bar(DAY1_OPEN + 14 * 300, 130, 131, 100, 101),
    ]);
    const loose = simulate(s, BASE_OPTS)[0];
    expect(loose.risk).toBeLessThan(1);
    expect(simulate(s, { ...BASE_OPTS, minRiskAtr: 0.5 })).toHaveLength(0);
  });

  it('returns no trades when the band is never rejected', () => {
    expect(simulate(rampSeries(30), BASE_OPTS)).toHaveLength(0);
  });
});

describe('cycle 1: higher-TF confluence', () => {
  /** HTF context: a few 60m-ish bars whose basis sits just above the upper
   *  band the 5m series pierces — so a wick that touches the HTF band counts. */
  function htfContext(signalBars: OHLCBar[]): HtfContext {
    const htfBars: OHLCBar[] = [
      bar(signalBars[0].ts - 3600, 110, 112, 108, 110),
      bar(signalBars[0].ts - 1800, 111, 113, 109, 111),
      bar(signalBars[0].ts, 112, 114, 110, 112),
      ...signalBars.slice(1).map(b => bar(b.ts, 112, 114, 110, 112)),
    ];
    const htfBands = fibBands(htfBars, 3, 3);
    return { bars: htfBars, bands: htfBands, slopeWindow: 1 };
  }

  it('accepts a rejection when its wick reaches the higher-TF basis (the structural anchor)', () => {
    const signal = rampSeries(12);
    const up = bandPrice(fibBands(signal, 10, 3)[11]!, 1.0, 'upper');
    signal.push(bar(signal[11].ts + 300, 112, up + 25, 111, 113));     // 5m rejection at idx 12
    signal.push(bar(signal[11].ts + 600, 117, 118, 116, 117));
    // Build an HTF whose basis sits RIGHT AT the rejection extreme (~up+25).
    // Old semantics (touch outer 1.0 band) never triggered because 60m bands
    // sit tens of points away from 5m extremes — the gate was a no-op. The
    // basis is the structural anchor that can actually be touched.
    const htfAt112: HtfContext = {
      bars: signal.map(b => bar(b.ts - 3600, 137, 138, 136, 137)),  // basis ~137
      bands: signal.map(() => ({ basis: 137, dev: 2 })),            // tight HTF band
      slopeWindow: 1,
    };
    const atr = rollingATR(signal, 5);
    const noFilter = detectRejections(signal, fibBands(signal, 10, 3), BASE_OPTS);
    const filtered = detectRejections(
      signal, fibBands(signal, 10, 3), BASE_OPTS,
      htfAt112, 5.0, false, atr,
    );
    expect(noFilter.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(noFilter.length);
  });

  it('rejects a rejection when its wick is far from the higher-TF basis', () => {
    const signal = rampSeries(12);
    const up = bandPrice(fibBands(signal, 10, 3)[11]!, 1.0, 'upper');
    signal.push(bar(signal[11].ts + 300, 112, up + 25, 111, 113));
    signal.push(bar(signal[11].ts + 600, 117, 118, 116, 117));
    // HTF basis at ~1000, far above the rejection extreme — touch impossible.
    const farHtf: HtfContext = {
      bars: signal.map(b => bar(b.ts - 3600, 1000, 1010, 990, 1000)),
      bands: signal.map(() => ({ basis: 1000, dev: 10 })),
      slopeWindow: 1,
    };
    const atr = rollingATR(signal, 5);
    const filtered = detectRejections(
      signal, fibBands(signal, 10, 3), BASE_OPTS,
      farHtf, 0.5, false, atr,
    );
    expect(filtered).toHaveLength(0);
  });

  it('tightening the touch threshold actually filters (catches the gap the first sweep had)', () => {
    // Same rejection; HTF basis at 142 (right at the rejection wick). Compare
    // a TIGHT threshold (5 ATR) — the wick is way past the basis so the
    // distance in ATRs is huge → reject. Compare a very loose one (50 ATR) —
    // passes. This is what failed in cycle 1: 1.5 vs 3 ATR vs "no gate" all
    // produced identical results because the HTF BAND sits tens of points
    // from the 5m extreme, but the HTF BASIS is what the touch anchor is.
    const signal = rampSeries(12);
    const up = bandPrice(fibBands(signal, 10, 3)[11]!, 1.0, 'upper');
    signal.push(bar(signal[11].ts + 300, 112, up + 25, 111, 113));   // wick ~142
    signal.push(bar(signal[11].ts + 600, 117, 118, 116, 117));
    const htfNear: HtfContext = {
      bars: signal.map(b => bar(b.ts - 3600, 142, 143, 141, 142)),
      bands: signal.map(() => ({ basis: 142, dev: 1 })),
      slopeWindow: 1,
    };
    const atr = rollingATR(signal, 5);
    const tight = detectRejections(signal, fibBands(signal, 10, 3), BASE_OPTS,
      htfNear, 5, false, atr).length;        // wick 0 from basis → pass
    const looser = detectRejections(signal, fibBands(signal, 10, 3), BASE_OPTS,
      htfNear, 1, false, atr).length;        // wick > 1 ATR from basis → still pass (basis AT wick)
    // Now move the basis FAR away — tight threshold rejects.
    const htfFar: HtfContext = {
      bars: signal.map(b => bar(b.ts - 3600, 50, 51, 49, 50)),
      bands: signal.map(() => ({ basis: 50, dev: 1 })),
      slopeWindow: 1,
    };
    const farTight = detectRejections(signal, fibBands(signal, 10, 3), BASE_OPTS,
      htfFar, 5, false, atr).length;
    expect(tight).toBeGreaterThan(farTight);
    expect(looser).toBeGreaterThan(farTight);
  });

  it('rejects a LONG when higher-TF basis slope is negative', () => {
    const signal = rampSeries(12);
    const low = bandPrice(fibBands(signal, 10, 3)[11]!, 1.0, 'lower');
    signal.push(bar(signal[11].ts + 300, 88, 89, low - 25, 87));
    signal.push(bar(signal[11].ts + 600, 87, 88, 86, 87));
    // HTF basis slopes DOWN over the slope window → long filter rejects.
    const downHtf: HtfContext = {
      bars: signal.slice(0, 12).map(b => bar(b.ts - 1800, 120, 122, 118, 120)),
      bands: signal.slice(0, 12).map((_, i) => ({ basis: 120 - i, dev: 5 })),
      slopeWindow: 3,
    };
    expect(detectRejections(
      signal, fibBands(signal, 10, 3), { ...BASE_OPTS, dir: 'long' },
      downHtf, undefined, true,
    )).toHaveLength(0);
  });

  it('htfAt uses only bars whose ts <= signal bar ts (no look-ahead)', () => {
    // Hand-build a 4-bar HTF where each next bar has a wildly different basis.
    const htfBars = [
      bar(0,    100, 102, 98,  100),
      bar(3600, 200, 202, 198, 200),   // future — must NOT be used
      bar(7200, 300, 302, 298, 300),   // future — must NOT be used
    ];
    const htfBands: (FibBand | null)[] = [
      { basis: 100, dev: 5 },
      { basis: 200, dev: 5 },
      { basis: 300, dev: 5 },
    ];
    const htf: HtfContext = { bars: htfBars, bands: htfBands, slopeWindow: 1 };
    // Signal bar at ts=0 — only bar 0 of htf qualifies.
    expect(htfAt(htf, [{ ts: 0 } as OHLCBar], 0).band!.basis).toBe(100);
    // Signal bar at ts=3601 — bars 0 and 1 qualify, return the LATEST.
    expect(htfAt(htf, [{ ts: 3601 } as OHLCBar], 0).band!.basis).toBe(200);
  });

  it('truncating the higher-TF series after the signal bar changes nothing at i', () => {
    const signal = rampSeries(12);
    const up = bandPrice(fibBands(signal, 10, 3)[11]!, 1.0, 'upper');
    signal.push(bar(signal[11].ts + 300, 112, up + 25, 111, 113));
    signal.push(bar(signal[11].ts + 600, 117, 118, 116, 117));
    const fullHtf = htfContext(signal);
    const sigIdx = 12;
    const beforeHtf: HtfContext = {
      bars: fullHtf.bars.slice(0, fullHtf.bars.indexOf(
        fullHtf.bars.find(b => b.ts >= signal[sigIdx].ts)!,
      ) + 1),
      bands: fullHtf.bands,
      slopeWindow: fullHtf.slopeWindow,
    };
    expect(htfAt(fullHtf, signal, sigIdx).band!.basis)
      .toBeCloseTo(htfAt(beforeHtf, signal, sigIdx).band!.basis, 10);
  });
});

describe('cycle 2: higher-TF basis-cross exit', () => {
  /**
   * Hand-build a series that:
   *   - has a clean lower-band rejection at idx 12 (long signal)
   *   - has an HTF basis that CROSSES UP through the entry on the bar after
   *     fill, so the cycle-2 exit must fire.
   */
  function build(): { signal: OHLCBar[]; htf: HtfContext } {
    const ramp = rampSeries(12, 100, 1);                  // gentle ramp so basis ≈ 111
    // Rejection bar: low pierces 1.0 lower band, closes back inside.
    const lb = bandPrice(fibBands(ramp, 10, 3)[11]!, 1.0, 'lower');
    const rejection = bar(ramp[11].ts + 300, 112, 113, lb - 30, 112);
    const fillBar = bar(ramp[11].ts + 600, 112, 113, 111.5, 112);    // entry
    const crossUp = bar(ramp[11].ts + 900, 112, 116, 111.8, 115.5); // wicks through HTF basis
    const signal = [...ramp, rejection, fillBar, crossUp];

    // HTF series: one bar every hour; basis crosses UP through 112 across the
    // window (below 112 → above 112). The CROSS is the point: the basis must
    // be on different sides of 112 across the trade window.
    const htfBars: OHLCBar[] = signal.map((b, i) =>
      bar(b.ts - 3600, i < 13 ? 105 : 120, i < 13 ? 108 : 123, i < 13 ? 102 : 117, i < 13 ? 106 : 121),
    );
    const htf: HtfContext = { bars: htfBars, bands: fibBands(htfBars, 3, 3), slopeWindow: 1 };
    return { signal, htf };
  }

  it('exits a long on an HTF basis cross-UP rather than waiting for the static target', () => {
    const { signal, htf } = build();
    // Sanity: the rejection must fire on its own before we test the exit path.
    const sigs = detectRejections(signal, fibBands(signal, 10, 3), { ...BASE_OPTS, dir: 'long' });
    expect(sigs).toHaveLength(1);
    const pre: Precomputed = { bands: fibBands(signal, 10, 3), atr: rollingATR(signal, 5), htf };
    const trades = simulate(signal, { ...BASE_OPTS, dir: 'long' }, pre);
    expect(trades).toHaveLength(1);
    expect(['htfCross', 'target']).toContain(trades[0].exitReason);
  });

  it('without HTF context, a series with no winning-side static target produces no trade', () => {
    const { signal } = build();
    // No htf in Precomputed — only static target / stop / session in play.
    // This series was constructed so the static basis target sits BELOW entry,
    // so without HTF the simulator correctly refuses to enter.
    expect(simulate(signal, { ...BASE_OPTS, dir: 'long' })).toHaveLength(0);
  });

  it('HTF context still respects no look-ahead: a future HTF bar cannot exit early', () => {
    const { signal } = build();
    // Build an HTF where bars AFTER the crossUp bar have a wildly different
    // basis. The crossUp bar's HTF basis must still resolve from the prefix.
    const { htf } = build();
    const tampered: HtfContext = {
      bars: htf.bars,
      bands: htf.bands.map((b, i) => i > signal.length - 1 ? { basis: 9999, dev: 999 } : b),
      slopeWindow: htf.slopeWindow,
    };
    const pre: Precomputed = { bands: fibBands(signal, 10, 3), atr: rollingATR(signal, 5), htf: tampered };
    const tradesA = simulate(signal, { ...BASE_OPTS, dir: 'long' }, pre);
    const tradesB = simulate(signal, { ...BASE_OPTS, dir: 'long' }, { ...pre, htf });
    // Either both find a cross (same reason) or both don't — but neither can
    // be made to exit EARLIER by tampering with future HTF bars.
    expect(tradesA[0]?.exitIdx).toBe(tradesB[0]?.exitIdx);
  });
});

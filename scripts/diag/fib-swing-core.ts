/**
 * fib-swing-core.ts
 *
 * Shared signal + simulation for the Marci Silfrain "Measured Move / Fibonacci
 * Swing" study. Both the intraday study (fib-swing-study.ts, one RTH session at
 * a time, EOD exit) and the multi-day study (fib-swing-multiday.ts, continuous
 * series, hold across days) import this so the two can never drift.
 *
 * The simulator is PURE: feed it any OHLC series and a config; it returns the
 * trades. "Exit at end of data" is whatever the last bar of the series you pass
 * is — a single session for the intraday study, the whole history for the
 * multi-day study. See fib-swing-study.ts header for the strategy + look-ahead
 * discipline (a pivot centered at c is confirmed no earlier than bar c+right).
 */
import { OHLCBar } from './ohlc-aggregate';

export interface Pivot { kind: 'H' | 'L'; price: number; idx: number; confIdx: number; }

/** Confirmed fractal pivots, ordered by confirmation bar (what a live trader learns, in order). */
export function pivots(bars: OHLCBar[], left: number, right: number): Pivot[] {
  const out: Pivot[] = [];
  for (let c = left; c < bars.length - right; c++) {
    const ctr = bars[c];
    let isH = true, isL = true;
    for (let k = c - left; k <= c + right; k++) {
      if (k === c) continue;
      if (bars[k].high >= ctr.high) isH = false;
      if (bars[k].low <= ctr.low) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) out.push({ kind: 'H', price: ctr.high, idx: c, confIdx: c + right });
    if (isL) out.push({ kind: 'L', price: ctr.low, idx: c, confIdx: c + right });
  }
  return out.sort((a, b) => a.confIdx - b.confIdx || a.idx - b.idx);
}

export interface SimOpts {
  left: number; right: number;
  entryFib: number;   // retracement that predicts the bottom/top (0.382/0.5/0.618)
  extFib: number;     // measured-move extension that predicts the next high/low
  dir: 'long' | 'short';
  trendGate: boolean; // require higher-low (long) / lower-high (short)
  stopBuf: number;    // extra buffer beyond the leg origin, as × leg
  entryWindow: number;// max bars from leg confirmation to fill the retracement
}

export interface Trade {
  dir: 'long' | 'short';
  entry: number; stop: number; target: number;
  outcome: 'win' | 'loss' | 'flat';
  pnlPts: number; r: number;
  entryTs: number; exitTs: number; barsHeld: number;
}

/** A valid leg at pivot index p: the Fib-retracement entry, stop, target, and
 *  the bar at which the leg is armed (2nd pivot confirmed). null if no setup. */
interface LegSetup { entry: number; stop: number; target: number; leg: number; armIdx: number; }
function legAt(pvs: Pivot[], p: number, o: SimOpts): LegSetup | null {
  const b = pvs[p];        // 2nd pivot of the leg (swing we retrace from)
  const a = pvs[p - 1];    // 1st pivot of the leg (origin / invalidation)
  const prev = pvs[p - 2]; // older pivot, for the trend gate
  if (o.dir === 'long') {
    if (!(a.kind === 'L' && b.kind === 'H')) return null;
    if (b.price <= a.price) return null;
    if (o.trendGate) {
      const priorLow = prev.kind === 'L' ? prev.price : (pvs[p - 3]?.kind === 'L' ? pvs[p - 3].price : -Infinity);
      if (!(a.price > priorLow)) return null;
    }
  } else {
    if (!(a.kind === 'H' && b.kind === 'L')) return null;
    if (b.price >= a.price) return null;
    if (o.trendGate) {
      const priorHigh = prev.kind === 'H' ? prev.price : (pvs[p - 3]?.kind === 'H' ? pvs[p - 3].price : Infinity);
      if (!(a.price < priorHigh)) return null;
    }
  }
  const leg = Math.abs(b.price - a.price);
  if (leg <= 0) return null;
  const entry = o.dir === 'long' ? b.price - o.entryFib * leg : b.price + o.entryFib * leg;
  const stop = o.dir === 'long' ? a.price - o.stopBuf * leg : a.price + o.stopBuf * leg;
  const target = o.dir === 'long' ? entry + o.extFib * leg : entry - o.extFib * leg;
  if (Math.abs(entry - stop) <= 0) return null;
  return { entry, stop, target, leg, armIdx: b.confIdx };
}

/** Bar index where the retracement limit fills (entry touched before stop),
 *  within `entryWindow` bars after arming. -1 if never. No look-ahead. */
function findFill(bars: OHLCBar[], armIdx: number, entry: number, stop: number, dir: 'long' | 'short', entryWindow: number): number {
  for (let i = armIdx + 1; i < bars.length && i <= armIdx + entryWindow; i++) {
    const bar = bars[i];
    if (dir === 'long') {
      if (bar.low <= stop) return -1;            // invalidated before fill
      if (bar.low <= entry) return i;
    } else {
      if (bar.high >= stop) return -1;
      if (bar.high >= entry) return i;
    }
  }
  return -1;
}

/**
 * Simulate one config on one OHLC series. One position at a time. A leg is the
 * last two alternating confirmed pivots (L→H = up-leg for longs, H→L = down-leg
 * for shorts). On confirmation of the leg's 2nd pivot we arm a Fib-retracement
 * limit; fill within `entryWindow` bars; then manage to stop / measured-move
 * target / end-of-series. No look-ahead.
 */
export function simulate(bars: OHLCBar[], o: SimOpts): Trade[] {
  const trades: Trade[] = [];
  const pvs = pivots(bars, o.left, o.right);
  if (pvs.length < 3) return trades;

  let busyUntil = -1;
  for (let p = 2; p < pvs.length; p++) {
    const s = legAt(pvs, p, o);
    if (!s) continue;
    if (s.armIdx <= busyUntil) continue;

    const fillIdx = findFill(bars, s.armIdx, s.entry, s.stop, o.dir, o.entryWindow);
    if (fillIdx < 0) continue;

    // manage to stop / target / end-of-series
    let outcome: Trade['outcome'] = 'flat';
    let exitPx = bars[bars.length - 1].close;
    let exitIdx = bars.length - 1;
    for (let i = fillIdx; i < bars.length; i++) {
      const bar = bars[i];
      const hitStop = o.dir === 'long' ? bar.low <= s.stop : bar.high >= s.stop;
      const hitTgt = o.dir === 'long' ? bar.high >= s.target : bar.low <= s.target;
      if (hitStop) { outcome = 'loss'; exitPx = s.stop; exitIdx = i; busyUntil = i; break; } // stop-first when ambiguous
      if (hitTgt) { outcome = 'win'; exitPx = s.target; exitIdx = i; busyUntil = i; break; }
      busyUntil = i;
    }
    const pnlPts = o.dir === 'long' ? exitPx - s.entry : s.entry - exitPx;
    trades.push({
      dir: o.dir, entry: s.entry, stop: s.stop, target: s.target, outcome, pnlPts, r: pnlPts / Math.abs(s.entry - s.stop),
      entryTs: bars[fillIdx].ts, exitTs: bars[exitIdx].ts, barsHeld: exitIdx - fillIdx,
    });
  }
  return trades;
}

/** Entry event for the option backtest. `ts` is the fill bar's bucket OPEN —
 *  the retracement fill is only KNOWN at the bucket close, so the option engine
 *  must enter at `ts + tfSeconds` (look-ahead discipline, same as smc-signal). */
export interface FibEntry { ts: number; barIdx: number; dir: 'bull' | 'bear'; stopLow: number; stopHigh: number; entryPrice: number; }

/**
 * Emit the Fib-retracement FILL events across a series (every valid leg whose
 * retracement filled before invalidation). Same leg/fill logic as simulate() —
 * shared via legAt()/findFill() so the directional study and the option sweep
 * can never disagree on what counts as an entry.
 */
export function fibEntriesOnSeries(bars: OHLCBar[], o: SimOpts): FibEntry[] {
  const out: FibEntry[] = [];
  const pvs = pivots(bars, o.left, o.right);
  if (pvs.length < 3) return out;
  for (let p = 2; p < pvs.length; p++) {
    const s = legAt(pvs, p, o);
    if (!s) continue;
    const fillIdx = findFill(bars, s.armIdx, s.entry, s.stop, o.dir, o.entryWindow);
    if (fillIdx < 0) continue;
    out.push({
      ts: bars[fillIdx].ts, barIdx: fillIdx,
      dir: o.dir === 'long' ? 'bull' : 'bear',
      stopLow: o.dir === 'long' ? s.stop : 0,
      stopHigh: o.dir === 'short' ? s.stop : 0,
      entryPrice: s.entry,
    });
  }
  return out;
}

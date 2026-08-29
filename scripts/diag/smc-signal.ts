/**
 * smc-signal.ts
 *
 * TJR / Smart-Money-Concepts "liquidity sweep + break of structure" detector,
 * the V1 setup that Revelio Trading's two-part backtest
 * (https://youtu.be/4uqeKO6KcJk, https://youtu.be/8FJbpSY0R3o) found to be the
 * *profitable core* of the strategy — simpler than the full FVG/order-block
 * version, which tested worse.
 *
 * BULL setup (the only side we trade for indices — the videos' out-of-sample
 * random-forest finding was that shorting an up-drifting index loses):
 *   1. Liquidity sweep — a bar wicks BELOW a confirmed swing low (sell-side
 *      stop-hunt: traps sellers / takes out liquidity beneath structure).
 *   2. Break of structure — a later bar CLOSES above the swing high that stood
 *      before the sweep (bullish reversal confirmed).
 *   3. Entry at the BOS bar close; protective stop just beyond the sweep wick.
 *
 * BEAR setup is the mirror (sweep above a swing high → close below the prior
 * swing low). Implemented for completeness/symmetry; the credit engine consumes
 * bull only.
 *
 * Mapping to credit spreads (the user's nuance — express the directional bet
 * with defined-risk premium instead of shares):
 *   bull setup → short PUT credit spread (bull put spread)
 *   bear setup → short CALL credit spread
 *
 * No look-ahead — the discipline mirrors tlb-signal.ts:
 *   A swing pivot centered at bar c (with `left` bars left and `right` bars
 *   right) is only CONFIRMED at bar c+right. The state machine therefore acts
 *   on a pivot no earlier than the bar at which a live trader could have seen
 *   it. Sweep/BOS tests read only the current bar's OHLC. An event at bar i
 *   depends solely on bars 0..i (verified by the prefix-agreement unit test).
 *
 * IMPORTANT (aggregated-bar look-ahead): when fed bars aggregated to a higher
 * timeframe, `bar.ts` is the bucket OPEN. The break is only KNOWN at bucket
 * close. Callers must enter at `event.ts + tfSeconds`, never at `event.ts`
 * (the credit engine does exactly this — see smc-credit-sweep.ts).
 */

export type SmcBar = { ts: number; open: number; high: number; low: number; close: number };

export interface SmcParams {
  left: number;     // swing-pivot lookback to the LEFT of center
  right: number;    // swing-pivot lookback to the RIGHT (= confirmation lag)
  maxWait: number;  // max bars from sweep to BOS before the setup is abandoned
}

export const SMC_DEFAULTS: SmcParams = { left: 8, right: 3, maxWait: 12 };

export type SmcDirection = 'bull' | 'bear';

export interface SmcSetup {
  ts: number;        // timestamp of the BOS bar (bucket OPEN for aggregated TFs)
  barIdx: number;    // index of the BOS bar
  dir: SmcDirection;
  /** Bull: lowest wick of the sweep (protective-stop anchor). */
  stopLow: number;
  /** Bear: highest wick of the sweep (protective-stop anchor). */
  stopHigh: number;
  /** Structure level that was broken (swing high for bull, swing low for bear). */
  refHigh: number;   // bull: the swing high broken; bear: unused (0)
  refLow: number;    // bear: the swing low broken; bull: unused (0)
}

interface Pivot { price: number; idx: number; }
interface Sweep { extreme: number; startIdx: number; }

/**
 * Detect ALL SMC sweep+BOS setups across a bar series, ordered by `barIdx`
 * (the BOS bar — no look-ahead). Both directions are returned; filter by
 * `dir` at the call site.
 */
export function smcSetupsOnSeries(bars: SmcBar[], p: SmcParams = SMC_DEFAULTS): SmcSetup[] {
  const out: SmcSetup[] = [];
  const n = bars.length;
  const span = p.left + p.right;
  if (n < span + 1) return out;

  let lastSwingHigh: Pivot | null = null;
  let lastSwingLow: Pivot | null = null;
  let bullSweep: Sweep | null = null; // wick below a swing low, awaiting BOS up
  let bearSweep: Sweep | null = null; // wick above a swing high, awaiting BOS down

  for (let i = 0; i < n; i++) {
    // ── Confirm the pivot centered at c = i - right (known no earlier than i). ──
    const c = i - p.right;
    if (c - p.left >= 0) {
      const center = bars[c];
      let isPH = true, isPL = true;
      for (let k = c - p.left; k <= c + p.right; k++) {
        if (k === c) continue;
        if (bars[k].high >= center.high) isPH = false;
        if (bars[k].low  <= center.low)  isPL = false;
        if (!isPH && !isPL) break;
      }
      if (isPH) lastSwingHigh = { price: center.high, idx: c };
      if (isPL) lastSwingLow = { price: center.low, idx: c };
    }

    const cur = bars[i];

    // ── Bull side: sweep below the swing low, then BOS up. The break of
    //    structure fires the first time price CLOSES above the most recent
    //    confirmed swing high (the nearest structure to reclaim) — not frozen
    //    to the pre-sweep high, so a closer high formed during the recovery
    //    also counts. No look-ahead: that high was confirmed on/before bar i. ─
    if (lastSwingLow && cur.low < lastSwingLow.price) {
      if (!bullSweep) bullSweep = { extreme: cur.low, startIdx: i };
      else bullSweep.extreme = Math.min(bullSweep.extreme, cur.low);
    }
    if (bullSweep) {
      if (i - bullSweep.startIdx > p.maxWait) {
        bullSweep = null;
      } else if (lastSwingHigh && cur.close > lastSwingHigh.price) {
        out.push({ ts: cur.ts, barIdx: i, dir: 'bull', stopLow: bullSweep.extreme, stopHigh: 0, refHigh: lastSwingHigh.price, refLow: 0 });
        bullSweep = null;
      }
    }

    // ── Bear side: sweep above the swing high, then BOS down (close < the most
    //    recent confirmed swing low). ─
    if (lastSwingHigh && cur.high > lastSwingHigh.price) {
      if (!bearSweep) bearSweep = { extreme: cur.high, startIdx: i };
      else bearSweep.extreme = Math.max(bearSweep.extreme, cur.high);
    }
    if (bearSweep) {
      if (i - bearSweep.startIdx > p.maxWait) {
        bearSweep = null;
      } else if (lastSwingLow && cur.close < lastSwingLow.price) {
        out.push({ ts: cur.ts, barIdx: i, dir: 'bear', stopLow: 0, stopHigh: bearSweep.extreme, refHigh: 0, refLow: lastSwingLow.price });
        bearSweep = null;
      }
    }
  }
  return out;
}

/**
 * True when the LAST bar of `bars` is the moment a fresh setup of the given
 * direction occurred. Mirrors tlb-signal's `freshBreakOnLast` API.
 */
export function freshSetupOnLast(bars: SmcBar[], dir: SmcDirection, p: SmcParams = SMC_DEFAULTS): boolean {
  const evs = smcSetupsOnSeries(bars, p);
  if (evs.length === 0) return false;
  const last = evs[evs.length - 1];
  return last.barIdx === bars.length - 1 && last.dir === dir;
}

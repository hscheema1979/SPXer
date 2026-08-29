/**
 * fib-bb-core.ts
 *
 * Shared band math + signal + simulation for the "Fibonacci Bollinger Band
 * rejection" mean-reversion study. Pure — no I/O, no dates loaded, no config.
 * Feed it any OHLC series and it returns the trades. The study script
 * (fib-bb-study.ts) owns loading, aggregation, sweeping and reporting.
 *
 * ── The bands ──────────────────────────────────────────────────────────────
 * Rashad's TradingView "Fibonacci Bollinger Bands", the definition everyone
 * means by the name:
 *
 *     src   = hlc3
 *     basis = VWMA(src, length)              // volume-weighted, not SMA
 *     dev   = mult * stdev(src, length)      // population stdev, as Pine's ta.stdev
 *     band  = basis ± ratio * dev            for ratio in .236 .382 .5 .618 .786 1.0
 *
 * ── The signal ─────────────────────────────────────────────────────────────
 * A REJECTION is price stretching to an outer band and failing there: the bar
 * pierces the band with its wick but closes back inside it. Upper-band
 * rejection → short; lower-band rejection → long. Risk is defined at entry by
 * a stop beyond the rejection wick, so a wrong read costs a bounded amount.
 *
 * ── Look-ahead discipline (the whole point) ────────────────────────────────
 * A mean-reversion signal is trivially and falsely profitable if it can see
 * the bar it trades on, so these rules are absolute and are covered by tests
 * in tests/diag/fib-bb-core.test.ts:
 *
 *   - Bands at bar i use a trailing window ENDING at bar i. Bar i's own close
 *     is known at bar i's close; nothing after it is ever consulted. Truncating
 *     the series after i leaves bands[i] and the signals at i unchanged.
 *   - A rejection CONFIRMS at bar i's close, so the earliest possible fill is
 *     bar i+1's OPEN. We never fill at bar i's close. On aggregated bars
 *     `bar.ts` is the bucket OPEN, so the confirmation instant is
 *     bars[i].ts + tfSeconds — which is exactly bars[i+1].ts.
 *   - Within a bar we cannot know the path, so when one bar contains both the
 *     stop and the target we resolve it as a STOP (conservative), matching
 *     fib-swing-core.ts.
 *   - No signals during warm-up (fewer than `length` bars in the window).
 */
import { OHLCBar } from './ohlc-aggregate';

/** The Fib ratios the bands are drawn at, inner → outer. */
export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0] as const;

export interface FibBand {
  basis: number;  // VWMA(hlc3, length)
  dev: number;    // mult * stdev(hlc3, length)
}

/** Price of the `ratio` band on the given side. ratio 0 is the basis itself. */
export function bandPrice(b: FibBand, ratio: number, side: 'upper' | 'lower'): number {
  return side === 'upper' ? b.basis + ratio * b.dev : b.basis - ratio * b.dev;
}

/**
 * Per-bar band sets over a series. `out[i]` is computed from bars[i-length+1..i]
 * inclusive and is null while i < length-1 (warm-up).
 *
 * The basis is volume-weighted, but index series (SPX) routinely carry volume 0
 * on every bar — a naive VWMA would divide by zero and poison the whole study
 * with NaN. When a window carries no volume at all we fall back to the simple
 * mean, which is what a VWMA degenerates to under uniform weights anyway.
 */
export function fibBands(bars: OHLCBar[], length: number, mult: number): (FibBand | null)[] {
  const n = bars.length;
  const out: (FibBand | null)[] = new Array(n).fill(null);
  if (length <= 0 || n < length) return out;

  const src = bars.map(b => (b.high + b.low + b.close) / 3);

  // Rolling sums over the trailing window. The window ALWAYS ends at i — it
  // never reaches past it.
  let sumSrc = 0, sumVol = 0, sumSrcVol = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, bars[i].volume || 0);
    sumSrc += src[i];
    sumVol += v;
    sumSrcVol += src[i] * v;

    if (i >= length) {
      const j = i - length;
      const vj = Math.max(0, bars[j].volume || 0);
      sumSrc -= src[j];
      sumVol -= vj;
      sumSrcVol -= src[j] * vj;
    }
    if (i < length - 1) continue;

    const mean = sumSrc / length;
    const basis = sumVol > 0 ? sumSrcVol / sumVol : mean;
    // Population variance, second pass over the window. The rolling
    // sum-of-squares shortcut catastrophically cancels at index price levels
    // (sum of 6000^2 terms minus a nearly equal mean^2 term), which silently
    // collapses the band width — exactly the number this study depends on.
    let ss = 0;
    for (let k = i - length + 1; k <= i; k++) { const d = src[k] - mean; ss += d * d; }
    out[i] = { basis, dev: mult * Math.sqrt(ss / length) };
  }
  return out;
}

/** Rolling simple average of True Range. atr[i] uses bars[..i] only. */
export function rollingATR(bars: OHLCBar[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(0);
  const trs: number[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prevC = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevC), Math.abs(b.low - prevC));
    trs.push(tr);
    sum += tr;
    if (trs.length > period) sum -= trs.shift()!;
    out[i] = sum / trs.length;
  }
  return out;
}

/** Per-bar regression-channel result. null during warm-up (< length bars). */
export interface RegChannel {
  upper: number;     // regression line + k × standard error
  lower: number;     // regression line - k × standard error
  middle: number;    // the regression line value at this bar
  se: number;        // standard error of the regression
}

/**
 * Rolling linear-regression channel over a trailing window of `length` bars.
 * Fits close = a + b×t (t = 0..length-1) at each bar, returns the predicted
 * value ± k × standard_error. Unlike Bollinger Bands (deviation from a flat
 * rolling MEAN), the RC measures deviation from a TREND LINE — so it captures
 * "price stretched beyond its recent trend" rather than just "price far from
 * average." A rejection at the RC boundary is confirmed by BOTH the band math
 * AND the trend channel.
 *
 * Two-pass regression (compute means first, then slope) to avoid numerical
 * cancellation at index price levels (~6000). The window is purely trailing
 * (bars[i-length+1..i]) — no look-ahead.
 */
export function regressionChannel(bars: OHLCBar[], length: number, k: number): (RegChannel | null)[] {
  const n = bars.length;
  const out: (RegChannel | null)[] = new Array(n).fill(null);
  if (length < 3) return out;   // need ≥3 points for a regression with error d.o.f.

  for (let i = length - 1; i < n; i++) {
    let sumT = 0, sumY = 0;
    for (let j = 0; j < length; j++) {
      sumT += j;
      sumY += bars[i - length + 1 + j].close;
    }
    const meanT = sumT / length;
    const meanY = sumY / length;

    let num = 0, den = 0;
    for (let j = 0; j < length; j++) {
      const t = j - meanT;
      num += t * (bars[i - length + 1 + j].close - meanY);
      den += t * t;
    }
    const slope = den > 0 ? num / den : 0;
    const intercept = meanY - slope * meanT;
    const middle = intercept + slope * (length - 1);

    let ssr = 0;
    for (let j = 0; j < length; j++) {
      const predicted = intercept + slope * j;
      ssr += (bars[i - length + 1 + j].close - predicted) ** 2;
    }
    const se = Math.sqrt(ssr / (length - 2));

    out[i] = { upper: middle + k * se, lower: middle - k * se, middle, se };
  }
  return out;
}

export interface RejectOpts {
  dir: 'long' | 'short';
  /** Which band must be pierced: 0.5 / 0.618 / 0.786 / 1.0. */
  entryRatio: number;
  /** Minimum rejected wick as a fraction of the bar's range. 0 disables. */
  wickFrac: number;
  /**
   * Multi-band SEQUENCE gate: require that, in the `seqWindow` bars before the
   * rejection, price touched a band at least `seqRatio` (an outer Fib level)
   * WITHOUT rejecting — i.e. it pushed through to the entry band and only THEN
   * rejected. This models "price stretched through 0.618, accelerated to 0.786,
   * then rejected" rather than a one-bar flicker off a single level.
   * 0 disables (single-band trigger). seqRatio must be <= entryRatio.
   */
  seqRatio?: number;       // outer band that must have been touched first (<= entryRatio)
  seqWindow?: number;      // bars to look back for the sequence touch (default 5)
  /**
   * Time-of-day window (ET minutes-of-day). Only fire if the rejection bar's
   * timestamp falls in [todStart, todEnd]. Midday avoids the open spike and
   * the close acceleration — the cleanest mean-reversion regime.
   */
  todStartMin?: number;    // e.g. 660 = 11:00 ET
  todEndMin?: number;      // e.g. 840 = 14:00 ET
  /**
   * Regression-channel confirmation gate. When enabled, the rejection bar's
   * extreme must also be at or beyond the RC boundary (same TF). Confirms the
   * rejection with a trend-based extreme in addition to the band-based one.
   */
  rcGate?: boolean;
  rcLength?: number;       // trailing window for the regression (default 50)
  rcK?: number;            // SE multiplier for the channel (default 2.0)
}

export interface Rejection {
  confIdx: number;   // bar whose CLOSE confirmed the rejection
  fillIdx: number;   // confIdx + 1 — the bar we may enter on, at its open
  dir: 'long' | 'short';
  band: number;      // the band price that was rejected
  extreme: number;   // the rejection wick's extreme (stop reference)
  basis: number;     // basis at confirmation (mean-reversion target reference)
  dev: number;
}

/**
 * Per-bar higher-timeframe context. Resolved once per signal bar from the
 * HIGHER TF series, using only higher-TF bars whose ts ≤ signal bar's ts.
 *
 * `confIdxHtf` is the index in `higherBars` of the most recent higher-TF bar
 * at-or-before the signal bar — we read its bands, basis, and basis-slope
 * FROM THAT POINT ONLY. Without this guard the simulator silently consults
 * the future (the next 60m bar's band) and looks great.
 */
export interface HtfContext {
  bars: OHLCBar[];
  bands: (FibBand | null)[];
  /** basis[-slopeWindow..-1] — basis[-1] = latest known, basis[-slopeWindow] = oldest in window. */
  slopeWindow: number;
}

/** Look up the higher-TF context for a signal bar. Pure prefix lookup. */
export function htfAt(
  htf: HtfContext, signalBars: OHLCBar[], signalIdx: number,
): { band: FibBand | null; basisSlope: number } {
  const ts = signalBars[signalIdx].ts;
  // Binary search: last htf bar with ts <= ts. Pure prefix from the past.
  let lo = 0, hi = htf.bars.length - 1, confIdxHtf = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htf.bars[mid].ts <= ts) { confIdxHtf = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (confIdxHtf < 0) return { band: null, basisSlope: 0 };

  // Per-bar basis series (matching fibBands indices). Avoids leaking the dev
  // into downstream code that might want to read "just the basis".
  const basis = htf.bands[confIdxHtf];
  const k = htf.slopeWindow;
  const olderIdx = confIdxHtf - k;
  const older = olderIdx >= 0 ? htf.bands[olderIdx] : null;
  const slope = basis && older
    ? (basis.basis - older.basis) / Math.max(1e-9, basis.basis)
    : 0;
  return { band: basis, basisSlope: slope };
}

/**
 * Rejections across a series. `bands` must be fibBands(bars, ...) for the SAME
 * series. A signal is only emitted when a fill bar exists after it, so the last
 * bar can never produce one.
 *
 * Optional higher-TF confluence (cycle 1):
 *   - `requireHtfBand`: 0 disables. N>0 → the rejection wick's extreme must
 *     be within `htfWickTouchAtr × ATR(signalTF, confIdx)` of the same-side
 *     higher-TF band. A rejection that lands "at" a higher-TF level is not a
 *     stretched-band artifact; it's at a real structural line.
 *   - `requireHtfSlopeAgreement`: false → don't filter on higher-TF slope.
 *     true → higher-TF basis slope must agree with trade direction (positive
 *     slope for longs, negative for shorts). Slope is the percentage change
 *     over `slopeWindow` higher-TF bars, computed from a pure prefix of the
 *     higher-TF series.
 */
export function detectRejections(
  bars: OHLCBar[], bands: (FibBand | null)[], o: RejectOpts,
  htf?: HtfContext,
  htfWickTouchAtr?: number,
  requireHtfSlopeAgreement?: boolean,
  signalAtr?: number[],
  rc?: (RegChannel | null)[],
): Rejection[] {
  const out: Rejection[] = [];
  const useHtf = htf !== undefined && (
    (htfWickTouchAtr !== undefined && htfWickTouchAtr > 0) || requireHtfSlopeAgreement === true
  );
  // We need signal-TF ATR for the touch threshold. Defer to caller via Precomputed
  // when available; otherwise 0 (no-op threshold).
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bands[i];
    if (!b) continue;
    const bar = bars[i];
    const range = bar.high - bar.low;
    if (!(range > 0)) continue;

    let dir: 'long' | 'short', band: number, extreme: number;
    if (o.dir === 'short') {
      band = bandPrice(b, o.entryRatio, 'upper');
      if (!(bar.high >= band && bar.close < band)) continue;
      const wick = bar.high - Math.max(bar.open, bar.close);
      if (wick / range < o.wickFrac) continue;
      dir = 'short'; extreme = bar.high;
    } else {
      band = bandPrice(b, o.entryRatio, 'lower');
      if (!(bar.low <= band && bar.close > band)) continue;
      const wick = Math.min(bar.open, bar.close) - bar.low;
      if (wick / range < o.wickFrac) continue;
      dir = 'long'; extreme = bar.low;
    }

    // ── Multi-band sequence gate ────────────────────────────────────────
    // Require that an OUTER band (seqRatio) was touched within seqWindow
    // bars before this rejection. Models "stretched through 0.618 to 0.786,
    // THEN rejected" instead of a one-bar flicker. Pure prefix: only looks
    // at bars [i-seqWindow, i-1].
    if (o.seqRatio && o.seqRatio > 0 && o.seqRatio < o.entryRatio) {
      const win = o.seqWindow ?? 5;
      const seqBand = dir === 'short'
        ? bandPrice(b, o.seqRatio, 'upper')
        : bandPrice(b, o.seqRatio, 'lower');
      let seqHit = false;
      for (let k = Math.max(0, i - win); k < i; k++) {
        const kb = bands[k];
        if (!kb) continue;
        const sb = dir === 'short' ? bandPrice(kb, o.seqRatio, 'upper') : bandPrice(kb, o.seqRatio, 'lower');
        const touched = dir === 'short' ? bars[k].high >= sb : bars[k].low <= sb;
        if (touched) { seqHit = true; break; }
      }
      // seqBand value computed above for documentation; the actual check uses
      // per-bar seqRatio levels (bands move). If no prior outer-band touch,
      // this rejection is a flicker, not a stretch — skip it.
      if (!seqHit) continue;
    }

    // ── Time-of-day window ──────────────────────────────────────────────
    // ET minutes-of-day. Only fire inside [todStartMin, todEndMin]. Midday
    // avoids the open spike (noise) and the close acceleration (trend).
    if (o.todStartMin != null && o.todEndMin != null) {
      const etMin = etMinutesOfDay(bar.ts);
      if (etMin < o.todStartMin || etMin > o.todEndMin) continue;
    }

    // ── Regression-channel confirmation ─────────────────────────────────
    // Require the rejection bar's extreme to also breach the RC boundary
    // (trend-based extreme). Unlike the HTF gate (which was a no-op due to
    // the 5m vs 60m magnitude gap), the RC is computed on the SAME TF, so a
    // 1m bar CAN exceed its own 1m RC. This confirms "stretched beyond trend"
    // in addition to "stretched beyond band."
    if (o.rcGate && rc) {
      const rcBar = rc[i];
      if (!rcBar) continue;   // warm-up
      if (dir === 'short' && bar.high < rcBar.upper) continue;
      if (dir === 'long' && bar.low > rcBar.lower) continue;
    }

    if (useHtf) {
      const ctx = htfAt(htf!, bars, i);
      if (!ctx.band) continue;                                // no history yet
      if (requireHtfSlopeAgreement) {
        if (dir === 'long' && ctx.basisSlope <= 0) continue;
        if (dir === 'short' && ctx.basisSlope >= 0) continue;
      }
      if (htfWickTouchAtr && htfWickTouchAtr > 0) {
        // Touch distance to the HIGHER-TF BASIS, not to the higher-TF band.
        // The 60m 1.0 band sits tens of points away from typical 5m extremes
        // and is never "touched" — the test would be a no-op. The basis is
        // the structural line: a rejection whose wick reaches back through
        // (or near) the 60m mean is rejecting at a real level.
        const atr = (signalAtr !== undefined ? signalAtr[i] : range);
        if (Math.abs(extreme - ctx.band.basis) > htfWickTouchAtr * atr) continue;
      }
    }

    out.push({ confIdx: i, fillIdx: i + 1, dir, band, extreme, basis: b.basis, dev: b.dev });
  }
  return out;
}

/** Where to take profit. `band` ratios are inner bands; `r` is a stop multiple. */
export type TargetSpec =
  | { kind: 'basis' }
  | { kind: 'band'; ratio: number }
  | { kind: 'r'; mult: number };

export interface SimOpts extends RejectOpts {
  length: number;
  mult: number;
  atrPeriod: number;
  /** Stop is placed this many ATRs beyond the rejection wick's extreme. */
  stopBufAtr: number;
  /**
   * Skip setups whose defined risk is below this many ATRs. When the fill bar
   * opens right next to the rejection wick the stop lands a point or two away —
   * untradeable (it sits inside the spread and is noise-stopped), and it poisons
   * any R-based statistic because a 1.5-point risk turns a normal move into 10R.
   */
  minRiskAtr: number;
  target: TargetSpec;
  /** Flatten at the last bar of each ET session (no overnight hold). */
  sessionExit: boolean;
  /**
   * Cycle-1 confluence: a rejection only counts when its wick's extreme is
   * within `htfWickTouchAtr × signalATR` of the same-side band on the
   * higher-TF series (`htf` in Precomputed). 0 disables.
   */
  htfWickTouchAtr?: number;
  /** Cycle-1 confluence: filter on higher-TF basis slope direction. */
  requireHtfSlopeAgreement?: boolean;
  /**
   * Cycle-2 exit: take profit when price crosses the higher-TF basis in the
   * favourable direction (basis-cross-above for longs, cross-below for shorts);
   * cut and FLIP the position when it crosses in the unfavourable direction.
   * A 'flat' target closes normally without flipping. 0 / undefined → no flip.
   */
  htfFlipOnCross?: boolean;
}

/** Reusable per-series arrays, so a sweep need not rebuild them per config. */
export interface Precomputed {
  bands: (FibBand | null)[];  // must be fibBands(bars, o.length, o.mult)
  atr: number[];              // must be rollingATR(bars, o.atrPeriod)
  lastOfDay?: Set<number>;    // must be lastBarOfSessionIdx(bars)
  /**
   * Higher-timeframe context for confluence (cycle 1) and exit/flip (cycle 2).
   * Look-ahead is the obvious landmine here — see htfAt() for the prefix-only
   * lookup. The simulator resolves `htf` once per signal bar from `pre.htf`.
   */
  htf?: HtfContext;
  /** Regression channel for the rcGate (same TF). Must be regressionChannel(bars, o.rcLength, o.rcK). */
  rc?: (RegChannel | null)[];
}

/** Indices of the last bar of each ET session — the flatten-at-close backstop. */
export function lastBarOfSessionIdx(bars: OHLCBar[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < bars.length; i++) {
    if (i === bars.length - 1 || etDate(bars[i].ts) !== etDate(bars[i + 1].ts)) out.add(i);
  }
  return out;
}

export type ExitReason = 'stop' | 'target' | 'session' | 'eod' | 'htfCross';

export interface Trade {
  dir: 'long' | 'short';
  entry: number; stop: number; target: number;
  exitPrice: number;
  exitReason: ExitReason;
  pnlPts: number;   // index points, before friction
  r: number;        // pnlPts / risk defined at entry
  risk: number;
  entryTs: number; exitTs: number;
  entryIdx: number; exitIdx: number;
  barsHeld: number;
}

/**
 * ET calendar date 'YYYY-MM-DD' for a unix-seconds timestamp.
 * Memoised by UTC day: toLocaleDateString is slow enough that a sweep calling
 * it once per bar per config spends most of its runtime in date formatting.
 */
// Keyed by UTC HOUR, not day: ET calendar-date boundaries always fall on an
// hour boundary, so the date is constant within a bucket for both EST and EDT.
// Keying by UTC day would mis-stamp bars before the ET midnight rollover.
const etDateCache = new Map<number, string>();
export function etDate(ts: number): string {
  const hourKey = Math.floor(ts / 3600);
  let d = etDateCache.get(hourKey);
  if (d === undefined) {
    d = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    etDateCache.set(hourKey, d);
  }
  return d;
}

/** ET minutes-of-day (0..1439) for a unix-seconds timestamp. Memoised by hour. */
const etMinCache = new Map<number, number>();
export function etMinutesOfDay(ts: number): number {
  const hourKey = Math.floor(ts / 3600);
  let m = etMinCache.get(hourKey);
  if (m === undefined) {
    const parts = new Date(ts * 1000).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).split(':');
    m = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    etMinCache.set(hourKey, m);
  }
  return m;
}

/**
 * Simulate one config on one OHLC series. One position at a time; a new signal
 * is ignored while a position is open. Entry is always the fill bar's OPEN.
 *
 * Degenerate setups are skipped rather than fudged: if the stop is not on the
 * losing side of entry, or the target is not on the winning side, there is no
 * trade. That happens when the fill bar gaps past the level, and pretending
 * otherwise would manufacture free money.
 */
export function simulate(bars: OHLCBar[], o: SimOpts, pre?: Precomputed): Trade[] {
  const trades: Trade[] = [];
  if (bars.length < o.length + 2) return trades;

  // Bands depend only on (series, length, mult) and ATR only on (series,
  // atrPeriod), so a sweep can compute each once and hand them in. Both are
  // still derived from bars <= i, so passing them in changes nothing about the
  // look-ahead guarantee — only how many times the same array is built.
  const bands = pre?.bands ?? fibBands(bars, o.length, o.mult);
  const atr = pre?.atr ?? rollingATR(bars, o.atrPeriod);
  const sigs = detectRejections(
    bars, bands, o, pre?.htf, o.htfWickTouchAtr, o.requireHtfSlopeAgreement, atr, pre?.rc,
  );
  const long = o.dir === 'long';

  const lastOfDay = o.sessionExit
    ? (pre?.lastOfDay ?? lastBarOfSessionIdx(bars))
    : new Set<number>();

  let busyUntil = -1;
  for (const s of sigs) {
    if (s.fillIdx <= busyUntil) continue;

    const entry = bars[s.fillIdx].open;
    const buf = o.stopBufAtr * atr[s.confIdx];
    const stop = long ? s.extreme - buf : s.extreme + buf;
    const risk = long ? entry - stop : stop - entry;
    if (!(risk > 0)) continue;
    if (risk < o.minRiskAtr * atr[s.confIdx]) continue;

    let target: number;
    if (o.target.kind === 'basis') target = s.basis;
    else if (o.target.kind === 'band') target = long
      ? s.basis - o.target.ratio * s.dev
      : s.basis + o.target.ratio * s.dev;
    else target = long ? entry + o.target.mult * risk : entry - o.target.mult * risk;
    // When an HTF context is available, the basis-cross exit supersedes the
    // static signal-TF basis target — we don't need a target on the winning
    // side of entry to enter, because the structural exit will catch it.
    if (!pre?.htf) {
      if (long ? !(target > entry) : !(target < entry)) continue;
    }

    let exitReason: ExitReason = 'eod';
    let exitPrice = bars[bars.length - 1].close;
    let exitIdx = bars.length - 1;
    // Cycle-2: higher-TF basis crossing. `prevHtfBasis` is the basis as of the
    // last bar; we only fire on a TRUE cross (current vs prior), so a bar that
    // opens on the wrong side of basis doesn't instantly exit.
    let prevHtfBasis: number | null = null;
    if (pre?.htf) {
      const ctx0 = htfAt(pre.htf, bars, s.fillIdx);
      if (ctx0.band) prevHtfBasis = ctx0.band.basis;
    }
    for (let i = s.fillIdx; i < bars.length; i++) {
      const bar = bars[i];
      const hitStop = long ? bar.low <= stop : bar.high >= stop;
      const hitTgt = long ? bar.high >= target : bar.low <= target;

      // Cycle-2 basis-cross check happens BEFORE the static target/stop so a
      // tight target doesn't pre-empt a more meaningful structural exit.
      let htfCrossDir: 'favour' | 'against' | null = null;
      if (pre?.htf) {
        const ctx = htfAt(pre.htf, bars, i);
        if (ctx.band && prevHtfBasis !== null) {
          const b = ctx.band.basis;
          // Long: cross-above = favour (we want to be long), cross-below = against.
          // Short: mirror.
          if (long) {
            if (prevHtfBasis <= b && bar.high >= b) htfCrossDir = 'favour';
            else if (prevHtfBasis >= b && bar.low <= b) htfCrossDir = 'against';
          } else {
            if (prevHtfBasis >= b && bar.low <= b) htfCrossDir = 'favour';
            else if (prevHtfBasis <= b && bar.high >= b) htfCrossDir = 'against';
          }
        }
        if (ctx.band) prevHtfBasis = ctx.band.basis;
      }

      if (htfCrossDir === 'favour' && (o.target.kind === 'basis' || pre?.htf)) {
        // Take profit at the higher-TF basis level on a favourable cross.
        // We don't know basis intra-bar; resolve at bar close (the conservative
        // choice when a wick may have spiked past the basis but the close is
        // still on our side).
        const ctx = htfAt(pre!.htf!, bars, i);
        if (ctx.band) {
          exitReason = 'htfCross'; exitPrice = ctx.band.basis; exitIdx = i; break;
        }
      }
      // Unfavourable cross is treated the same way (early exit at the basis)
      // — the "flip" idea risked ping-pong loops around a flat basis. Letting
      // the next NATURAL signal in the opposite direction fire is cleaner.
      if (htfCrossDir === 'against') {
        const ctx = htfAt(pre!.htf!, bars, i);
        if (ctx.band) {
          exitReason = 'htfCross'; exitPrice = ctx.band.basis; exitIdx = i; break;
        }
      }

      if (hitStop) { exitReason = 'stop'; exitPrice = stop; exitIdx = i; break; }   // stop-first when ambiguous
      if (hitTgt) { exitReason = 'target'; exitPrice = target; exitIdx = i; break; }
      if (lastOfDay.has(i)) { exitReason = 'session'; exitPrice = bar.close; exitIdx = i; break; }
    }

    const pnlPts = long ? exitPrice - entry : entry - exitPrice;
    busyUntil = exitIdx;
    trades.push({
      dir: o.dir, entry, stop, target, exitPrice, exitReason,
      pnlPts, r: pnlPts / risk, risk,
      entryTs: bars[s.fillIdx].ts, exitTs: bars[exitIdx].ts,
      entryIdx: s.fillIdx, exitIdx, barsHeld: exitIdx - s.fillIdx,
    });
  }
  return trades;
}

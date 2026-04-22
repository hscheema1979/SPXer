/**
 * Core indicator engine — shared by both live pipeline and replay.
 * Computes HMA, EMA, RSI, BB, ATR, VWAP, KC and tier-2 indicators incrementally.
 */
import type { Bar, IndicatorState, Timeframe } from '../types';
import { computeEMA, computeRSI, computeBB, computeATR, computeVWAP, makeHMAState, hmaStep, makeKCState, kcStep } from '../pipeline/indicators/tier1';
import { computeMACD, computeStochastic, computeADX, computeMomentum, computeCCI } from '../pipeline/indicators/tier2';
import { MAX_BARS_MEMORY } from '../config';
import { pipelineHealth } from '../ops/pipeline-health';

const states = new Map<string, IndicatorState>();

/**
 * HMA periods the engine actively computes. Seeded with the periods that every
 * historical replay config already expects; extended at startup by
 * `registerHmaPeriod()` so configs can reference any integer period ≥2 and
 * have `hma${period}` appear on every bar.
 *
 * Why dynamic: the signal detector looks up `ind['hma${hmaCrossFast}']` and
 * `ind['hma${hmaCrossSlow}']`. A config requesting a period outside this set
 * produces `undefined` indicators and silently never fires a cross — the exact
 * failure mode that left the live agent sidelined all day on 2026-04-20 with
 * `hmaCrossSlow: 12`. Registering the period adds it to this set before any
 * bar flows.
 */
const DEFAULT_HMA_PERIODS = [3, 5, 15, 17, 19, 25] as const;
const activeHmaPeriods = new Set<number>(DEFAULT_HMA_PERIODS);

/** Register an HMA period with the indicator engine. Idempotent. Safe to call
 *  many times at startup (e.g. once per config loaded from the DB). */
export function registerHmaPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error(`[indicator-engine] registerHmaPeriod: invalid period ${period} (must be integer ≥2)`);
  }
  activeHmaPeriods.add(period);
}

/** All HMA periods currently computed by the engine, sorted ascending. */
export function getActiveHmaPeriods(): number[] {
  return Array.from(activeHmaPeriods).sort((a, b) => a - b);
}

function key(symbol: string, tf: Timeframe): string { return `${symbol}:${tf}`; }

function getState(symbol: string, tf: Timeframe): IndicatorState {
  const k = key(symbol, tf);
  if (!states.has(k)) {
    states.set(k, {
      closes: [], highs: [], lows: [], volumes: [], typicalPrices: [],
      cumulativeTPV: 0, cumulativeVol: 0,
      emaState: {}, macdState: { fastEma: null, slowEma: null, signalEma: null },
      atrState: null, adxState: { plusDM: null, minusDM: null, tr: null, adx: null },
      hmaState: {},
      kcState: null,
    });
  }
  return states.get(k)!;
}

export function resetVWAP(symbol: string, tf: Timeframe): void {
  const s = getState(symbol, tf);
  s.cumulativeTPV = 0;
  s.cumulativeVol = 0;
}

export function seedIndicatorState(symbol: string, tf: Timeframe, bars: Bar[]): void {
  const s = getState(symbol, tf);
  // Filter out bars with non-finite OHLC before seeding — a single NaN in the
  // seed history would poison all HMA/EMA state for the entire session.
  const cleanBars = bars.filter(b =>
    Number.isFinite(b.close) && Number.isFinite(b.high) &&
    Number.isFinite(b.low)   && Number.isFinite(b.open) &&
    b.close > 0
  );
  if (cleanBars.length < bars.length) {
    console.warn(`[indicator-engine] seedIndicatorState ${symbol}@${tf}: filtered ${bars.length - cleanBars.length} invalid bars`);
    pipelineHealth.indicators.seedsFailed++;
  } else {
    pipelineHealth.indicators.seedsCompleted++;
  }
  s.closes = cleanBars.map(b => b.close).slice(-MAX_BARS_MEMORY);
  s.highs  = cleanBars.map(b => b.high).slice(-MAX_BARS_MEMORY);
  s.lows   = cleanBars.map(b => b.low).slice(-MAX_BARS_MEMORY);
  s.volumes = cleanBars.map(b => b.volume).slice(-MAX_BARS_MEMORY);
  // Re-seed incremental HMA state by replaying closes through hmaStep.
  // Iterates the dynamic set so any period registered via registerHmaPeriod()
  // gets seeded too.
  for (const period of getActiveHmaPeriods()) {
    const hma = makeHMAState(period);
    for (const c of s.closes) hmaStep(hma, c);
    s.hmaState[period] = hma;
  }
}

export function computeIndicators(bar: Bar, tier: 1 | 2 = 1): Record<string, number | null> {
  const s = getState(bar.symbol, bar.timeframe as Timeframe);

  // Guard: reject bars with non-finite price values before they touch indicator state.
  // A single NaN close would poison HMA/EMA buffers for the entire session — all
  // subsequent indicator values would return NaN and signals would silently stop firing.
  if (!Number.isFinite(bar.close) || !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low)   || !Number.isFinite(bar.open) ||
      bar.close <= 0) {
    console.error(`[indicator-engine] NaN/invalid bar rejected: ${bar.symbol}@${bar.timeframe} ts=${bar.ts} close=${bar.close}`);
    pipelineHealth.indicators.nanRejected++;
    // Return last known indicator values rather than empty object — callers get
    // stale-but-valid indicators rather than undefined, preventing false signal misfires.
    return s.lastIndicators ?? {};
  }

  s.closes.push(bar.close);
  s.highs.push(bar.high);
  s.lows.push(bar.low);
  s.volumes.push(bar.volume);
  if (s.closes.length > MAX_BARS_MEMORY) {
    s.closes.shift(); s.highs.shift(); s.lows.shift(); s.volumes.shift();
  }

  const vwapResult = computeVWAP(bar.close, bar.high, bar.low, bar.volume, s.cumulativeTPV, s.cumulativeVol);
  s.cumulativeTPV = vwapResult.cumTPV;
  s.cumulativeVol = vwapResult.cumVol;

  for (const p of [9, 21]) {
    s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
  }

  // Incremental HMA — O(period) per call, not O(n²). The set of periods is
  // dynamic (defaults + anything registered via registerHmaPeriod at startup),
  // so a config requesting e.g. hmaCrossSlow=12 produces ind['hma12'] on every
  // bar instead of silently going missing.
  const hmaValues: Record<number, number | null> = {};
  for (const period of getActiveHmaPeriods()) {
    if (!s.hmaState[period]) s.hmaState[period] = makeHMAState(period);
    hmaValues[period] = hmaStep(s.hmaState[period], bar.close);
  }

  const bb = computeBB(s.closes, 20, 2);

  // Incremental Keltner Channel computation
  if (!s.kcState) s.kcState = makeKCState(20, 14, 2.5, 5);
  const prevClose = s.closes.length > 1 ? s.closes[s.closes.length - 2] : null;
  const kc = kcStep(s.kcState, bar.close, bar.high, bar.low, prevClose);

  const ind: Record<string, number | null> = {
    ema9:  s.emaState[9],
    ema21: s.emaState[21],
    rsi14: computeRSI(s.closes, 14),
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    bbWidth: bb?.width ?? null,
    atr14: computeATR(s.highs, s.lows, s.closes, 14),
    atrPct: s.closes.length > 1 ? (computeATR(s.highs, s.lows, s.closes, 14) / bar.close) * 100 : null,
    vwap: vwapResult.vwap,
    kcUpper: kc?.upper ?? null,
    kcMiddle: kc?.middle ?? null,
    kcLower: kc?.lower ?? null,
    kcWidth: kc?.width ?? null,
    kcSlope: kc?.slope ?? null,
  };

  // Emit hma${period} for every active period so downstream consumers
  // (signal-detector, dashboards, replay bar cache) can look them up by name.
  for (const period of getActiveHmaPeriods()) {
    ind[`hma${period}`] = hmaValues[period] ?? null;
  }

  if (tier === 2) {
    for (const p of [50, 200]) {
      s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
    }
    const macdResult = computeMACD(bar.close, s.macdState.fastEma, s.macdState.slowEma, s.macdState.signalEma);
    s.macdState = { fastEma: macdResult.fastEma, slowEma: macdResult.slowEma, signalEma: macdResult.signalEma };

    ind['ema50'] = s.emaState[50];
    ind['ema200'] = s.emaState[200];
    ind['macd'] = macdResult.macd;
    ind['macdSignal'] = macdResult.signalEma;
    ind['macdHistogram'] = macdResult.histogram;
    ind['stochK'] = computeStochastic(s.highs, s.lows, s.closes, 14, 3)?.k ?? null;
    ind['cci20'] = computeCCI(s.highs, s.lows, s.closes, 20);
    ind['momentum10'] = computeMomentum(s.closes, 10);
    ind['adx14'] = computeADX(s.highs, s.lows, s.closes, 14);
  }

  // Cache last known-good indicators for NaN fallback
  s.lastIndicators = ind;

  pipelineHealth.indicators.computed++;
  return ind;
}

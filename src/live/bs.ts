/**
 * bs.ts — Black-Scholes delta computed live, per minute.
 *
 * Why: Tradier's greeks come from ORATS and only refresh ~hourly, so the
 * `delta` field on a chain snapshot can be stale by up to an hour relative to
 * where the underlying actually is. We store Tradier's greeks as-is (useful,
 * and includes gamma/theta/vega) AND a `bs_delta` recomputed every minute from
 * the *live* underlying price + the contract's IV, so the delta tracks spot in
 * real time.
 *
 * We reuse Tradier's implied vol as sigma rather than re-solving IV from mid —
 * IV is the slow-moving input; underlying + time-to-expiry are the fast ones,
 * and those we supply fresh.
 */

/** Annualized risk-free rate used for delta. Delta is nearly insensitive to r. */
const RISK_FREE_RATE = 0.045;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (max err ~7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p =
    d * t * (0.31938153 +
      t * (-0.356563782 +
        t * (1.781477937 +
          t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes delta.
 * @param spot        underlying price (S)
 * @param strike      option strike (K)
 * @param secsToExp   seconds until expiry settlement
 * @param sigma       implied volatility (annualized, e.g. 0.18)
 * @param isCall      call vs put
 * @returns delta in [-1, 1], or null if inputs are unusable.
 */
export function bsDelta(
  spot: number,
  strike: number,
  secsToExp: number,
  sigma: number,
  isCall: boolean,
): number | null {
  if (!(spot > 0) || !(strike > 0) || !(sigma > 0)) return null;
  // At/after expiry: delta collapses to the payoff indicator.
  if (secsToExp <= 0) {
    if (isCall) return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const T = secsToExp / SECONDS_PER_YEAR;
  const d1 =
    (Math.log(spot / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) /
    (sigma * Math.sqrt(T));
  const nd1 = normCdf(d1);
  return isCall ? nd1 : nd1 - 1;
}

/** Black-Scholes theoretical price (used to invert IV from a mid quote). */
export function bsPrice(
  spot: number,
  strike: number,
  secsToExp: number,
  sigma: number,
  isCall: boolean,
): number {
  if (secsToExp <= 0 || sigma <= 0) {
    const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return intrinsic;
  }
  const T = secsToExp / SECONDS_PER_YEAR;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-RISK_FREE_RATE * T);
  return isCall
    ? spot * normCdf(d1) - strike * disc * normCdf(d2)
    : strike * disc * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Implied volatility from a mid price via bisection. Fallback for when Tradier
 * doesn't carry an ORATS IV on a contract, so bs_delta stays populated.
 * Returns null if the mid is below intrinsic or outside a solvable range.
 */
export function impliedVolFromMid(
  spot: number,
  strike: number,
  secsToExp: number,
  mid: number,
  isCall: boolean,
): number | null {
  if (!(spot > 0) || !(strike > 0) || !(mid > 0) || secsToExp <= 0) return null;
  const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  if (mid < intrinsic - 1e-6) return null; // arb / stale quote
  let lo = 1e-4;
  let hi = 5;
  if (bsPrice(spot, strike, secsToExp, hi, isCall) < mid) return null; // beyond vol ceiling
  for (let i = 0; i < 60; i++) {
    const midVol = (lo + hi) / 2;
    const price = bsPrice(spot, strike, secsToExp, midVol, isCall);
    if (Math.abs(price - mid) < 1e-4) return midVol;
    if (price < mid) lo = midVol;
    else hi = midVol;
  }
  return (lo + hi) / 2;
}

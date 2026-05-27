/**
 * black-scholes.ts
 *
 * Minimal European Black-Scholes: delta, put price, and implied-vol inversion.
 *
 * The multi-DTE sweep selects short strikes by DELTA, but neither Polygon flat
 * files nor (pre-2026) ThetaData expose NDXP greeks. So we compute delta
 * ourselves: invert implied vol from the option's mid price + underlying + T,
 * then evaluate BS delta. Approximate (mid-based, flat rate, no dividends) but
 * uniform across the whole backtest history.
 *
 * Conventions: T in YEARS, rate as a decimal (0.04 = 4%), vol annualized.
 */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, ~1e-7 accuracy). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2); // 1/sqrt(2pi) * e^(-x^2/2)
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function d1(spot: number, strike: number, T: number, vol: number, rate: number): number {
  return (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * T) / (vol * Math.sqrt(T));
}

/** Call delta = N(d1). */
export function bsCallDelta(spot: number, strike: number, T: number, vol: number, rate: number): number {
  if (T <= 0 || vol <= 0) return spot > strike ? 1 : 0;
  return normCdf(d1(spot, strike, T, vol, rate));
}

/** Put delta = N(d1) - 1 (negative). */
export function bsPutDelta(spot: number, strike: number, T: number, vol: number, rate: number): number {
  if (T <= 0 || vol <= 0) return spot < strike ? -1 : 0;
  return normCdf(d1(spot, strike, T, vol, rate)) - 1;
}

/** European put price. */
export function bsPutPrice(spot: number, strike: number, T: number, vol: number, rate: number): number {
  if (T <= 0 || vol <= 0) return Math.max(0, strike - spot);
  const dd1 = d1(spot, strike, T, vol, rate);
  const dd2 = dd1 - vol * Math.sqrt(T);
  return strike * Math.exp(-rate * T) * normCdf(-dd2) - spot * normCdf(-dd1);
}

/**
 * Implied vol of a put from its price, via bisection. Returns null when the
 * price is not arbitrage-consistent (≤0, or below intrinsic so no positive vol
 * can reproduce it). Bisection over [1e-4, 5.0] — robust, no derivative needed.
 */
export function impliedVolFromPut(
  price: number,
  spot: number,
  strike: number,
  T: number,
  rate: number,
  tol = 1e-6,
  maxIter = 100
): number | null {
  if (price <= 0 || T <= 0) return null;
  const intrinsic = Math.max(0, strike * Math.exp(-rate * T) - spot);
  if (price < intrinsic - 1e-9) return null; // below discounted intrinsic → no real IV

  let lo = 1e-4;
  let hi = 5.0;
  const pLo = bsPutPrice(spot, strike, T, lo, rate);
  const pHi = bsPutPrice(spot, strike, T, hi, rate);
  // Price must be bracketed by the vol range.
  if (price < pLo - 1e-9 || price > pHi + 1e-9) return null;

  for (let i = 0; i < maxIter; i++) {
    const mid = 0.5 * (lo + hi);
    const pMid = bsPutPrice(spot, strike, T, mid, rate);
    if (Math.abs(pMid - price) < tol) return mid;
    if (pMid < price) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

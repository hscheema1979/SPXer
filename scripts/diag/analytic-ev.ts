/**
 * analytic-ev.ts  —  Closed-form expected value of a defined-risk credit spread
 *
 * Calculate-first (NOT backtest-first): the EV of a vertical credit spread held to
 * expiry is a deterministic integral over the terminal-price distribution — no
 * sampling, no overfit. We compute it in CLOSED FORM under a lognormal model and
 * cross-check with Monte Carlo in the tests.
 *
 * Two measures, two questions:
 *   • Risk-neutral (μ = r, σ = IV):  E_Q[payoff] discounted == market price. So a
 *     spread priced at its own IV has EV ≈ −friction. NO edge by construction — this
 *     is the sanity baseline (the video's point: model≡market under the model measure).
 *   • Real-world forecast (μ = drift, σ = σ_forecast):  the seller's edge is the gap
 *     between the IV-rich credit received and the payoff expected under the REALIZED
 *     distribution. σ_forecast < IV (the variance risk premium) ⇒ positive EV.
 *
 * Everything is per CONTRACT (× `mult`, default 100). Units-agnostic in price, so it
 * works for SPX or XSP unchanged — feed XSP spot/strikes (SPX/10) and a 5-pt wing and
 * you get the XSP per-contract EV directly (1/10 of the SPX number, same shape/tail).
 *
 * Payoff expectations use the Black (forward) formula:
 *   E[(K−S_T)^+] = K·N(−d2) − F·N(−d1),   F = S0·e^{μT},  d1,d2 as in BS.
 */
import { normCdf, bsPutPrice, bsCallPrice } from './black-scholes';

/** Undiscounted E[(K − S_T)^+] under lognormal(drift μ, vol σ). */
export function expectedPutPayoff(S0: number, K: number, T: number, sigma: number, mu: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, K - S0 * Math.exp(mu * T));
  const F = S0 * Math.exp(mu * T), sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sq, d2 = d1 - sq;
  return K * normCdf(-d2) - F * normCdf(-d1);
}

/** Undiscounted E[(S_T − K)^+] under lognormal(drift μ, vol σ). */
export function expectedCallPayoff(S0: number, K: number, T: number, sigma: number, mu: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, S0 * Math.exp(mu * T) - K);
  const F = S0 * Math.exp(mu * T), sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sq, d2 = d1 - sq;
  return F * normCdf(d1) - K * normCdf(d2);
}

/** P(S_T > x) under lognormal(drift μ, vol σ). */
export function probAbove(S0: number, x: number, T: number, sigma: number, mu: number): number {
  if (x <= 0) return 1;
  if (T <= 0 || sigma <= 0) return S0 * Math.exp(mu * T) > x ? 1 : 0;
  const m = Math.log(S0) + (mu - 0.5 * sigma * sigma) * T, s = sigma * Math.sqrt(T);
  return normCdf((m - Math.log(x)) / s);
}

export interface CreditSpreadInput {
  side: 'put' | 'call';
  S0: number;              // spot at entry
  Ks: number;              // SHORT strike
  Kl: number;              // LONG (protective) strike — further OTM
  T: number;               // years to expiry
  credit: number;          // credit received per share (observed market, or model-priced)
  sigmaForecast: number;   // REAL-WORLD vol forecast for the EV (e.g. realized-vol forecast)
  muForecast?: number;     // real-world drift (default = rate)
  rate?: number;           // risk-free (default 0.04)
  frictionPerContract?: number;   // $ per contract (default 0)
  mult?: number;           // contract multiplier (default 100)
}

export interface CreditSpreadEV {
  evPerContract: number;        // $ expected value under the forecast distribution
  expSpreadValue: number;       // E[spread payoff at expiry] per share (∈ [0, width])
  probProfit: number;           // P(net P&L > 0)
  probMaxLoss: number;          // P(short fully ITM → max loss)
  breakeven: number;            // terminal price where net P&L = 0
  maxProfit: number;            // $ per contract
  maxLoss: number;              // $ per contract (the number to size against)
  width: number;
  returnOnRisk: number;         // evPerContract / maxLoss
  evRatio: number;              // evPerContract / |worst| proxy (= returnOnRisk); 1/this ≈ losses-per-edge
}

/**
 * Closed-form EV of a defined-risk vertical credit spread held to expiry, under a
 * lognormal forecast distribution. `credit` is the premium received (per share); the
 * EV is credit − E_forecast[spread payoff] − friction.
 */
export function creditSpreadEV(inp: CreditSpreadInput): CreditSpreadEV {
  const mult = inp.mult ?? 100, fric = inp.frictionPerContract ?? 0;
  const rate = inp.rate ?? 0.04, mu = inp.muForecast ?? rate;
  const width = Math.abs(inp.Ks - inp.Kl);
  const creditNet = inp.credit - fric / mult;   // breakeven uses net-of-friction credit

  let expSpread: number, probProfit: number, probMaxLoss: number, breakeven: number;
  if (inp.side === 'put') {
    // long must be below short
    expSpread = expectedPutPayoff(inp.S0, inp.Ks, inp.T, inp.sigmaForecast, mu)
              - expectedPutPayoff(inp.S0, inp.Kl, inp.T, inp.sigmaForecast, mu);
    breakeven = inp.Ks - creditNet;                                   // profit if S_T > breakeven
    probProfit = probAbove(inp.S0, breakeven, inp.T, inp.sigmaForecast, mu);
    probMaxLoss = 1 - probAbove(inp.S0, inp.Kl, inp.T, inp.sigmaForecast, mu);   // S_T ≤ Kl
  } else {
    expSpread = expectedCallPayoff(inp.S0, inp.Ks, inp.T, inp.sigmaForecast, mu)
              - expectedCallPayoff(inp.S0, inp.Kl, inp.T, inp.sigmaForecast, mu);
    breakeven = inp.Ks + creditNet;                                   // profit if S_T < breakeven
    probProfit = 1 - probAbove(inp.S0, breakeven, inp.T, inp.sigmaForecast, mu);
    probMaxLoss = probAbove(inp.S0, inp.Kl, inp.T, inp.sigmaForecast, mu);       // S_T ≥ Kl
  }
  const evPerContract = (inp.credit - expSpread) * mult - fric;
  const maxProfit = inp.credit * mult - fric;
  const maxLoss = (width - inp.credit) * mult + fric;
  return {
    evPerContract, expSpreadValue: expSpread, probProfit, probMaxLoss, breakeven,
    maxProfit, maxLoss, width, returnOnRisk: evPerContract / maxLoss, evRatio: evPerContract / maxLoss,
  };
}

/** Model credit (per share) for a vertical priced at a single IV — convenience for
 *  feeding `creditSpreadEV` when you don't have an observed market credit. */
export function modelCredit(side: 'put' | 'call', S0: number, Ks: number, Kl: number, T: number, iv: number, rate = 0.04): number {
  return side === 'put'
    ? bsPutPrice(S0, Ks, T, iv, rate) - bsPutPrice(S0, Kl, T, iv, rate)
    : bsCallPrice(S0, Ks, T, iv, rate) - bsCallPrice(S0, Kl, T, iv, rate);
}

import { describe, it, expect } from 'vitest';
import {
  expectedPutPayoff, expectedCallPayoff, probAbove, creditSpreadEV, modelCredit,
} from '../../scripts/diag/analytic-ev';

// ── deterministic RNG so the Monte-Carlo cross-checks are reproducible ──
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormals(seed: number, n: number): number[] {
  const r = mulberry32(seed), out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box–Muller
    const u1 = Math.max(1e-12, r()), u2 = r();
    out.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return out;
}
// Simulate terminal prices S_T under lognormal(drift μ, vol σ).
function simTerminal(S0: number, T: number, sigma: number, mu: number, Z: number[]): number[] {
  const drift = (mu - 0.5 * sigma * sigma) * T, vol = sigma * Math.sqrt(T);
  return Z.map(z => S0 * Math.exp(drift + vol * z));
}

const S0 = 5000, T = 30 / 365, SIGMA = 0.18, MU = 0.04;
const Z = makeNormals(12345, 400_000);
const ST = simTerminal(S0, T, SIGMA, MU, Z);
const mcMean = (f: (s: number) => number) => ST.reduce((a, s) => a + f(s), 0) / ST.length;

describe('closed-form payoff expectations match Monte Carlo', () => {
  it('expectedPutPayoff ≈ E[(K−S_T)+]', () => {
    for (const K of [4700, 4900, 5000, 5100, 5300]) {
      const closed = expectedPutPayoff(S0, K, T, SIGMA, MU);
      const mc = mcMean(s => Math.max(0, K - s));
      expect(Math.abs(closed - mc)).toBeLessThan(0.6);   // ~$0.6 on a ~$5000 underlying
    }
  });

  it('expectedCallPayoff ≈ E[(S_T−K)+]', () => {
    for (const K of [4700, 4900, 5000, 5100, 5300]) {
      const closed = expectedCallPayoff(S0, K, T, SIGMA, MU);
      const mc = mcMean(s => Math.max(0, s - K));
      expect(Math.abs(closed - mc)).toBeLessThan(0.6);
    }
  });

  it('probAbove ≈ P(S_T > x)', () => {
    for (const x of [4600, 4900, 5000, 5100, 5400]) {
      const closed = probAbove(S0, x, T, SIGMA, MU);
      const mc = ST.filter(s => s > x).length / ST.length;
      expect(Math.abs(closed - mc)).toBeLessThan(0.004);
    }
  });

  it('put–call parity of payoff expectations: E[put]−E[call] = K·e^... − F (forward)', () => {
    const K = 5050;
    const F = S0 * Math.exp(MU * T);
    const lhs = expectedPutPayoff(S0, K, T, SIGMA, MU) - expectedCallPayoff(S0, K, T, SIGMA, MU);
    expect(Math.abs(lhs - (K - F))).toBeLessThan(1e-6);
  });
});

describe('no-edge baseline: risk-neutral measure → EV ≈ −friction', () => {
  // A spread priced at its own IV, evaluated under that same IV with μ=r, has zero
  // edge: the credit equals the expected payoff (undiscounted; 0DTE-ish T so discount≈1).
  for (const side of ['put', 'call'] as const) {
    it(`${side} spread priced at IV has EV ≈ −friction`, () => {
      const iv = 0.18, T0 = 1 / 365;       // ~1 day, discount ≈ 1
      const Ks = side === 'put' ? 4950 : 5050, Kl = side === 'put' ? 4900 : 5100;
      const credit = modelCredit(side, S0, Ks, Kl, T0, iv, MU);
      const ev = creditSpreadEV({ side, S0, Ks, Kl, T: T0, credit, sigmaForecast: iv, muForecast: MU, frictionPerContract: 0 });
      // undiscounted vs discounted credit leaves a tiny residual; should be ~0
      expect(Math.abs(ev.evPerContract)).toBeLessThan(2);
    });
  }
});

describe('the edge is the variance risk premium', () => {
  it('seller EV rises monotonically as forecast vol drops below IV', () => {
    const iv = 0.20, T0 = 7 / 365, Ks = 4900, Kl = 4850;
    const credit = modelCredit('put', S0, Ks, Kl, T0, iv, MU);   // priced at IV=0.20
    let prev = -Infinity;
    for (const sf of [0.20, 0.17, 0.14, 0.11]) {                  // forecast vol below IV
      const ev = creditSpreadEV({ side: 'put', S0, Ks, Kl, T: T0, credit, sigmaForecast: sf, muForecast: MU });
      expect(ev.evPerContract).toBeGreaterThan(prev);
      prev = ev.evPerContract;
    }
  });

  it('at σ_forecast = IV the EV is ≈0 (boundary of the VRP edge)', () => {
    const iv = 0.20, T0 = 7 / 365, Ks = 4900, Kl = 4850;
    const credit = modelCredit('put', S0, Ks, Kl, T0, iv, MU);
    const ev = creditSpreadEV({ side: 'put', S0, Ks, Kl, T: T0, credit, sigmaForecast: iv, muForecast: MU });
    expect(Math.abs(ev.evPerContract)).toBeLessThan(2);
  });
});

describe('structural invariants', () => {
  it('XSP (SPX/10) gives 1/10 the per-contract EV and max-loss, same probabilities', () => {
    const T0 = 7 / 365, iv = 0.20, sf = 0.15;
    const spx = creditSpreadEV({ side: 'put', S0: 5000, Ks: 4900, Kl: 4850, T: T0, credit: modelCredit('put', 5000, 4900, 4850, T0, iv, MU), sigmaForecast: sf, muForecast: MU });
    const xsp = creditSpreadEV({ side: 'put', S0: 500, Ks: 490, Kl: 485, T: T0, credit: modelCredit('put', 500, 490, 485, T0, iv, MU), sigmaForecast: sf, muForecast: MU });
    expect(Math.abs(xsp.evPerContract * 10 - spx.evPerContract)).toBeLessThan(1);
    expect(Math.abs(xsp.maxLoss * 10 - spx.maxLoss)).toBeLessThan(1);
    expect(Math.abs(xsp.probProfit - spx.probProfit)).toBeLessThan(1e-6);   // tail SHAPE is identical
  });

  it('probabilities and bounds are sane', () => {
    const T0 = 7 / 365;
    const ev = creditSpreadEV({ side: 'put', S0, Ks: 4900, Kl: 4850, T: T0, credit: 0.8, sigmaForecast: 0.16, muForecast: MU, frictionPerContract: 12 });
    expect(ev.probProfit).toBeGreaterThan(0); expect(ev.probProfit).toBeLessThan(1);
    expect(ev.probMaxLoss).toBeGreaterThan(0); expect(ev.probMaxLoss).toBeLessThan(1);
    expect(ev.maxProfit).toBeCloseTo(0.8 * 100 - 12, 6);
    expect(ev.maxLoss).toBeCloseTo((50 - 0.8) * 100 + 12, 6);
    expect(ev.breakeven).toBeCloseTo(4900 - (0.8 - 12 / 100), 6);
  });
});

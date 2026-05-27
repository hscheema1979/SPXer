/**
 * Unit tests for black-scholes.ts — option delta + implied-vol inversion.
 *
 * Polygon flat files carry no greeks and ThetaData NDXP greeks only start ~2026,
 * so the multi-DTE sweep computes delta itself: back out implied vol from the
 * option's mid price, then evaluate Black-Scholes delta. These tests pin the
 * math against hand-computable reference values.
 *
 * Reference (European, rate=0, no div):
 *   d1 = [ln(S/K) + 0.5*sigma^2*T] / (sigma*sqrt(T))
 *   call delta = N(d1);  put delta = N(d1) - 1
 *   ATM (S=K=100), sigma=0.20, T=1: d1 = 0.10 → N(0.10)=0.53983
 *     call delta ≈ +0.5398, put delta ≈ -0.4602
 */
import { describe, it, expect } from 'vitest';
import {
  normCdf,
  bsCallDelta,
  bsPutDelta,
  bsPutPrice,
  impliedVolFromPut,
} from '../../scripts/diag/black-scholes';

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

describe('normCdf', () => {
  it('N(0) = 0.5', () => expect(near(normCdf(0), 0.5)).toBe(true));
  it('N(1.96) ≈ 0.975', () => expect(near(normCdf(1.96), 0.975, 2e-3)).toBe(true));
  it('N(-1.96) ≈ 0.025', () => expect(near(normCdf(-1.96), 0.025, 2e-3)).toBe(true));
  it('is monotonic increasing', () => {
    expect(normCdf(-1)).toBeLessThan(normCdf(0));
    expect(normCdf(0)).toBeLessThan(normCdf(1));
  });
});

describe('bsCallDelta / bsPutDelta', () => {
  it('ATM 1y 20% vol: call ≈ +0.5398, put ≈ -0.4602', () => {
    expect(near(bsCallDelta(100, 100, 1, 0.20, 0), 0.5398)).toBe(true);
    expect(near(bsPutDelta(100, 100, 1, 0.20, 0), -0.4602)).toBe(true);
  });

  it('put-call delta parity: callDelta - putDelta = 1 (rate 0)', () => {
    const c = bsCallDelta(100, 95, 0.5, 0.25, 0);
    const p = bsPutDelta(100, 95, 0.5, 0.25, 0);
    expect(near(c - p, 1, 1e-9)).toBe(true);
  });

  it('deep-ITM put delta → near -1', () => {
    // Strike far above spot → put deeply ITM.
    expect(bsPutDelta(100, 200, 0.1, 0.2, 0)).toBeLessThan(-0.97);
  });

  it('deep-OTM put delta → near 0', () => {
    expect(bsPutDelta(100, 50, 0.1, 0.2, 0)).toBeGreaterThan(-0.03);
  });

  it('put delta is monotonic in strike (higher strike → more negative)', () => {
    const d1 = bsPutDelta(100, 90, 0.25, 0.2, 0);
    const d2 = bsPutDelta(100, 100, 0.25, 0.2, 0);
    const d3 = bsPutDelta(100, 110, 0.25, 0.2, 0);
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d3);
  });
});

describe('bsPutPrice', () => {
  it('ATM 1y 20% vol put price ≈ 7.97 (rate 0)', () => {
    // Known BS value for S=K=100, T=1, sigma=0.2, r=0.
    expect(near(bsPutPrice(100, 100, 1, 0.20, 0), 7.9656, 0.01)).toBe(true);
  });
  it('price increases with vol', () => {
    expect(bsPutPrice(100, 100, 1, 0.30, 0)).toBeGreaterThan(bsPutPrice(100, 100, 1, 0.20, 0));
  });
});

describe('impliedVolFromPut (round-trip inversion)', () => {
  it('recovers the vol used to generate the price', () => {
    for (const vol of [0.10, 0.20, 0.35, 0.50]) {
      const price = bsPutPrice(100, 100, 0.5, vol, 0);
      const iv = impliedVolFromPut(price, 100, 100, 0.5, 0);
      expect(iv).not.toBeNull();
      expect(near(iv!, vol, 1e-3)).toBe(true);
    }
  });

  it('recovers vol for an OTM put', () => {
    const vol = 0.28;
    const price = bsPutPrice(100, 90, 0.25, vol, 0);
    const iv = impliedVolFromPut(price, 100, 90, 0.25, 0);
    expect(iv).not.toBeNull();
    expect(near(iv!, vol, 1e-3)).toBe(true);
  });

  it('returns null when price is below intrinsic (no real IV)', () => {
    // Put intrinsic at S=100,K=120 is 20; a price below that is impossible.
    expect(impliedVolFromPut(5, 100, 120, 0.25, 0)).toBeNull();
  });

  it('returns null for non-positive price', () => {
    expect(impliedVolFromPut(0, 100, 100, 0.25, 0)).toBeNull();
  });

  it('delta from inverted IV matches: price→IV→delta round-trips', () => {
    const vol = 0.22;
    const price = bsPutPrice(100, 95, 0.4, vol, 0);
    const iv = impliedVolFromPut(price, 100, 95, 0.4, 0)!;
    const delta = bsPutDelta(100, 95, 0.4, iv, 0);
    const directDelta = bsPutDelta(100, 95, 0.4, vol, 0);
    expect(near(delta, directDelta, 1e-3)).toBe(true);
  });
});

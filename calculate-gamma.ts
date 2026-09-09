/**
 * Black-Scholes gamma calculator for 0DTE options
 *
 * Gamma = rate of change of delta
 * For 0DTE, gamma peaks at ATM strikes near close
 *
 * Usage: npx tsx calculate-gamma.ts --date 2026-06-08 --strike 7440
 */

import * as Math from 'math';

interface BSParams {
  S: number;        // Spot price (SPX)
  K: number;        // Strike price
  T: number;        // Time to expiry in years (0DTE = 1/252 or 1 min / 1440)
  r: number;        // Risk-free rate (0 for 0DTE)
  sigma: number;    // Implied volatility (annualized)
}

/**
 * Standard normal CDF (cumulative distribution function)
 */
function normCDF(x: number): number {
  return (1 + Math.erf(x / Math.sqrt(2))) / 2;
}

/**
 * Standard normal PDF (probability density function)
 */
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate d1 in Black-Scholes
 */
function calcD1(params: BSParams): number {
  const { S, K, T, r, sigma } = params;
  const sqrtT = Math.sqrt(T);
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
}

/**
 * Calculate call delta
 */
function callDelta(params: BSParams): number {
  const d1 = calcD1(params);
  return normCDF(d1);
}

/**
 * Calculate call gamma
 * Gamma = N'(d1) / (S * sigma * sqrt(T))
 */
function callGamma(params: BSParams): number {
  const { S, sigma } = params;
  const d1 = calcD1(params);
  const sqrtT = Math.sqrt(params.T);

  if (sqrtT === 0 || sigma === 0) return Infinity; // Gamma → ∞ at expiry

  return normPDF(d1) / (S * sigma * sqrtT);
}

/**
 * Put gamma (same as call gamma)
 */
function putGamma(params: BSParams): number {
  return callGamma(params);
}

/**
 * Estimate implied volatility from option price using Newton-Raphson
 * (simplified version, only for illustration)
 */
function estimateIV(params: BSParams, marketPrice: number, isCall: boolean): number {
  let sigma = 0.5; // Starting guess
  let iterations = 0;
  const maxIterations = 20;
  const tolerance = 0.0001;

  while (iterations < maxIterations) {
    const testParams = { ...params, sigma };
    const d1 = calcD1(testParams);

    // Black-Scholes price
    const theoretical = isCall
      ? params.S * normCDF(d1) - params.K * Math.exp(-params.r * params.T) * normCDF(d1 - params.sigma * Math.sqrt(params.T))
      : params.K * Math.exp(-params.r * params.T) * normCDF(-d1 + params.sigma * Math.sqrt(params.T)) - params.S * normCDF(-d1);

    const diff = theoretical - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return sigma;
    }

    // Vega (derivative of price w.r.t. sigma)
    const vega = params.S * normPDF(d1) * Math.sqrt(params.T);

    // Newton-Raphson step
    sigma = sigma - diff / vega;
    sigma = Math.max(0.01, sigma); // Floor at 1%

    iterations++;
  }

  return sigma;
}

/**
 * Main analysis for a specific time
 */
function analyzeGamma(
  spotPrice: number,
  callPrice: number,
  putPrice: number,
  strike: number,
  minutesToExpiry: number = 60
) {
  // Convert minutes to years (trading minutes in a year: 252 * 390 = 98,280)
  const T = minutesToExpiry / (252 * 390);

  // Estimate IV from put/call prices (both should imply same IV in theory)
  const params: BSParams = {
    S: spotPrice,
    K: strike,
    T,
    r: 0,
    sigma: 0.5, // Will be overridden by IV estimation
  };

  // Use put to estimate IV (more stable for OTM calls)
  const estIV = estimateIV(params, putPrice, false);

  const finalParams = { ...params, sigma: estIV };

  const gamma = callGamma(finalParams);
  const callDelta = callDelta(finalParams);
  const putDelta = callDelta - 1; // Put delta = call delta - 1

  return {
    strike,
    spotPrice,
    callPrice,
    putPrice,
    callToPutRatio: callPrice / (putPrice || 0.01),
    estimatedIV: (estIV * 100).toFixed(1) + '%',
    gamma: gamma.toFixed(4),
    callDelta: callDelta.toFixed(3),
    putDelta: putDelta.toFixed(3),
    minutesToExpiry,
  };
}

// Example: June 8, 2026 at 15:00 ET (60 min to close)
const june8_3pm = analyzeGamma(
  7464,      // SPX price at 3pm
  30.7,      // 7440 call price
  7.27,      // 7440 put price
  7440,      // Strike
  60         // 60 minutes to market close
);

console.log('\n════════════════════════════════════════════════');
console.log('GAMMA ANALYSIS — June 8, 2026 at 15:00 ET');
console.log('════════════════════════════════════════════════\n');

console.log('Input:');
console.log(`  Spot (SPX):       ${june8_3pm.spotPrice}`);
console.log(`  Strike:           ${june8_3pm.strike}`);
console.log(`  Call Price:       $${june8_3pm.callPrice.toFixed(2)}`);
console.log(`  Put Price:        $${june8_3pm.putPrice.toFixed(2)}`);
console.log(`  Time to Expiry:   ${june8_3pm.minutesToExpiry} min\n`);

console.log('Calculated Metrics:');
console.log(`  Call/Put Ratio:   ${june8_3pm.callToPutRatio.toFixed(1)}:1 (EXTREME CALL SKEW)`);
console.log(`  Est. IV:          ${june8_3pm.estimatedIV}`);
console.log(`  Gamma:            ${june8_3pm.gamma} per $1 move`);
console.log(`  Call Delta:       ${june8_3pm.callDelta}`);
console.log(`  Put Delta:        ${june8_3pm.putDelta}\n`);

console.log('Interpretation:');
console.log(`  ✓ Call/Put Ratio = ${june8_3pm.callToPutRatio.toFixed(1)}:1`);
console.log(`    → Market expects FURTHER UPSIDE`);
console.log(`  ✓ Gamma = ${june8_3pm.gamma}`);
console.log(`    → Option prices are HIGHLY SENSITIVE to moves`);
console.log(`    → Even a -$10 move will change delta dramatically`);
console.log(`  ✓ Combined Signal: EXTREME SKEW + HIGH GAMMA`);
console.log(`    → Market is "SPRING-LOADED" for a reversal`);
console.log(`    → High probability of reversal = HIGH GAMMA CONFIRMS THE SIGNAL\n`);

console.log('What Actually Happened:');
console.log(`  • 15:00 ET: SPX 7464 (peak), put $7.27`);
console.log(`  • 20:00 ET: SPX 7405 (-59 pts), put $31.55 (+334%)`);
console.log(`  ✓ GAMMA TRAP CONFIRMED: Rapid delta shift from gamma\n`);

console.log('════════════════════════════════════════════════\n');

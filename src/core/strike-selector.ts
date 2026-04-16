/**
 * Centralized Strike Selector — single source of truth.
 *
 * Replaces:
 *   - src/agent/strike-selector.ts (live agent)
 *   - inline strike/price filtering in src/replay/machine.ts
 *
 * Supports four strike modes:
 *   - 'otm' (default): only OTM strikes (calls above SPX, puts below SPX)
 *   - 'atm': prefer strikes nearest to SPX price (both ITM and OTM eligible)
 *   - 'itm': prefer ITM strikes (calls below SPX, puts above SPX)
 *   - 'any': no moneyness filter — score purely on price band + volume
 *
 * Rules:
 *   - Select strikes within the configured price band
 *   - Prefer contracts matching targetOtmDistance or targetContractPrice when configured
 *   - Score by: price proximity to band midpoint (50%) + moneyness preference (40%) + volume (10%)
 *   - Deterministic: same inputs → same output
 */

import type { Direction } from './types';
import type { Config } from '../config/types';

// ── Exported Types ──────────────────────────────────────────────────────────

export interface StrikeCandidate {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  price: number;
  volume: number;
}

export interface StrikeResult {
  candidate: StrikeCandidate;
  reason: string;
}

// ── Main Selection Function ─────────────────────────────────────────────────

/**
 * Select the best strike for a directional trade.
 *
 * Supports four strike modes via config.strikeSelector.strikeMode:
 *   - 'otm': only OTM strikes (default, backward compatible)
 *   - 'atm': prefer strikes nearest to SPX (both ITM and OTM eligible)
 *   - 'itm': prefer ITM strikes (calls below SPX, puts above SPX)
 *   - 'any': no moneyness filter, score on price band + volume only
 *
 * @param candidates - available option contracts with current prices
 * @param direction  - 'bullish' (buy calls) or 'bearish' (buy puts)
 * @param spxPrice   - current SPX underlying price
 * @param config     - unified Config (uses strikeSelector + signals sections)
 * @returns best candidate with reason string, or null if nothing qualifies
 */
export function selectStrike(
  candidates: ReadonlyArray<StrikeCandidate>,
  direction: Direction,
  spxPrice: number,
  config: Config,
): StrikeResult | null {
  const side = direction === 'bullish' ? 'call' : 'put';
  const { contractPriceMin, contractPriceMax } = config.strikeSelector;
  const strikeMode = config.strikeSelector.strikeMode ?? 'otm';
  const { targetOtmDistance, targetContractPrice } = config.signals;

  // ── 1. Filter to contracts in the price band + moneyness ───────────────
  const searchRange = config.strikeSelector.strikeSearchRange ?? 100;

  const filtered = candidates.filter(c => {
    if (c.side !== side) return false;
    if (c.price < contractPriceMin || c.price > contractPriceMax) return false;

    const distFromSpx = Math.abs(c.strike - spxPrice);
    // Always limit to searchRange from SPX regardless of mode
    if (distFromSpx > searchRange) return false;

    switch (strikeMode) {
      case 'otm': {
        // Legacy: allow ITM if targetOtmDistance < 0
        const allowItm = (targetOtmDistance ?? 0) < 0;
        if (allowItm) {
          const maxItmDepth = Math.abs(targetOtmDistance!) + 10;
          if (side === 'call' && c.strike < spxPrice - maxItmDepth) return false;
          if (side === 'put' && c.strike > spxPrice + maxItmDepth) return false;
        } else {
          if (side === 'call' && c.strike <= spxPrice) return false;
          if (side === 'put' && c.strike >= spxPrice) return false;
        }
        return true;
      }
      case 'atm':
        // Allow both ITM and OTM — filtering happens in scoring (prefer nearest)
        return true;
      case 'itm':
        // Only ITM: calls below SPX, puts above SPX (with small ATM buffer of 5pts)
        if (side === 'call' && c.strike > spxPrice + 5) return false;
        if (side === 'put' && c.strike < spxPrice - 5) return false;
        return true;
      case 'any':
        // No moneyness filter at all
        return true;
      default:
        return true;
    }
  });

  if (filtered.length === 0) return null;

  // ── 2. Apply targetOtmDistance filter (narrow to closest strikes) ─────
  let pool = filtered;

  if (targetOtmDistance != null) {
    const interval = config.pipeline?.strikeInterval ?? 5;
    const spxRounded = Math.round(spxPrice / interval) * interval;
    const targetStrike = side === 'call'
      ? spxRounded + targetOtmDistance
      : spxRounded - targetOtmDistance;

    // Keep only strikes within one interval of the target
    const narrowed = pool.filter(c => Math.abs(c.strike - targetStrike) <= interval);
    if (narrowed.length > 0) {
      pool = narrowed;
    }
    // If nothing within tolerance, fall through to full pool
  }

  // ── 3. Apply targetContractPrice preference ───────────────────────────
  if (targetContractPrice != null && pool.length > 1) {
    let bestIdx = 0;
    let bestDist = Math.abs(pool[0].price - targetContractPrice);
    for (let i = 1; i < pool.length; i++) {
      const dist = Math.abs(pool[i].price - targetContractPrice);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    pool = [pool[bestIdx]];
  }

  // ── 4. Score remaining candidates ─────────────────────────────────────
  const priceMid = (contractPriceMin + contractPriceMax) / 2;
  const priceRange = contractPriceMax - contractPriceMin;

  const scored = pool.map(c => {
    // Price proximity to midpoint of band (0-1, 1 = at midpoint)
    const priceScore = priceRange > 0
      ? 1 - Math.abs(c.price - priceMid) / (priceRange / 2)
      : 1;

    // Moneyness score (0-1) — depends on strikeMode
    const otmDistance = Math.abs(c.strike - spxPrice);
    let moneynessScore: number;
    switch (strikeMode) {
      case 'otm':
        // Prefer moderate OTM (1 = ATM, decays over 40pts)
        moneynessScore = 1 - Math.min(1, otmDistance / 40);
        break;
      case 'atm':
        // Prefer nearest to SPX price (1 = exactly ATM, decays over 20pts)
        moneynessScore = 1 - Math.min(1, otmDistance / 20);
        break;
      case 'itm': {
        // Prefer moderate ITM depth (sweet spot ~5-15pts ITM)
        const isItm = (side === 'call' && c.strike <= spxPrice) || (side === 'put' && c.strike >= spxPrice);
        if (!isItm) {
          moneynessScore = 0.2; // Small score for ATM/near-OTM (still eligible)
        } else {
          // Peak at 10pts ITM, decay from there
          const itmDepth = otmDistance;
          moneynessScore = itmDepth <= 10
            ? 0.5 + (itmDepth / 10) * 0.5   // ramp up to 1.0 at 10pts
            : 1 - Math.min(1, (itmDepth - 10) / 30); // decay after 10pts
        }
        break;
      }
      case 'any':
        // No preference — all get same score
        moneynessScore = 0.5;
        break;
      default:
        moneynessScore = 1 - Math.min(1, otmDistance / 40);
    }

    // Volume bonus (binary: has volume or not)
    const volScore = c.volume > 0 ? 1 : 0;

    const score = priceScore * 0.5 + moneynessScore * 0.4 + volScore * 0.1;

    return { candidate: c, score };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].candidate;
  const distPts = Math.abs(best.strike - spxPrice).toFixed(0);
  const isItm = (side === 'call' && best.strike <= spxPrice) || (side === 'put' && best.strike >= spxPrice);
  const isAtm = Math.abs(best.strike - spxPrice) <= 5;
  const moneyLabel = isAtm ? 'ATM' : isItm ? 'ITM' : 'OTM';
  const reason = `${side.toUpperCase()} ${best.strike} @ $${best.price.toFixed(2)} — ${distPts}pts ${moneyLabel}`;

  return { candidate: best, reason };
}

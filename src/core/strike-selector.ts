/**
 * Centralized OTM Strike Selector — single source of truth.
 *
 * Replaces:
 *   - src/agent/strike-selector.ts (live agent)
 *   - inline strike/price filtering in src/replay/machine.ts
 *
 * Rules:
 *   - ONLY select OTM strikes within the configured price band
 *   - Prefer contracts matching targetOtmDistance or targetContractPrice when configured
 *   - Score by: price proximity to band midpoint (50%) + moderate OTM distance (40%) + volume (10%)
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
 * Select the best OTM strike for a directional trade.
 *
 * @param candidates - available option contracts with current prices
 * @param direction  - 'bullish' (buy calls) or 'bearish' (buy puts)
 * @param spxPrice   - current SPX price
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
  const { targetOtmDistance, targetContractPrice } = config.signals;

  // ── 1. Filter to contracts in the price band ───────────────────────────
  // When targetOtmDistance < 0 (ITM), allow ITM contracts up to |targetOtmDistance| + buffer
  const allowItm = (targetOtmDistance ?? 0) < 0;
  const maxItmDepth = allowItm ? Math.abs(targetOtmDistance!) + 10 : 0; // +10 buffer for rounding

  const filtered = candidates.filter(c => {
    if (c.side !== side) return false;
    if (c.price < contractPriceMin || c.price > contractPriceMax) return false;
    if (allowItm) {
      // Allow ITM up to maxItmDepth points
      if (side === 'call' && c.strike < spxPrice - maxItmDepth) return false;
      if (side === 'put' && c.strike > spxPrice + maxItmDepth) return false;
    } else {
      // OTM only
      if (side === 'call' && c.strike <= spxPrice) return false;
      if (side === 'put' && c.strike >= spxPrice) return false;
    }
    return true;
  });

  if (filtered.length === 0) return null;

  // ── 2. Apply targetOtmDistance filter (narrow to closest strikes) ─────
  let pool = filtered;

  if (targetOtmDistance != null) {
    const spxRounded = Math.round(spxPrice / 5) * 5; // SPX $5 strike intervals
    const targetStrike = side === 'call'
      ? spxRounded + targetOtmDistance
      : spxRounded - targetOtmDistance;

    // Keep only strikes within $5 of the target (same tolerance as replay)
    const narrowed = pool.filter(c => Math.abs(c.strike - targetStrike) <= 5);
    if (narrowed.length > 0) {
      pool = narrowed;
    }
    // If nothing within tolerance, fall through to full pool
  }

  // ── 3. Apply targetContractPrice preference ───────────────────────────
  // When set and multiple candidates remain, keep the one priced closest
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

    // Moderate OTM distance (0-1, 1 = ATM, decays over 40pts)
    const otmDistance = Math.abs(c.strike - spxPrice);
    const distanceScore = 1 - Math.min(1, otmDistance / 40);

    // Volume bonus (binary: has volume or not)
    const volScore = c.volume > 0 ? 1 : 0;

    const score = priceScore * 0.5 + distanceScore * 0.4 + volScore * 0.1;

    return { candidate: c, score };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].candidate;
  const distPts = Math.abs(best.strike - spxPrice).toFixed(0);
  const isItm = (side === 'call' && best.strike <= spxPrice) || (side === 'put' && best.strike >= spxPrice);
  const moneyLabel = isItm ? 'ITM' : 'OTM';
  const reason = `${side.toUpperCase()} ${best.strike} @ $${best.price.toFixed(2)} — ${distPts}pts ${moneyLabel}`;

  return { candidate: best, reason };
}

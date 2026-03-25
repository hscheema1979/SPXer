/**
 * Deterministic OTM Strike Selector — no LLM involved.
 *
 * Rules:
 *   - ONLY select OTM strikes within the configured price band
 *   - Prefer contracts priced near the ideal price point
 *   - Risk is controlled by position SIZE, not strike proximity
 *   - Deterministic: same inputs → same output
 */

export interface ContractCandidate {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  price: number;        // current mid or last price
  volume: number;
  delta?: number | null;
  gamma?: number | null;
}

export interface StrikeSelection {
  contract: ContractCandidate;
  reason: string;
  positionSize: number;   // number of contracts
  stopLoss: number;       // option price stop
  takeProfit: number;     // option price target
}

export interface SelectionConfig {
  maxRiskPerTrade: number;  // e.g. $300
  priceMin: number;         // e.g. $0.50
  priceMax: number;         // e.g. $3.00
  idealPrice: number;       // e.g. $1.50 — sweet spot
  stopPct: number;          // e.g. 0.50 (50% of premium)
  tpMultiplier: number;     // e.g. 10 (10x entry price)
}

const DEFAULT_CONFIG: SelectionConfig = {
  maxRiskPerTrade: 300,
  priceMin: 0.50,
  priceMax: 3.00,
  idealPrice: 1.50,
  stopPct: 0.50,
  tpMultiplier: 10,
};

/**
 * Select the best OTM strike for a directional trade.
 *
 * @param contracts - available option contracts with current prices
 * @param direction - 'bullish' (buy calls) or 'bearish' (buy puts)
 * @param spxPrice  - current SPX price
 * @param rsi       - current RSI (unused, kept for API compatibility)
 * @param config    - optional override for selection parameters
 */
export function selectStrike(
  contracts: ContractCandidate[],
  direction: 'bullish' | 'bearish',
  spxPrice: number,
  rsi: number | null = null,
  config: SelectionConfig = DEFAULT_CONFIG,
): StrikeSelection | null {
  const side = direction === 'bullish' ? 'call' : 'put';

  // Filter to OTM contracts in the price band
  const candidates = contracts
    .filter(c => c.side === side)
    .filter(c => c.price >= config.priceMin && c.price <= config.priceMax)
    .filter(c => {
      // Must be OTM
      if (side === 'call') return c.strike > spxPrice;
      return c.strike < spxPrice;
    });

  if (candidates.length === 0) return null;

  // Score each candidate: prefer price closest to ideal
  const scored = candidates.map(c => {
    const priceScore = 1 - Math.abs(c.price - config.idealPrice) / config.priceMax;
    const otmDistance = Math.abs(c.strike - spxPrice);

    // Prefer moderate OTM distance (not too close, not too far)
    const distanceScore = 1 - Math.min(1, otmDistance / 40);

    // Volume bonus — prefer contracts with some liquidity
    const volScore = c.volume > 0 ? 0.1 : 0;

    return {
      contract: c,
      score: priceScore * 0.5 + distanceScore * 0.4 + volScore * 0.1,
    };
  });

  // Sort by score descending, pick the best
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].contract;

  // Position sizing: risk = contracts × price × 100 (multiplier)
  const riskPerContract = best.price * 100 * config.stopPct;
  const positionSize = Math.max(1, Math.min(3, Math.floor(config.maxRiskPerTrade / riskPerContract)));

  const stopLoss = best.price * (1 - config.stopPct);
  const takeProfit = best.price * config.tpMultiplier;

  const otmPts = Math.abs(best.strike - spxPrice).toFixed(0);
  const reason = `${side.toUpperCase()} ${best.strike} @ $${best.price.toFixed(2)} — ${otmPts}pts OTM, ${positionSize} contracts, stop=$${stopLoss.toFixed(2)}, tp=$${takeProfit.toFixed(2)}`;

  return {
    contract: best,
    reason,
    positionSize,
    stopLoss,
    takeProfit,
  };
}

/**
 * Quick helper for the replay: select strike from raw DB data.
 */
export function selectFromContractBars(
  contractBars: Array<{ symbol: string; type: string; strike: number; close: number; volume: number }>,
  direction: 'bullish' | 'bearish',
  spxPrice: number,
  rsi: number | null = null,
): StrikeSelection | null {
  const candidates: ContractCandidate[] = contractBars.map(c => ({
    symbol: c.symbol,
    side: c.type as 'call' | 'put',
    strike: c.strike,
    price: c.close,
    volume: c.volume,
  }));

  return selectStrike(candidates, direction, spxPrice, rsi);
}

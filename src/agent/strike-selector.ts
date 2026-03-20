/**
 * Deterministic OTM Strike Selector — no LLM involved.
 *
 * Per trader mandate: "We're ONLY trading out-of-the-money. The goal is
 * aggressive — not safe. Otherwise we'd be collecting dividends."
 *
 * Rules:
 *   - ONLY select OTM strikes priced $0.50-$3.00
 *   - On EMERGENCY signals (RSI <15 or >85): prefer 20-30pts OTM
 *   - On EXTREME signals (RSI <20 or >80): prefer 15-25pts OTM
 *   - Risk is controlled by position SIZE (1-2 contracts), not strike proximity
 *   - Deterministic: same inputs → same output. No hallucination risk.
 *
 * Per Gemini 3.1 Pro + Opus consensus: "Never ask an LLM to pick a strike.
 * Write a deterministic function that instantly grabs the first strike
 * priced $1.50-$2.00 when the trigger fires."
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
 * @param rsi       - current RSI (used to adjust OTM distance preference)
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

  // Score each candidate: prefer price closest to ideal ($1.50)
  // On emergency signals, prefer FURTHER OTM (cheaper, more gamma leverage)
  const isEmergency = rsi !== null && (rsi < 15 || rsi > 85);
  const isExtreme = rsi !== null && (rsi < 20 || rsi > 80);

  const targetPrice = isEmergency
    ? Math.min(config.idealPrice, 1.00)     // prefer ~$1.00 on emergency
    : isExtreme
      ? config.idealPrice                    // prefer ~$1.50 on extreme
      : Math.min(config.priceMax, 2.50);     // prefer ~$2.50 on normal

  const scored = candidates.map(c => {
    const priceScore = 1 - Math.abs(c.price - targetPrice) / config.priceMax;
    const otmDistance = Math.abs(c.strike - spxPrice);

    // Prefer further OTM on emergency (more gamma leverage)
    const distanceScore = isEmergency
      ? Math.min(1, otmDistance / 30)         // reward 20-30pts OTM
      : isExtreme
        ? Math.min(1, otmDistance / 25)       // reward 15-25pts OTM
        : 1 - Math.min(1, otmDistance / 40);  // normal: don't go too far

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
  // Target: maxRiskPerTrade / (price × 100 × stopPct)
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

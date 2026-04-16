/**
 * Pre-Trade Quality Gates — validates trade quality before execution.
 *
 * Checks:
 *   1. Spread within acceptable range
 *   2. Quote is fresh (< maxAgeMs)
 *   3. Option has traded recently (volume > 0 in recent bars)
 *   4. All required indicators are present
 *   5. Signal is not too old
 *
 * All checks are pure functions. No mocks needed.
 */
import type { Config } from '../config/types';

export interface QualityCheckInput {
  /** Bid price */
  bid: number | null;
  /** Ask price */
  ask: number | null;
  /** Timestamp of the quote (ms) */
  quoteTs: number | null;
  /** Current time (ms) */
  now: number;
  /** Option volume from recent bars */
  recentVolume: number;
  /** Whether all required indicators (HMA3, HMA17) are present */
  indicatorsComplete: boolean;
  /** Signal timestamp (ms) */
  signalTs: number;
  /** Config */
  config: {
    maxSpreadAbsolute: number;
    maxQuoteAgeMs: number;
    minRecentVolume: number;
    maxSignalAgeMs: number;
  };
}

export interface QualityCheckResult {
  passed: boolean;
  failures: string[];
  spread: number | null;
  quoteAgeMs: number | null;
  signalAgeMs: number | null;
}

export const DEFAULT_QUALITY_CONFIG = {
  maxSpreadAbsolute: 1.00,
  maxQuoteAgeMs: 10_000,      // 10s
  minRecentVolume: 1,          // at least 1 contract traded
  maxSignalAgeMs: 60_000,      // 60s
};

/**
 * Validate trade quality. Pure function — no side effects.
 */
export function validateTradeQuality(input: QualityCheckInput): QualityCheckResult {
  const failures: string[] = [];
  const { config } = input;

  // 1. Spread check
  let spread: number | null = null;
  if (input.bid != null && input.ask != null && input.bid > 0 && input.ask > 0) {
    spread = input.ask - input.bid;
    if (spread > config.maxSpreadAbsolute) {
      failures.push(`Spread $${spread.toFixed(2)} > max $${config.maxSpreadAbsolute.toFixed(2)}`);
    }
  } else {
    failures.push('No bid/ask data');
  }

  // 2. Quote freshness
  let quoteAgeMs: number | null = null;
  if (input.quoteTs != null) {
    quoteAgeMs = input.now - input.quoteTs;
    if (quoteAgeMs > config.maxQuoteAgeMs) {
      failures.push(`Quote stale: ${Math.round(quoteAgeMs / 1000)}s > max ${Math.round(config.maxQuoteAgeMs / 1000)}s`);
    }
  }

  // 3. Recent trading activity
  if (input.recentVolume < config.minRecentVolume) {
    failures.push(`No recent trades: volume ${input.recentVolume} < min ${config.minRecentVolume}`);
  }

  // 4. Indicators complete
  if (!input.indicatorsComplete) {
    failures.push('Missing required indicators');
  }

  // 5. Signal freshness
  let signalAgeMs: number | null = null;
  if (input.signalTs > 0) {
    signalAgeMs = input.now - input.signalTs;
    if (signalAgeMs > config.maxSignalAgeMs) {
      failures.push(`Signal stale: ${Math.round(signalAgeMs / 1000)}s > max ${Math.round(config.maxSignalAgeMs / 1000)}s`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    spread,
    quoteAgeMs,
    signalAgeMs,
  };
}

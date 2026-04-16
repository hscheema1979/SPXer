/**
 * Health Gate — Circuit breaker that prevents trading when infrastructure is degraded.
 *
 * Checks before each agent tick:
 *   1. Data service /health endpoint responds and is not 'critical'
 *   2. SPX bar data is fresh (< staleThresholdSec old)
 *
 * Tracks consecutive failures. After `maxFailures` consecutive failures,
 * pauses trading for `pauseDurationMs` before retrying.
 *
 * State is kept in-memory per agent instance.
 * The watchdog process provides redundant monitoring independently.
 */
import axios from 'axios';

export interface HealthGateConfig {
  /** Base URL for the data service (default: http://localhost:3600) */
  spxerUrl: string;
  /** Max SPX bar age in seconds before considering data stale (default: 120) */
  staleThresholdSec: number;
  /** Consecutive failures before pausing (default: 3) */
  maxFailures: number;
  /** How long to pause after maxFailures (ms, default: 300000 = 5 min) */
  pauseDurationMs: number;
  /** HTTP request timeout (ms, default: 5000) */
  requestTimeoutMs: number;
}

export const DEFAULT_HEALTH_GATE_CONFIG: HealthGateConfig = {
  spxerUrl: process.env.SPXER_URL || 'http://localhost:3600',
  staleThresholdSec: 120,
  maxFailures: 3,
  pauseDurationMs: 300_000,
  requestTimeoutMs: 5_000,
};

export interface HealthGateResult {
  /** Whether trading is allowed */
  healthy: boolean;
  /** Human-readable reason if not healthy */
  reason: string | null;
  /** Data service overall status from /health */
  dataServiceStatus: string | null;
  /** SPX bar age in seconds, null if unknown */
  spxBarAgeSec: number | null;
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** If pausing, timestamp when pause expires (ms since epoch) */
  pauseUntil: number | null;
}

export class HealthGate {
  private config: HealthGateConfig;
  private consecutiveFailures = 0;
  private pauseUntil: number | null = null;
  private lastHealthyTs: number | null = null;

  constructor(config?: Partial<HealthGateConfig>) {
    this.config = { ...DEFAULT_HEALTH_GATE_CONFIG, ...config };
  }

  /**
   * Check if trading is allowed. Call at the start of each agent tick cycle.
   * Returns a result indicating health status with reason if unhealthy.
   */
  async check(): Promise<HealthGateResult> {
    const now = Date.now();

    // If we're in a pause window, check if it's expired
    if (this.pauseUntil !== null) {
      if (now < this.pauseUntil) {
        const remaining = Math.round((this.pauseUntil - now) / 1000);
        return {
          healthy: false,
          reason: `Health gate paused — ${remaining}s remaining (${this.consecutiveFailures} consecutive failures)`,
          dataServiceStatus: null,
          spxBarAgeSec: null,
          consecutiveFailures: this.consecutiveFailures,
          pauseUntil: this.pauseUntil,
        };
      }
      // Pause expired — reset and try again
      this.pauseUntil = null;
    }

    // Check data service health endpoint
    let dataServiceStatus: string | null = null;
    let spxBarAgeSec: number | null = null;
    let failed = false;
    let reason: string | null = null;

    try {
      const { data } = await axios.get(`${this.config.spxerUrl}/health`, {
        timeout: this.config.requestTimeoutMs,
      });

      dataServiceStatus = data?.status ?? 'unknown';

      // Check for critical status
      if (dataServiceStatus === 'critical') {
        failed = true;
        reason = `Data service status: critical`;
      }

      // Check SPX bar freshness
      const spxData = data?.data?.SPX || data?.data?.ES;
      if (spxData?.staleSec != null) {
        spxBarAgeSec = spxData.staleSec;
        if (spxBarAgeSec > this.config.staleThresholdSec && !failed) {
          failed = true;
          reason = `SPX data stale: ${spxBarAgeSec}s (threshold: ${this.config.staleThresholdSec}s)`;
        }
      }

      // Also check that lastSpxPrice exists (basic sanity)
      if (!data?.lastSpxPrice && !failed) {
        failed = true;
        reason = 'Data service has no SPX price data';
      }

    } catch (e: any) {
      failed = true;
      dataServiceStatus = 'unreachable';
      if (e.code === 'ECONNREFUSED') {
        reason = `Data service unreachable: connection refused at ${this.config.spxerUrl}`;
      } else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') {
        reason = `Data service timeout after ${this.config.requestTimeoutMs}ms`;
      } else {
        reason = `Data service error: ${e.message}`;
      }
    }

    // Update failure tracking
    if (failed) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.config.maxFailures) {
        this.pauseUntil = now + this.config.pauseDurationMs;
        return {
          healthy: false,
          reason: `${reason} — ${this.consecutiveFailures} consecutive failures, pausing ${Math.round(this.config.pauseDurationMs / 1000)}s`,
          dataServiceStatus,
          spxBarAgeSec,
          consecutiveFailures: this.consecutiveFailures,
          pauseUntil: this.pauseUntil,
        };
      }
      return {
        healthy: false,
        reason: reason!,
        dataServiceStatus,
        spxBarAgeSec,
        consecutiveFailures: this.consecutiveFailures,
        pauseUntil: null,
      };
    }

    // Healthy — reset counters
    this.consecutiveFailures = 0;
    this.pauseUntil = null;
    this.lastHealthyTs = now;

    return {
      healthy: true,
      reason: null,
      dataServiceStatus,
      spxBarAgeSec,
      consecutiveFailures: 0,
      pauseUntil: null,
    };
  }

  /** Get current state for status reporting */
  getState(): { consecutiveFailures: number; pauseUntil: number | null; lastHealthyTs: number | null } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      pauseUntil: this.pauseUntil,
      lastHealthyTs: this.lastHealthyTs,
    };
  }

  /** Reset state (for testing) */
  reset(): void {
    this.consecutiveFailures = 0;
    this.pauseUntil = null;
    this.lastHealthyTs = null;
  }
}

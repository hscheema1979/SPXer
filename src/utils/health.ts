/**
 * Health monitoring — tracks provider status, data freshness, and overall system health.
 *
 * Status semantics:
 *   'ok'       — no providers registered yet (startup/test) OR all providers healthy
 *   'healthy'  — all registered providers are healthy and responding
 *   'degraded' — some providers healthy, some failing
 *   'critical' — all registered providers are unhealthy
 */

export type HealthStatus = 'n/a' | 'healthy' | 'degraded' | 'critical';

export interface ProviderHealth {
  lastSuccess: string | null;
  staleSec: number | null;
  consecutiveFailures: number;
  healthy: boolean;
}

export interface DataHealth {
  lastBarTs: string;
  staleSec: number;
}

export interface HealthReport {
  status: HealthStatus;
  uptimeSec: number;
  providers: Record<string, ProviderHealth>;
  data: Record<string, DataHealth>;
}

export interface ProviderStatus {
  lastSuccessTs: number | null;
  lastFailureTs: number | null;
  consecutiveFailures: number;
}

/** Max staleness before a provider is considered unhealthy (ms) */
const STALE_THRESHOLD_MS = 120_000;

/** Max consecutive failures before a provider is considered unhealthy */
const FAILURE_THRESHOLD = 3;

export class HealthTracker {
  private providers = new Map<string, ProviderStatus>();
  private lastBarTs = new Map<string, number>();
  private startTime: number;

  constructor(startTime?: number) {
    this.startTime = startTime ?? Date.now();
  }

  recordSuccess(provider: string): void {
    const s = this.getOrCreate(provider);
    s.lastSuccessTs = Date.now();
    s.consecutiveFailures = 0;
  }

  recordFailure(provider: string): void {
    const s = this.getOrCreate(provider);
    s.lastFailureTs = Date.now();
    s.consecutiveFailures++;
  }

  recordBar(symbol: string, ts: number): void {
    this.lastBarTs.set(symbol, ts);
  }

  /** Reset all state — useful in tests */
  reset(): void {
    this.providers.clear();
    this.lastBarTs.clear();
    this.startTime = Date.now();
  }

  get providerCount(): number {
    return this.providers.size;
  }

  getProviderStatus(provider: string): ProviderStatus | undefined {
    return this.providers.get(provider);
  }

  getStatus(now?: number): HealthReport {
    const ts = now ?? Date.now();
    const providers: HealthReport['providers'] = {};

    for (const [name, status] of this.providers) {
      const healthy = isProviderHealthy(status, ts);
      providers[name] = {
        lastSuccess: status.lastSuccessTs ? new Date(status.lastSuccessTs).toISOString() : null,
        staleSec: status.lastSuccessTs ? Math.round((ts - status.lastSuccessTs) / 1000) : null,
        consecutiveFailures: status.consecutiveFailures,
        healthy,
      };
    }

    const data: HealthReport['data'] = {};
    for (const [symbol, barTs] of this.lastBarTs) {
      data[symbol] = {
        lastBarTs: new Date(barTs).toISOString(),
        staleSec: Math.round((ts - barTs) / 1000),
      };
    }

    return {
      status: computeOverallStatus(providers),
      uptimeSec: Math.round((ts - this.startTime) / 1000),
      providers,
      data,
    };
  }

  private getOrCreate(provider: string): ProviderStatus {
    if (!this.providers.has(provider)) {
      this.providers.set(provider, { lastSuccessTs: null, lastFailureTs: null, consecutiveFailures: 0 });
    }
    return this.providers.get(provider)!;
  }
}

// ── Pure helper functions (testable independently) ─────────────────────────

export function isProviderHealthy(status: ProviderStatus, now: number): boolean {
  if (status.consecutiveFailures >= FAILURE_THRESHOLD) return false;
  if (!status.lastSuccessTs) return false;
  if (now - status.lastSuccessTs >= STALE_THRESHOLD_MS) return false;
  return true;
}

export function computeOverallStatus(
  providers: Record<string, ProviderHealth>,
): HealthStatus {
  const values = Object.values(providers);

  // No providers registered yet — nothing to report
  if (values.length === 0) return 'n/a';

  const allHealthy = values.every(p => p.healthy);
  const anyHealthy = values.some(p => p.healthy);

  if (allHealthy) return 'healthy';
  if (anyHealthy) return 'degraded';
  return 'critical';
}

// ── Singleton instance for production use ──────────────────────────────────

export const healthTracker = new HealthTracker();

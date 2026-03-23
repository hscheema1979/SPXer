export interface HealthReport {
  status: 'healthy' | 'degraded' | 'critical';
  uptimeSec: number;
  providers: Record<string, {
    lastSuccess: string | null;
    staleSec: number | null;
    consecutiveFailures: number;
    healthy: boolean;
  }>;
  data: Record<string, {
    lastBarTs: string;
    staleSec: number;
  }>;
}

interface ProviderStatus {
  lastSuccessTs: number | null;
  lastFailureTs: number | null;
  consecutiveFailures: number;
}

class HealthTracker {
  private providers = new Map<string, ProviderStatus>();
  private lastBarTs = new Map<string, number>();
  private startTime = Date.now();

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

  getStatus(): HealthReport {
    const now = Date.now();
    const providers: HealthReport['providers'] = {};

    for (const [name, status] of this.providers) {
      providers[name] = {
        lastSuccess: status.lastSuccessTs ? new Date(status.lastSuccessTs).toISOString() : null,
        staleSec: status.lastSuccessTs ? Math.round((now - status.lastSuccessTs) / 1000) : null,
        consecutiveFailures: status.consecutiveFailures,
        healthy: status.consecutiveFailures < 3 && (status.lastSuccessTs ? (now - status.lastSuccessTs) < 120_000 : false),
      };
    }

    const data: HealthReport['data'] = {};
    for (const [symbol, ts] of this.lastBarTs) {
      data[symbol] = {
        lastBarTs: new Date(ts).toISOString(),
        staleSec: Math.round((now - ts) / 1000),
      };
    }

    const providerValues = Object.values(providers);
    const allHealthy = providerValues.length > 0 && providerValues.every(p => p.healthy);
    const anyHealthy = providerValues.some(p => p.healthy);

    return {
      status: allHealthy ? 'healthy' : anyHealthy ? 'degraded' : 'critical',
      uptimeSec: Math.round((now - this.startTime) / 1000),
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

export const healthTracker = new HealthTracker();

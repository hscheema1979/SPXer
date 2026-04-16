/**
 * Pipeline health counters — lightweight in-memory telemetry for every stage.
 *
 * Updated by each pipeline stage as it runs. Exposed via GET /pipeline/health
 * on the data service (port 3600).
 *
 * Zero dependencies on external services — just a plain object mutated in-place.
 * All counters reset on process restart (intentional — we want per-session metrics).
 */

export interface ProviderHealth {
  barsReceived: number;
  barsRejected: number;    // failed bar-validator check
  circuitState: 'closed' | 'open' | 'half-open';
  lastSuccessTs: number;
  lastFailureTs: number;
  consecutiveFailures: number;
}

export interface PipelineHealthSnapshot {
  capturedAt: number;        // Unix ms
  uptimeSec: number;
  currentMode: string;       // rth | overnight | pre-market | weekend
  lastModeTransition: { from: string; to: string; ts: number } | null;

  providers: {
    tradier: ProviderHealth;
    yahoo: ProviderHealth;
    tvScreener: ProviderHealth;
    optionStream: ProviderHealth;
  };

  barBuilder: {
    barsBuilt: number;
    syntheticBars: number;       // gap-interpolated or stale-filled
    gapsInterpolated: number;    // 2-60 min gaps filled with linear interpolation
    gapsStale: number;           // >60 min gaps flat-filled
    barsRejected: number;        // failed validation after build
  };

  indicators: {
    computed: number;
    nanRejected: number;         // bars rejected by NaN guard in computeIndicators()
    seedsCompleted: number;
    seedsFailed: number;
  };

  db: {
    writesAttempted: number;
    writesSucceeded: number;
    writesFailed: number;
    lastCheckpointTs: number;
    walSizeMbAtLastCheckpoint: number;
  };

  signals: {
    detected: number;
    syntheticFiltered: number;   // skipped due to stale prior bar
    lastSignal: { symbol: string; direction: string; ts: number } | null;
  };

  cycles: {
    underlying: number;
    options: number;
    lastUnderlyingMs: number;    // duration of last underlying poll cycle
    lastOptionsMs: number;
  };
}

const startTs = Date.now();

function makeProviderHealth(): ProviderHealth {
  return {
    barsReceived: 0, barsRejected: 0,
    circuitState: 'closed',
    lastSuccessTs: 0, lastFailureTs: 0,
    consecutiveFailures: 0,
  };
}

// Mutable singleton — imported and mutated directly by pipeline stages
export const pipelineHealth: PipelineHealthSnapshot = {
  capturedAt: Date.now(),
  uptimeSec: 0,
  currentMode: 'unknown',
  lastModeTransition: null,

  providers: {
    tradier:     makeProviderHealth(),
    yahoo:       makeProviderHealth(),
    tvScreener:  makeProviderHealth(),
    optionStream: makeProviderHealth(),
  },

  barBuilder: {
    barsBuilt: 0, syntheticBars: 0,
    gapsInterpolated: 0, gapsStale: 0, barsRejected: 0,
  },

  indicators: {
    computed: 0, nanRejected: 0,
    seedsCompleted: 0, seedsFailed: 0,
  },

  db: {
    writesAttempted: 0, writesSucceeded: 0, writesFailed: 0,
    lastCheckpointTs: 0, walSizeMbAtLastCheckpoint: 0,
  },

  signals: {
    detected: 0, syntheticFiltered: 0, lastSignal: null,
  },

  cycles: {
    underlying: 0, options: 0,
    lastUnderlyingMs: 0, lastOptionsMs: 0,
  },
};

/** Call once per second (or on demand) to refresh the capturedAt / uptimeSec fields */
export function refreshPipelineHealth(): PipelineHealthSnapshot {
  pipelineHealth.capturedAt = Date.now();
  pipelineHealth.uptimeSec = Math.floor((Date.now() - startTs) / 1000);
  return pipelineHealth;
}

/** Record a mode transition — called by scheduler when mode changes */
export function recordModeTransition(from: string, to: string): void {
  console.log(`[scheduler] Mode transition: ${from} → ${to}`);
  pipelineHealth.lastModeTransition = { from, to, ts: Date.now() };
  pipelineHealth.currentMode = to;
}

/** Record provider bar counts (called after each provider fetch) */
export function recordProviderBars(
  provider: keyof PipelineHealthSnapshot['providers'],
  received: number,
  rejected: number,
): void {
  const p = pipelineHealth.providers[provider];
  p.barsReceived += received;
  p.barsRejected += rejected;
  if (rejected > 0) {
    console.warn(`[pipeline-health] ${provider}: ${rejected}/${received} bars rejected by validator`);
  }
}

/** Record a DB write batch result */
export function recordDbWrite(attempted: number, succeeded: number): void {
  pipelineHealth.db.writesAttempted += attempted;
  pipelineHealth.db.writesSucceeded += succeeded;
  pipelineHealth.db.writesFailed += (attempted - succeeded);
}

/** Record a WAL checkpoint event */
export function recordCheckpoint(walMb: number): void {
  pipelineHealth.db.lastCheckpointTs = Date.now();
  pipelineHealth.db.walSizeMbAtLastCheckpoint = walMb;
}

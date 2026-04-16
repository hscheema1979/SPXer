// Resilience utilities: retry with exponential backoff + circuit breaker

export type RetryOpts = {
  retries?: number;
  initialDelayMs?: number;
  multiplier?: number;
  label?: string;
};

/**
 * Retry wrapper with exponential backoff.
 * On final failure, returns null (callers must handle null).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const initialDelayMs = opts?.initialDelayMs ?? 1000;
  const multiplier = opts?.multiplier ?? 2;
  const label = opts?.label ?? 'unknown';

  let delay = initialDelayMs;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === retries) {
        console.log(`[retry] ${label} failed after ${retries} attempts: ${lastError.message}`);
        throw lastError;
      }
      console.log(`[retry] attempt ${attempt}/${retries} for ${label} after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.round(delay * multiplier);
    }
  }
  // Unreachable, but satisfies TS
  throw lastError!;
}

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private _state: CBState = 'CLOSED';
  private _failures = 0;
  private _lastFailure: number | null = null;
  private readonly _failureThreshold: number;
  private readonly _resetTimeoutMs: number;
  private readonly _name: string;

  constructor(name: string, opts?: { failureThreshold?: number; resetTimeoutMs?: number }) {
    this._name = name;
    this._failureThreshold = opts?.failureThreshold ?? 3;
    this._resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
  }

  get state(): CBState {
    // Check if OPEN should transition to HALF_OPEN
    if (this._state === 'OPEN' && this._lastFailure !== null) {
      if (Date.now() - this._lastFailure >= this._resetTimeoutMs) {
        this._transition('HALF_OPEN');
      }
    }
    return this._state;
  }

  get stats(): { state: CBState; failures: number; lastFailure: number | null; name: string } {
    return {
      state: this.state,
      failures: this._failures,
      lastFailure: this._lastFailure,
      name: this._name,
    };
  }

  /** Returns the current circuit state as a lowercase string for health endpoints */
  getState(): string {
    return this.state.toLowerCase().replace('_', '-');
  }

  /**
   * Execute fn through the circuit breaker.
   * Returns null when circuit is OPEN (without calling fn) or on failure.
   */
  async call<T>(fn: () => Promise<T>): Promise<T | null> {
    const currentState = this.state; // triggers OPEN→HALF_OPEN check

    if (currentState === 'OPEN') {
      return null;
    }

    try {
      const result = await fn();
      if (currentState === 'HALF_OPEN') {
        this._transition('CLOSED');
        this._failures = 0;
      } else {
        // CLOSED: reset failure count on success
        this._failures = 0;
      }
      return result;
    } catch (_err) {
      this._failures++;
      this._lastFailure = Date.now();

      if (currentState === 'HALF_OPEN') {
        this._transition('OPEN');
      } else if (this._failures >= this._failureThreshold) {
        this._transition('OPEN');
      }
      return null;
    }
  }

  private _transition(to: CBState): void {
    const from = this._state;
    if (from !== to) {
      console.log(`[circuit:${this._name}] ${from} → ${to}${to === 'OPEN' ? ` after ${this._failures} failures` : ''}`);
      this._state = to;
    }
  }
}

/** Global registry of all circuit breakers for health-check inspection */
export const circuitBreakers = new Map<string, CircuitBreaker>();

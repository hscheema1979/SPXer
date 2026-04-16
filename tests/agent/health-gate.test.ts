/**
 * Health Gate circuit breaker tests.
 * Uses a real Express HTTP server to test against — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { HealthGate } from '../../src/agent/health-gate';

let app: Express;
let server: Server;
let port: number;
let healthResponse: any = {
  status: 'healthy',
  lastSpxPrice: 5800,
  data: {
    SPX: { staleSec: 10, lastBarTs: new Date().toISOString() },
  },
};

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    app = express();
    app.get('/health', (_req, res) => res.json(healthResponse));
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 3600;
      resolve(port);
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

beforeEach(() => {
  // Reset to healthy default
  healthResponse = {
    status: 'healthy',
    lastSpxPrice: 5800,
    data: {
      SPX: { staleSec: 10, lastBarTs: new Date().toISOString() },
    },
  };
});

describe('HealthGate — circuit breaker', () => {
  it('passes when data service is healthy', async () => {
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}` });
    const result = await gate.check();
    expect(result.healthy).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.dataServiceStatus).toBe('healthy');
    expect(result.spxBarAgeSec).toBe(10);
  });

  it('fails when data service is critical', async () => {
    healthResponse = {
      status: 'critical',
      lastSpxPrice: 5800,
      data: { SPX: { staleSec: 5, lastBarTs: new Date().toISOString() } },
    };
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}` });
    const result = await gate.check();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('critical');
  });

  it('fails when SPX data is stale', async () => {
    healthResponse = {
      status: 'healthy',
      lastSpxPrice: 5800,
      data: { SPX: { staleSec: 120, lastBarTs: new Date().toISOString() } },
    };
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}`, staleThresholdSec: 60 });
    const result = await gate.check();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('stale');
    expect(result.spxBarAgeSec).toBe(120);
  });

  it('fails when data service is unreachable', async () => {
    const gate = new HealthGate({ spxerUrl: 'http://localhost:1', requestTimeoutMs: 1000 });
    const result = await gate.check();
    expect(result.healthy).toBe(false);
    expect(result.dataServiceStatus).toBe('unreachable');
  });

  it('fails when no SPX price data', async () => {
    healthResponse = {
      status: 'healthy',
      lastSpxPrice: null,
      data: { SPX: { staleSec: 5 } },
    };
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}` });
    const result = await gate.check();
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('no SPX price');
  });

  it('tracks consecutive failures', async () => {
    // Return critical status
    healthResponse = { status: 'critical', data: {} };
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}`, maxFailures: 3 });
    
    const r1 = await gate.check();
    expect(r1.healthy).toBe(false);
    expect(r1.consecutiveFailures).toBe(1);

    const r2 = await gate.check();
    expect(r2.consecutiveFailures).toBe(2);

    const r3 = await gate.check();
    expect(r3.consecutiveFailures).toBe(3);
    // Should have triggered pause
    expect(r3.pauseUntil).not.toBeNull();
    expect(r3.reason).toContain('pausing');
  });

  it('pauses trading after maxFailures consecutive failures', async () => {
    healthResponse = { status: 'critical', data: {} };
    const gate = new HealthGate({
      spxerUrl: `http://localhost:${port}`,
      maxFailures: 2,
      pauseDurationMs: 5000,
    });

    await gate.check(); // failure 1
    const r2 = await gate.check(); // failure 2 → triggers pause

    // Now even if service recovers, we should still be paused
    healthResponse = {
      status: 'healthy',
      lastSpxPrice: 5800,
      data: { SPX: { staleSec: 5 } },
    };
    const r3 = await gate.check();
    expect(r3.healthy).toBe(false);
    expect(r3.reason).toContain('paused');
  });

  it('resets failure count on success', async () => {
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}` });

    // First check healthy
    const r1 = await gate.check();
    expect(r1.healthy).toBe(true);
    expect(r1.consecutiveFailures).toBe(0);

    // Fail once
    healthResponse = { status: 'critical', data: {} };
    const r2 = await gate.check();
    expect(r2.consecutiveFailures).toBe(1);

    // Recover
    healthResponse = {
      status: 'healthy',
      lastSpxPrice: 5800,
      data: { SPX: { staleSec: 5 } },
    };
    const r3 = await gate.check();
    expect(r3.healthy).toBe(true);
    expect(r3.consecutiveFailures).toBe(0);
  });

  it('getState() returns current state', async () => {
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}` });
    await gate.check(); // healthy
    const state = gate.getState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.pauseUntil).toBeNull();
    expect(state.lastHealthyTs).not.toBeNull();
  });

  it('reset() clears all state', async () => {
    healthResponse = { status: 'critical', data: {} };
    const gate = new HealthGate({ spxerUrl: `http://localhost:${port}`, maxFailures: 2 });
    await gate.check();
    await gate.check(); // triggers pause
    gate.reset();
    const state = gate.getState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.pauseUntil).toBeNull();
  });
});

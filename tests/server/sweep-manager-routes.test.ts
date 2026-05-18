/**
 * Phase 3 — sweep-manager API routes.
 *
 * Exercises only the synchronous, no-spawn paths: registry status, discovery
 * validation, SPX protection, param validation, and job 404s. Long-running
 * onboard/execute spawns are deliberately NOT triggered here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { startHttpServer } from '../../src/server/http';
import { healthTracker } from '../../src/utils/health';
import axios from 'axios';

// Unique port: 3698 is used by smoke.test.ts, 3699 by http.test.ts. Files run
// in parallel worker processes, so a shared port → EADDRINUSE flakes.
const PORT = 3691;
const BASE = `http://localhost:${PORT}/replay/api/sweep-mgr`;
const ANY = { validateStatus: () => true } as const;
let server: { close: () => void } | undefined;

beforeAll(() => {
  initDb(':memory:');
  healthTracker.reset();
  const { httpServer } = startHttpServer(PORT);
  server = httpServer;
});

afterAll(() => { server?.close(); closeDb(); });

describe('GET /registry', () => {
  it('returns the registry with coverage + sweep status', async () => {
    const { status, data } = await axios.get(`${BASE}/registry`, ANY);
    expect(status).toBe(200);
    expect(Array.isArray(data.profiles)).toBe(true);
    expect(data.profiles.length).toBeGreaterThanOrEqual(4);

    const spx = data.profiles.find((p: { symbol: string; dte: number }) => p.symbol === 'SPX' && p.dte === 0);
    expect(spx).toBeTruthy();
    expect(spx.profileId).toBe('spx-0dte');
    expect(spx.protected).toBe(true); // SPX-0dte is always protected
    expect(spx.bars).toHaveProperty('count');
    expect(spx.sweep).toHaveProperty('hasSweep');

    // A namespaced profile must NOT collide with SPX's unsuffixed files.
    const spy = data.profiles.find((p: { symbol: string }) => p.symbol === 'SPY');
    expect(spy.profileId).toMatch(/^spy-\d+dte$/);
    expect(spy.protected).toBe(false);
  });
});

describe('POST /discover', () => {
  it('400 when symbol is missing', async () => {
    const { status, data } = await axios.post(`${BASE}/discover`, {}, ANY);
    expect(status).toBe(400);
    expect(data.error).toMatch(/symbol/i);
  });
  // Note: a valid-symbol discovery hits Polygon (network + POLYGON_API_KEY)
  // so it is covered by integration, not this unit suite.
});

describe('POST /onboard — guards (no spawn)', () => {
  it('403 protects SPX-0dte without forceSpx', async () => {
    const { status, data } = await axios.post(`${BASE}/onboard`, { symbol: 'SPX', dte: 0, days: 5 }, ANY);
    expect(status).toBe(403);
    expect(data.protected).toBe(true);
  });

  it('400 when onboard is missing days', async () => {
    const { status, data } = await axios.post(`${BASE}/onboard`, { symbol: 'TSLA', dte: 1 }, ANY);
    expect(status).toBe(400);
    expect(data.error).toMatch(/days/i);
  });

  it('400 on a negative / non-numeric dte', async () => {
    const { status } = await axios.post(`${BASE}/onboard`, { symbol: 'TSLA', dte: -1, days: 5 }, ANY);
    expect(status).toBe(400);
  });
});

describe('POST /execute — guards (no spawn)', () => {
  it('403 protects SPX-0dte without forceSpx', async () => {
    const { status } = await axios.post(`${BASE}/execute`, { symbol: 'SPX', dte: 0 }, ANY);
    expect(status).toBe(403);
  });
});

describe('jobs', () => {
  it('GET /jobs returns a jobs array', async () => {
    const { status, data } = await axios.get(`${BASE}/jobs`, ANY);
    expect(status).toBe(200);
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it('GET /job/:id 404 for an unknown id', async () => {
    const { status } = await axios.get(`${BASE}/job/does-not-exist-uuid`, ANY);
    expect(status).toBe(404);
  });

  it('POST /job/:id/cancel 404 for an unknown id', async () => {
    const { status } = await axios.post(`${BASE}/job/does-not-exist-uuid/cancel`, {}, ANY);
    expect(status).toBe(404);
  });
});

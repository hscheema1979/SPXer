/**
 * Phase 3 — sweep-manager API routes.
 *
 * Exercises only the synchronous, no-spawn paths: registry status, discovery
 * validation, SPX protection, param validation, and job 404s. Long-running
 * onboard/execute spawns are deliberately NOT triggered here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSweepMgr, SWEEP_MGR_MOUNT } from '../../src/server/sweep-mgr-server';
import axios from 'axios';

// Unique port: 3698 is used by smoke.test.ts, 3699 by http.test.ts. Files run
// in parallel worker processes, so a shared port → EADDRINUSE flakes.
// The old bootstrap booted the whole :3601 replay server; that server is gone,
// so we boot the standalone sweep-mgr host instead — same mount, same routes.
const PORT = 3691;
const BASE = `http://localhost:${PORT}${SWEEP_MGR_MOUNT}`;
const ANY = { validateStatus: () => true } as const;
let server: { close: () => void } | undefined;

beforeAll(() => { server = startSweepMgr(PORT); });

afterAll(() => { server?.close(); });

describe('GET /registry', () => {
  it('returns the registry with coverage + sweep status', async () => {
    const { status, data } = await axios.get(`${BASE}/registry`, ANY);
    expect(status).toBe(200);
    expect(Array.isArray(data.profiles)).toBe(true);
    expect(data.profiles.length).toBeGreaterThanOrEqual(4);

    // Assert the SHAPE against whatever sweep-registry.json currently holds —
    // the registry has been re-scoped since this suite was written (it is now
    // multi-DTE SPX/NDX + leveraged ETFs, no SPX-0dte / SPY rows), so pinning
    // specific tickers here tests the fixture, not the route.
    for (const p of data.profiles as Array<Record<string, unknown>>) {
      expect(typeof p.symbol).toBe('string');
      expect(typeof p.dte).toBe('number');
      expect(p.profileId).toMatch(/^[a-z0-9^.-]+(-\d+dte)?$/);
      expect(p.bars).toHaveProperty('count');
      expect(p.sweep).toHaveProperty('hasSweep');
      expect(typeof p.protected).toBe('boolean');
    }

    // Regression: the five sweep-symbol.ts BASES profiles resolve without a
    // sweep-registry.json row, so a registry-only listing dropped them and the
    // Tickers page had no SPX 0DTE at all. Any BASES profile WITH parquet on
    // this box must be listed.
    const spx0 = data.profiles.find((p: { symbol: string; dte: number }) => p.symbol === 'SPX' && p.dte === 0);
    expect(spx0).toBeTruthy();
    expect(spx0.profileId).toBe('spx-0dte');
    expect(spx0.protected).toBe(true);       // SPX-0dte is always force-protected
    expect(spx0.bars.count).toBeGreaterThan(0);

    // A namespaced profile must NOT collide with SPX's unsuffixed files.
    const multiDte = data.profiles.find((p: { symbol: string; dte: number }) => p.symbol === 'SPX' && p.dte > 0);
    expect(multiDte.profileId).toMatch(/^spx-\d+dte$/);
    expect(multiDte.protected).toBe(false); // only SPX-0dte is force-protected
    // Cold scan is disk-bound (parquet listings + multi-MB sweep JSON parses);
    // measured ~9s on the live registry, so the default 10s would flake.
  }, 60_000);
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

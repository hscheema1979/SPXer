/**
 * Dashboard API tests.
 * Uses a real Express server with real filesystem operations — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import {
  startDashboardServer,
  collectState,
  readRecentTrades,
  readAgentStatus,
  readWatchdogStatus,
  isTradingPaused,
} from '../../src/dashboard/server';

const TEST_LOGS_DIR = path.resolve('./logs');

// We'll start the dashboard on a random port
let port: number;
let cleanup: () => void;

beforeAll(async () => {
  // Ensure logs dir exists
  fs.mkdirSync(TEST_LOGS_DIR, { recursive: true });
  
  const result = startDashboardServer(0); // random port
  port = (result.server.address() as any).port;
  cleanup = () => new Promise<void>(resolve => result.server.close(() => resolve()));
  
  // Wait for server to be ready
  await new Promise(r => setTimeout(r, 200));
});

afterAll(async () => {
  if (cleanup) await cleanup();
  // Clean pause flag if we created one
  try { fs.unlinkSync(path.join(TEST_LOGS_DIR, 'pause-trading.flag')); } catch {}
});

const BASE = () => `http://localhost:${port}`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Dashboard REST API', () => {
  it('GET / serves HTML', async () => {
    const resp = await axios.get(BASE());
    expect(resp.status).toBe(200);
    expect(resp.data).toContain('SPXer Dashboard');
  });

  it('GET /api/status returns dashboard state', async () => {
    const resp = await axios.get(`${BASE()}/api/status`);
    expect(resp.status).toBe(200);
    const state = resp.data;
    expect(state).toHaveProperty('ts');
    expect(state).toHaveProperty('timeET');
    expect(state).toHaveProperty('dataService');
    expect(state).toHaveProperty('agents');
    expect(state).toHaveProperty('watchdog');
    expect(state).toHaveProperty('tradingPaused');
    expect(state).toHaveProperty('positions');
    expect(state).toHaveProperty('recentTrades');
    expect(typeof state.ts).toBe('number');
  });

  it('GET /api/trades returns array', async () => {
    const resp = await axios.get(`${BASE()}/api/trades`);
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.data)).toBe(true);
  });

  it('GET /api/trades?n=5 limits results', async () => {
    const resp = await axios.get(`${BASE()}/api/trades?n=5`);
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.data)).toBe(true);
    expect(resp.data.length).toBeLessThanOrEqual(5);
  });

  it('GET /api/positions returns array', async () => {
    const resp = await axios.get(`${BASE()}/api/positions`);
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.data)).toBe(true);
  });

  it('GET /api/health returns data service health', async () => {
    try {
      const resp = await axios.get(`${BASE()}/api/health`);
      expect([200, 502]).toContain(resp.status);
    } catch (e: any) {
      // 502 is expected when data service is not running
      expect(e.response?.status).toBe(502);
    }
  });

  it('POST /api/pause creates pause flag', async () => {
    const resp = await axios.post(`${BASE()}/api/pause`);
    expect(resp.status).toBe(200);
    expect(resp.data.paused).toBe(true);
    
    // Verify flag file exists
    expect(fs.existsSync(path.join(TEST_LOGS_DIR, 'pause-trading.flag'))).toBe(true);
    
    // Verify status shows paused
    const status = await axios.get(`${BASE()}/api/status`);
    expect(status.data.tradingPaused).toBe(true);
  });

  it('POST /api/resume removes pause flag', async () => {
    // First pause
    await axios.post(`${BASE()}/api/pause`);
    
    // Then resume
    const resp = await axios.post(`${BASE()}/api/resume`);
    expect(resp.status).toBe(200);
    expect(resp.data.paused).toBe(false);
    
    // Verify flag file removed
    expect(fs.existsSync(path.join(TEST_LOGS_DIR, 'pause-trading.flag'))).toBe(false);
    
    // Verify status shows not paused
    const status = await axios.get(`${BASE()}/api/status`);
    expect(status.data.tradingPaused).toBe(false);
  });
});

describe('Dashboard data functions — real filesystem', () => {
  it('readRecentTrades returns array even with no log file', () => {
    const trades = readRecentTrades(10);
    expect(Array.isArray(trades)).toBe(true);
  });

  it('readRecentTrades parses real audit log entries', () => {
    // Check if audit log exists (it should from trading)
    const logPath = path.join(TEST_LOGS_DIR, 'agent-audit.jsonl');
    if (fs.existsSync(logPath)) {
      const trades = readRecentTrades(10);
      expect(Array.isArray(trades)).toBe(true);
      // If there are trades, verify structure
      if (trades.length > 0) {
        expect(trades[0]).toHaveProperty('ts');
        expect(trades[0]).toHaveProperty('symbol');
        expect(trades[0]).toHaveProperty('type');
      }
    }
  });

  it('readAgentStatus returns null or valid object', () => {
    const status = readAgentStatus();
    if (status) {
      expect(status).toHaveProperty('ts');
    }
  });

  it('readWatchdogStatus returns null or valid object', () => {
    const status = readWatchdogStatus();
    if (status) {
      expect(status).toHaveProperty('ts');
      expect(status).toHaveProperty('healthy');
    }
  });

  it('isTradingPaused returns boolean', () => {
    const paused = isTradingPaused();
    expect(typeof paused).toBe('boolean');
  });

  it('collectState returns complete dashboard state', async () => {
    const state = await collectState();
    expect(state.ts).toBeGreaterThan(0);
    expect(typeof state.timeET).toBe('string');
    expect(state.dataService).toBeDefined();
    expect(state.agents).toBeDefined();
    expect(typeof state.tradingPaused).toBe('boolean');
    expect(Array.isArray(state.positions)).toBe(true);
    expect(Array.isArray(state.recentTrades)).toBe(true);
  });
});

describe('Pause flag — real file system round-trip', () => {
  it('pause → status shows paused → resume → status shows not paused', async () => {
    // Verify not paused initially
    let status = await axios.get(`${BASE()}/api/status`);
    if (status.data.tradingPaused) {
      await axios.post(`${BASE()}/api/resume`);
    }

    // Pause
    await axios.post(`${BASE()}/api/pause`);
    status = await axios.get(`${BASE()}/api/status`);
    expect(status.data.tradingPaused).toBe(true);

    // Resume
    await axios.post(`${BASE()}/api/resume`);
    status = await axios.get(`${BASE()}/api/status`);
    expect(status.data.tradingPaused).toBe(false);
  });
});

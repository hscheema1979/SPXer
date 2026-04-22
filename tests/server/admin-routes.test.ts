import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';

axios.defaults.timeout = 10000;

const ECOSYSTEM_ORIGINAL = 'module.exports = { apps: [] };';
const ECOSYSTEM_TEST = 'module.exports = { apps: [{ name: "test-process" }] };';

const BASE = 'http://localhost:3600/admin/api';

describe('Admin API - Processes', () => {
  it('GET /admin/api/processes returns only SPXer processes', async () => {
    const { data, status } = await axios.get(`${BASE}/processes`);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const names = data.map((p: any) => p.name);
    expect(names).toContain('spxer');
    expect(names).not.toContain('coa-backend');
    expect(names).not.toContain('coa-frontend');
    data.forEach((p: any) => {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('status');
      expect(p).toHaveProperty('pid');
      expect(p).toHaveProperty('uptime');
    });
  });
});

describe('Admin API - Configs', () => {
  it('GET /admin/api/configs returns array', async () => {
    const { data, status } = await axios.get(`${BASE}/configs`);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
    }
  });

  it('GET /admin/api/config/:id returns merged config', async () => {
    const { data, status } = await axios.get(`${BASE}/config/spx-hma3x12-itm5-tp5x-sl20-3m-50c-$5000`);
    expect(status).toBe(200);
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('signals');
    expect(data).toHaveProperty('position');
    expect(data).toHaveProperty('risk');
    expect(data.signals).toHaveProperty('hmaCrossFast');
    expect(data.position).toHaveProperty('stopLossPercent');
  });

  it('GET /admin/api/config/:id/grouped returns 6 sections', async () => {
    const { data, status } = await axios.get(`${BASE}/config/spx-hma3x12-itm5-tp5x-sl20-3m-50c-$5000/grouped`);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(6);
    const titles = data.map((s: any) => s.title);
    expect(titles).toContain('Signals');
    expect(titles).toContain('Risk & Position');
    expect(titles).toContain('Strike Selection');
    expect(titles).toContain('Time Windows');
    expect(titles).toContain('Exit Rules');
    expect(titles).toContain('Sizing & Fill');
    const signals = data.find((s: any) => s.title === 'Signals');
    expect(signals.fields.length).toBeGreaterThan(0);
    const signalKeys = signals.fields.map((f: any) => f.key);
    expect(signalKeys).toContain('hmaCrossFast');
    expect(signalKeys).toContain('hmaCrossSlow');
  });

  it('GET /admin/api/config/nonexistent returns 404', async () => {
    try {
      await axios.get(`${BASE}/config/this-does-not-exist`);
    } catch (e: any) {
      expect(e.response.status).toBe(404);
    }
  });
});

describe('Admin API - Ecosystem', () => {
  it('GET /admin/api/ecosystem returns content', async () => {
    const { data, status } = await axios.get(`${BASE}/ecosystem`);
    expect(status).toBe(200);
    expect(data).toHaveProperty('content');
    expect(typeof data.content).toBe('string');
    expect(data.content).toContain('module.exports');
  });

  it('GET /admin/api/ecosystem/validate returns valid', async () => {
    const { data, status } = await axios.get(`${BASE}/ecosystem/validate`);
    expect(status).toBe(200);
    expect(data).toHaveProperty('valid');
    expect(data.valid).toBe(true);
  });
});

describe('Admin API - Handler State', () => {
  it('GET /admin/api/handler/state returns state', async () => {
    const { data, status } = await axios.get(`${BASE}/handler/state`);
    expect(status).toBe(200);
    expect(data).toHaveProperty('running');
    expect(data).toHaveProperty('accountId');
    expect(data).toHaveProperty('configs');
  });

  it('GET /admin/api/handler/routing returns array', async () => {
    const { data, status } = await axios.get(`${BASE}/handler/routing?n=5`);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('Admin API - Integration', () => {
  it('PUT /admin/api/process/event-handler/env/save-only writes env without restart', async () => {
    const TEST_VALUE = 'true';
    const { data, status } = await axios.put(
      `${BASE}/process/event-handler/env/save-only`,
      { envUpdates: { AGENT_PAPER: TEST_VALUE } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(status).toBe(200);
    expect(data).toHaveProperty('saved', true);
    expect(data).toHaveProperty('pendingRestart', true);
    expect(data.envUpdates.AGENT_PAPER).toBe(TEST_VALUE);
  });

  it('GET /admin/api/ecosystem/validate returns valid', async () => {
    const { data, status } = await axios.get(`${BASE}/ecosystem/validate`);
    expect(status).toBe(200);
    expect(data).toHaveProperty('valid', true);
  });

  it('PUT /admin/api/ecosystem rejects invalid JS', async () => {
    try {
      await axios.put(
        `${BASE}/ecosystem`,
        { content: 'module.exports = { apps: ["' },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e: any) {
      expect(e.response.status).toBe(400);
      expect(e.response.data).toHaveProperty('error');
    }
  });

  it('Config grouped endpoint returns 6 sections', async () => {
    const { data, status } = await axios.get(`${BASE}/config/spx-hma3x12-itm5-tp5x-sl20-3m-50c-$5000/grouped`);
    expect(status).toBe(200);
    expect(data.length).toBe(6);
    expect(data.map((s: any) => s.title)).toEqual([
      'Signals', 'Risk & Position', 'Strike Selection', 'Time Windows', 'Exit Rules', 'Sizing & Fill',
    ]);
  });
});

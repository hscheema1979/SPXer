import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { startHttpServer } from '../../src/server/http';
import { healthTracker } from '../../src/utils/health';
import axios from 'axios';

let server: any;
const PORT = 3699;

beforeAll(() => {
  initDb(':memory:');
  healthTracker.reset();
  const { httpServer } = startHttpServer(PORT);
  server = httpServer;
});

afterAll(() => { server?.close(); closeDb(); });

describe('REST API', () => {
  it('GET /health returns 200 with n/a status when no providers registered', async () => {
    const { data, status } = await axios.get(`http://localhost:${PORT}/health`);
    expect(status).toBe(200);
    // No providers registered in test → 'n/a'
    expect(data.status).toBe('n/a');
    expect(typeof data.uptime).toBe('number');
    expect(typeof data.dbSizeMb).toBe('number');
    expect(data.providers).toEqual({});
  });

  it('GET /health returns healthy when providers are succeeding', async () => {
    healthTracker.recordSuccess('tradier');
    healthTracker.recordSuccess('yahoo');
    const { data } = await axios.get(`http://localhost:${PORT}/health`);
    expect(data.status).toBe('healthy');
    expect(data.providers.tradier.healthy).toBe(true);
    expect(data.providers.yahoo.healthy).toBe(true);
    // Clean up
    healthTracker.reset();
  });

  it('GET /contracts/active returns array', async () => {
    const { data } = await axios.get(`http://localhost:${PORT}/contracts/active`);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /spx/bars returns array', async () => {
    const { data } = await axios.get(`http://localhost:${PORT}/spx/bars?tf=1m&n=10`);
    expect(Array.isArray(data)).toBe(true);
  });
});

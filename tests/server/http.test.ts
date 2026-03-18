import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { startHttpServer } from '../../src/server/http';
import axios from 'axios';

let server: any;
const PORT = 3699;

beforeAll(() => {
  initDb(':memory:');
  const { httpServer } = startHttpServer(PORT);
  server = httpServer;
});

afterAll(() => { server?.close(); closeDb(); });

describe('REST API', () => {
  it('GET /health returns 200', async () => {
    const { data, status } = await axios.get(`http://localhost:${PORT}/health`);
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
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

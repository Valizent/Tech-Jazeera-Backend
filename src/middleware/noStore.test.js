/**
 * noStore.test.js - /api responses are never cacheable, the public NFC media is
 * (2026-10-12).
 */
import express from 'express';
import { noStore } from './noStore.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/api', noStore);
  app.get('/api/data', (req, res) => res.json({ ok: true }));
  app.get('/api/fails', (req, res) => res.status(403).json({ ok: false }));
  app.get('/media/logo', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.send('png');
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('Cache-Control on the API', () => {
  it('marks a successful API response no-store', async () => {
    const res = await fetch(`${base}/api/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks an error response no-store too', async () => {
    const res = await fetch(`${base}/api/fails`);
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks an unmatched /api path no-store', async () => {
    const res = await fetch(`${base}/api/nothing-here`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves non-API routes alone', async () => {
    const res = await fetch(`${base}/media/logo`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  });
});

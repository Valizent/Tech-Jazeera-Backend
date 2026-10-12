/**
 * rateLimiter.test.js - the login throttle counts only failures, per address,
 * per address + account, and per account (2026-10-11).
 */
import express from 'express';
import { loginLimiters } from './rateLimiter.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true); // lets the tests present different client addresses
  app.use(express.json());
  app.post('/login', ...loginLimiters, (req, res) => {
    if (req.body.password === 'right') return res.json({ success: true });
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/login`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const attempt = async (email, password, ip) => {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
  return res.status;
};

describe('login throttling', () => {
  it('locks one account from one address after 8 failures, not before', async () => {
    for (let i = 0; i < 8; i++) expect(await attempt('a@x.com', 'wrong', '10.1.0.1')).toBe(401);
    expect(await attempt('a@x.com', 'wrong', '10.1.0.1')).toBe(429);
    expect(await attempt('a@x.com', 'right', '10.1.0.1')).toBe(429);
  });

  it('does not punish the rest of the office for one person\'s failures', async () => {
    for (let i = 0; i < 9; i++) await attempt('typo@x.com', 'wrong', '10.2.0.1');
    expect(await attempt('colleague@x.com', 'right', '10.2.0.1')).toBe(200);
    expect(await attempt('colleague@x.com', 'wrong', '10.2.0.1')).toBe(401);
  });

  it('never counts successful sign-ins', async () => {
    for (let i = 0; i < 100; i++) expect(await attempt('busy@x.com', 'right', '10.3.0.1')).toBe(200);
  });

  it('the same account is not locked from a different address by that first lock', async () => {
    for (let i = 0; i < 9; i++) await attempt('roam@x.com', 'wrong', '10.4.0.1');
    expect(await attempt('roam@x.com', 'right', '10.4.0.2')).toBe(200);
  });

  it('stops spraying many accounts from one address after 60 failures', async () => {
    for (let i = 0; i < 60; i++) expect(await attempt(`spray${i}@x.com`, 'wrong', '10.5.0.1')).toBe(401);
    expect(await attempt('another@x.com', 'wrong', '10.5.0.1')).toBe(429);
    expect(await attempt('another@x.com', 'right', '10.5.0.2')).toBe(200);
  });

  it('stops guessing one account from many addresses after 40 failures', async () => {
    for (let i = 0; i < 40; i++) expect(await attempt('target@x.com', 'wrong', `10.6.${Math.floor(i / 200)}.${(i % 200) + 1}`)).toBe(401);
    expect(await attempt('target@x.com', 'wrong', '10.6.9.9')).toBe(429);
  });
});

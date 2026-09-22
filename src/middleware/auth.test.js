/**
 * auth.test.js — regression coverage for F8 (docs/QA-AUDIT-2026-09-15-
 * notes.md): the original fix compared a token's `iat` (JWT spec floors
 * this to whole seconds) against `passwordChangedAt` (millisecond
 * precision) — a token issued a fraction of a second after a reset, in the
 * SAME calendar second, read as "issued before" it and was wrongly
 * rejected, including on the very login the reset had just enabled.
 * Replaced with a monotonic `User.tokenVersion` counter, compared exactly.
 */
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../modules/auth/user.model.js';
import { requireAuth } from './auth.js';

function sign(userId, tokenVersion) {
  return jwt.sign({ sub: userId.toString(), role: 'Admin', tokenVersion }, env.jwtAccessSecret, { expiresIn: '15m' });
}

function fakeReq(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** A minimal but real-enough Express response for requireAuth's success path
 *  to run all the way through: it now calls the real userLimiter middleware
 *  at the end (2026-09-22, a real QA-audit finding — P1), which sets
 *  RateLimit-* response headers — an empty `{}` (fine when requireAuth only
 *  ever called `next(err)` directly) throws on `res.setHeader` once that's
 *  a real call, not a bug in the code under test. */
function fakeRes() {
  const headers = {};
  return {
    setHeader: (name, value) => { headers[name] = value; },
    getHeader: (name) => headers[name],
    removeHeader: () => {},
    status: () => ({ json: () => {}, send: () => {} }),
    json: () => {},
    send: () => {},
  };
}

/**
 * requireAuth is wrapped in asyncHandler, whose returned function does NOT
 * return the inner promise (`Promise.resolve(fn(...)).catch(next)`, no
 * `return`) — so `await requireAuth(...)` resolves immediately without
 * waiting for the real async work. Wait on `next` actually being called
 * instead, the same way Express itself observes completion.
 */
function runAuth(req) {
  return new Promise((resolve) => {
    requireAuth(req, fakeRes(), (err) => resolve(err));
  });
}

async function makeUser() {
  return User.create({
    name: 'Test Admin',
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    passwordHash: 'x',
    role: 'Admin',
  });
}

describe('requireAuth — tokenVersion revocation (F8)', () => {
  it('accepts a token whose tokenVersion matches the current user', async () => {
    const user = await makeUser();
    const req = fakeReq(sign(user._id, 0));
    const err = await runAuth(req);
    expect(err).toBeUndefined();
    expect(req.user.id).toBe(user._id.toString());
  });

  it('rejects a token issued before a password reset bumped tokenVersion', async () => {
    const user = await makeUser();
    const oldToken = sign(user._id, 0); // tokenVersion 0, as issued at login
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } }); // simulates a password reset

    const err = await runAuth(fakeReq(oldToken));
    expect(err?.statusCode).toBe(401);
  });

  it('accepts a token minted immediately after the reset (carries the new version)', async () => {
    const user = await makeUser();
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    const fresh = await User.findById(user._id).lean();

    const newToken = sign(user._id, fresh.tokenVersion);
    const err = await runAuth(fakeReq(newToken));
    expect(err).toBeUndefined();
  });

  it('treats a legacy token with no tokenVersion claim as version 0 — not force-invalidated by this field existing', async () => {
    const user = await makeUser(); // tokenVersion defaults to 0
    const legacyToken = jwt.sign({ sub: user._id.toString(), role: 'Admin' }, env.jwtAccessSecret, { expiresIn: '15m' });
    const err = await runAuth(fakeReq(legacyToken));
    expect(err).toBeUndefined();
  });
});

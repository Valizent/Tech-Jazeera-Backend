/**
 * auth.controller.test.js — the native mobile token transport (2026-10-06,
 * docs/MOBILE-RN-notes.md). `X-Client: mobile` carries the refresh token in
 * the JSON body instead of the httpOnly cookie; the web path must be
 * byte-for-byte what it was. The important part is the separation: mobile
 * reads ONLY the body and web reads ONLY the cookie, so neither can be fed
 * the other's token.
 */
import { hashPassword } from './auth.service.js';
import User from './user.model.js';
import * as authController from './auth.controller.js';

const PASSWORD = 'Str0ng!Passw0rd#';

async function makeUser() {
  const email = `auth-ctl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await User.create({ name: 'Auth Test', email, passwordHash: await hashPassword(PASSWORD), role: 'Admin' });
  return email;
}

function fakeReq({ mobile = false, body, cookies = {} } = {}) {
  const headers = mobile ? { 'x-client': 'mobile' } : {};
  return { body, cookies, ip: '127.0.0.1', get: (name) => headers[name.toLowerCase()] };
}

function fakeRes() {
  const res = { cookies: {}, cleared: [], payload: null };
  res.cookie = (name, value) => { res.cookies[name] = value; };
  res.clearCookie = (name) => { res.cleared.push(name); };
  res.json = (payload) => { res.payload = payload; };
  return res;
}

describe('auth controller: mobile vs web refresh-token transport', () => {
  it('mobile login returns the refresh token in the body and sets no cookie', async () => {
    const email = await makeUser();
    const res = fakeRes();
    await authController.login(fakeReq({ mobile: true, body: { email, password: PASSWORD } }), res);

    expect(res.payload.data.accessToken).toBeTruthy();
    expect(res.payload.data.refreshToken).toBeTruthy();
    expect(res.cookies.refreshToken).toBeUndefined();
  });

  it('web login still sets the cookie and never exposes the token in the body', async () => {
    const email = await makeUser();
    const res = fakeRes();
    await authController.login(fakeReq({ body: { email, password: PASSWORD } }), res);

    expect(res.cookies.refreshToken).toBeTruthy();
    expect(res.payload.data.refreshToken).toBeUndefined();
  });

  it('mobile refresh rotates using the body token', async () => {
    const email = await makeUser();
    const loginRes = fakeRes();
    await authController.login(fakeReq({ mobile: true, body: { email, password: PASSWORD } }), loginRes);
    const first = loginRes.payload.data.refreshToken;

    const res = fakeRes();
    await authController.refresh(fakeReq({ mobile: true, body: { refreshToken: first } }), res);

    expect(res.payload.data.accessToken).toBeTruthy();
    expect(res.payload.data.refreshToken).toBeTruthy();
    expect(res.payload.data.refreshToken).not.toBe(first);
    expect(res.cookies.refreshToken).toBeUndefined();
  });

  it('mobile refresh ignores a cookie (body only)', async () => {
    const email = await makeUser();
    const loginRes = fakeRes();
    await authController.login(fakeReq({ body: { email, password: PASSWORD } }), loginRes);

    await expect(
      authController.refresh(fakeReq({ mobile: true, cookies: { refreshToken: loginRes.cookies.refreshToken } }), fakeRes())
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('web refresh ignores a body token (cookie only)', async () => {
    const email = await makeUser();
    const loginRes = fakeRes();
    await authController.login(fakeReq({ mobile: true, body: { email, password: PASSWORD } }), loginRes);

    await expect(
      authController.refresh(fakeReq({ body: { refreshToken: loginRes.payload.data.refreshToken } }), fakeRes())
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('mobile logout ends that session: the same token can no longer refresh', async () => {
    const email = await makeUser();
    const loginRes = fakeRes();
    await authController.login(fakeReq({ mobile: true, body: { email, password: PASSWORD } }), loginRes);
    const token = loginRes.payload.data.refreshToken;

    const logoutRes = fakeRes();
    await authController.logout(fakeReq({ mobile: true, body: { refreshToken: token } }), logoutRes);
    expect(logoutRes.cleared).toEqual([]);

    await expect(
      authController.refresh(fakeReq({ mobile: true, body: { refreshToken: token } }), fakeRes())
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

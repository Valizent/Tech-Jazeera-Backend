/**
 * Auth controller — pure HTTP translation. No business logic lives here:
 * it reads the request, calls the service, sets/clears the cookie, shapes
 * the response. If you find yourself writing an `if` about passwords or
 * tokens in this file, it belongs in auth.service.js.
 */
import env from '../../config/env.js';
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import * as authService from './auth.service.js';
import { REFRESH_TOKEN_TTL_DAYS } from './auth.service.js';

const REFRESH_COOKIE = 'refreshToken';

/**
 * Cookie settings — each flag is load-bearing:
 *   httpOnly : JavaScript can never read it → XSS can't steal it
 *   secure   : HTTPS-only in production (required for SameSite=None)
 *   sameSite : see below — differs by environment
 *   path     : only ever sent to /api/auth/* — no other endpoint sees it
 *
 * WHY sameSite IS NOT SIMPLY 'lax'.
 * In development the client (localhost:5173) and API (localhost:5000) are the
 * same site — a differing port does not change that — so 'lax' works and keeps
 * the strongest default.
 *
 * In production they are NOT: the frontend is on Vercel and the API is on
 * Render, which are different registrable domains. A 'lax' cookie is withheld
 * from cross-site requests, so the app's own POST /api/auth/refresh would never
 * receive it and every page reload would log the user out. 'none' is required
 * for the session to work at all, and browsers only accept it alongside Secure.
 *
 * 'none' means the browser will attach this cookie to requests from ANY site,
 * so the CSRF protection 'lax' was providing is replaced explicitly by
 * requireTrustedOrigin on these routes (see middleware/originGuard.js).
 *
 * maxAge matches the refresh token's own real expiry — WITHOUT it this is a
 * session cookie, which a normal desktop browser keeps for a long time in
 * practice (a "session" only ends when every window closes) but a Capacitor
 * native app's WebView does not: the app's process IS the session, so a
 * force-stop or an OS background-kill ends it for real and the cookie store
 * discards the cookie, silently breaking "stay logged in" — found by actually
 * testing that exact scenario, not assumed. Setting maxAge doesn't change
 * what the server considers valid (rotation + reuse detection in
 * auth.service.js are the real authority); it just stops the browser/WebView
 * from throwing the cookie away sooner than the server would still honor it.
 */
const cookieOptions = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: env.isProduction ? 'none' : 'lax',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

/**
 * NATIVE MOBILE TRANSPORT (2026-10-06, the React Native app in the separate
 * `Mobile application/` repo — see docs/MOBILE-RN-notes.md).
 *
 * A native app has no browser cookie jar it can rely on across app restarts
 * (exactly the problem the Capacitor build had to work around), so it sends
 * `X-Client: mobile` and carries the refresh token in the JSON body instead,
 * keeping it in the phone's Keychain/Keystore (expo-secure-store). Only the
 * TRANSPORT differs: the same token, the same rotation, the same 30s reuse
 * grace and theft detection in auth.service.js all apply unchanged.
 *
 * Mobile reads the token ONLY from the body and web ONLY from the cookie, so
 * the cookie's CSRF reasoning above is untouched: a body token is never
 * attached automatically by a browser, so a hostile site can't forge one.
 */
function isMobileClient(req) {
  return req.get('x-client') === 'mobile';
}

function readRefreshToken(req) {
  return isMobileClient(req) ? req.body?.refreshToken : req.cookies?.[REFRESH_COOKIE];
}

/** Hand the NEXT refresh token to the client the way it can store it. */
function sendSession(req, res, message, { user, accessToken, refreshToken }) {
  if (isMobileClient(req)) {
    res.json(new ApiResponse(message, { user, accessToken, refreshToken }));
    return;
  }
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  res.json(new ApiResponse(message, { user, accessToken }));
}

/**
 * POST /api/auth/login
 * Body: { email, password } (validated by loginSchema)
 * 200 → data: { user, accessToken } + sets refresh cookie
 *       (mobile: data also carries refreshToken, no cookie)
 * 400 validation / 401 bad credentials / 429 rate limited
 */
export async function login(req, res) {
  const session = await authService.login({
    ...req.body,
    ip: req.ip,
  });
  sendSession(req, res, 'Logged in.', session);
}

/**
 * POST /api/auth/refresh
 * Auth: refresh cookie only (no Bearer header — the access token may be dead);
 *       mobile: body { refreshToken } instead
 * 200 → data: { user, accessToken } + sets the NEXT refresh cookie (rotation)
 * 401 missing/expired/reused token
 * Returning `user` here lets the client restore a session after a page
 * reload with this single call.
 */
export async function refresh(req, res) {
  const session = await authService.refresh({
    refreshToken: readRefreshToken(req),
    ip: req.ip,
  });
  sendSession(req, res, 'Session refreshed.', session);
}

/**
 * POST /api/auth/logout
 * Auth: refresh cookie (idempotent — succeeds even if already logged out);
 *       mobile: body { refreshToken } instead
 * 200 → clears the cookie and deletes this device's session
 */
export async function logout(req, res) {
  await authService.logout({ refreshToken: readRefreshToken(req), ip: req.ip });
  if (!isMobileClient(req)) res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json(new ApiResponse('Logged out.'));
}

/**
 * PATCH /api/auth/password
 * Auth: Bearer (any logged-in role) + the current password in the body
 * 200 → clears the refresh cookie (every session was revoked) — the client
 * must treat this as a logout and send the user back to /login
 * 401 not logged in, or current password wrong
 */
export async function changePassword(req, res) {
  await authService.changePassword({ userId: req.user.id, ...req.body }, req.ip);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json(new ApiResponse('Password changed. Please sign in again.'));
}

/**
 * PATCH /api/auth/avatar
 * Auth: Bearer (any logged-in role), multipart field `avatar`
 * 200 → data: { avatarUrl } · 400 no file / bad type / too large
 */
export async function uploadAvatar(req, res) {
  if (!req.file) throw new ApiError(400, 'Choose an image to upload.');
  const data = await authService.updateAvatar({ userId: req.user.id, url: req.file.path }, req.ip);
  res.json(new ApiResponse('Profile photo updated.', data));
}

/**
 * DELETE /api/auth/avatar
 * Auth: Bearer (any logged-in role)
 * 200 → data: { avatarUrl: null }
 */
export async function removeAvatar(req, res) {
  const data = await authService.removeAvatar({ userId: req.user.id }, req.ip);
  res.json(new ApiResponse('Profile photo removed.', data));
}

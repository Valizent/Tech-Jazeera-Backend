/**
 * requireTrustedOrigin — CSRF defense for the cookie-authenticated routes.
 *
 * WHY THIS EXISTS NOW. The refresh token lives in a cookie, and cookies are
 * sent by the browser automatically — that is what makes CSRF possible. Until
 * the app was deployed, `SameSite=Lax` was the defense: the browser simply
 * refused to attach the cookie to a cross-site POST.
 *
 * But the frontend (Vercel) and the API (Render) are DIFFERENT SITES, so every
 * real request from the app is cross-site too. Lax would block the app's own
 * refresh call, silently logging users out on reload. The cookie therefore has
 * to be `SameSite=None`, which hands the browser's automatic-cookie behaviour
 * back to any site on the internet — so the CSRF protection Lax was providing
 * has to be replaced explicitly. This middleware is that replacement.
 *
 * HOW. Browsers attach an `Origin` header to every POST (same-origin and
 * cross-origin alike) and it cannot be spoofed by page JavaScript. If it is
 * present and is not our frontend, the request did not come from our app.
 *
 * A MISSING Origin is allowed on purpose: that means a genuinely non-browser
 * client (curl, a server-to-server call), which has no ambient cookie jar and
 * therefore cannot be the victim of CSRF. Rejecting those would break
 * legitimate API use to defend against an attack that cannot happen there.
 * Note a Capacitor native app is NOT this case — its WebView has a real
 * cookie jar and sends a real Origin header (`https://localhost` by
 * default), so it correctly goes through the trusted-origin check below,
 * not this bypass. That's why `CLIENT_URL` accepts a comma-separated list.
 *
 * Note the rest of the API needs no such guard: every other route requires an
 * `Authorization: Bearer` header, which an attacker's site cannot set on a
 * cross-origin request. Only these cookie-driven routes are exposed.
 */
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** Compare origins ignoring a trailing slash, which is easy to get wrong in env config. */
const normalize = (value) => String(value ?? '').replace(/\/+$/, '').toLowerCase();

export function requireTrustedOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next(); // non-browser client no ambient cookies to abuse

  const trusted = env.clientUrls.map(normalize);
  if (!trusted.includes(normalize(origin))) {
    logger.warn(
      `[csrf] blocked ${req.method} ${req.originalUrl} from untrusted origin "${origin}"`
    );
    throw new ApiError(403, 'Request blocked.');
  }
  next();
}

/**
 * Error tracking (self-hosted GlitchTip, Sentry-protocol-compatible) —
 * optional, same posture as webPush.js's VAPID keys: silently disabled if
 * SENTRY_DSN is unset, never blocks boot.
 *
 * Only reports genuine bugs — errorHandler.js calls captureError() itself
 * for a non-operational (isOperational:false) error, never for an expected
 * ApiError (400/403/404) — those aren't things anyone needs paged for, and
 * reporting them would just burn quota with noise. server.js also reports
 * uncaught exceptions/unhandled rejections here.
 *
 * SECURITY: scrubs anything that looks like a sensitive field (passwords,
 * tokens, Iqama/passport numbers, salary, bank details) out of whatever
 * gets sent, wherever it's nested — same "never even send it" discipline
 * Winston's own logger already follows. `sendDefaultPii: false` also stops
 * the SDK from attaching the caller's IP by default.
 */
import * as Sentry from '@sentry/node';
import env from './env.js';

const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'newpassword', 'currentpassword',
  'token', 'accesstoken', 'refreshtoken', 'secret', 'authorization', 'cookie',
  'iqama', 'iqamanumber', 'passport', 'passportnumber',
  'salary', 'basicsalary', 'housingallowance', 'transportallowance',
  'iban', 'bankaccount', 'accountnumber', 'nationalid',
]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      clean[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[Filtered]' : scrub(val);
    }
    return clean;
  }
  return value;
}

if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    tracesSampleRate: 0, // error tracking only — no performance/tracing data
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        if (event.request.headers) delete event.request.headers.authorization;
        if (event.request.data) event.request.data = scrub(event.request.data);
      }
      return scrub(event);
    },
  });
}

/** Report a genuine bug — a no-op if SENTRY_DSN isn't configured. */
export function captureError(err, context) {
  if (!env.sentryDsn) return;
  Sentry.captureException(err, context ? { extra: scrub(context) } : undefined);
}

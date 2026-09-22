/**
 * Request metrics — one structured log line per response (2026-09-22, a
 * real QA-audit finding: the "monitoring baseline" recommendation). Winston
 * already writes JSON to `logs/combined.log` in production (see
 * config/logger.js) — this reuses that existing, already-deployed
 * infrastructure rather than adding a new dependency or service, exactly
 * "establish a privacy-conscious performance baseline" from the audit's own
 * words: no request body, no response body, no user-identifying data — just
 * method/route/status/duration/size, which is what real p50/p95, payload
 * size, and 429-frequency numbers need.
 *
 * Mounted as the FIRST middleware in app.js (before helmet/cors/parsers/rate
 * limiting) so `durationMs` reflects the full request lifecycle, and so a
 * request a rate limiter rejects is measured too — `res.on('finish')` fires
 * regardless of which later middleware produced the response, so a 429 from
 * any of rateLimiter.js's limiters lands in this same log with status:429;
 * counting those gives 429 frequency with no separate mechanism needed.
 *
 * `route` is the matched Express route pattern (e.g. `/api/employees/:id`),
 * not the raw URL — using the raw URL would blow up log cardinality with
 * every distinct id ever requested and make aggregation pointless. Falls
 * back to the raw path (query string stripped) for a 404, which never
 * matches a route.
 */
import logger from '../config/logger.js';

export function requestMetrics(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    const bytes = Number(res.getHeader('content-length'));
    logger.info('request', {
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ...(Number.isFinite(bytes) && bytes > 0 ? { bytes } : {}),
    });
  });
  next();
}

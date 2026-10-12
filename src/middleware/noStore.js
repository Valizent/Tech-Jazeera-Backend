/**
 * noStore - every /api response carries `Cache-Control: no-store` (2026-10-12,
 * pre-production pass finding 5).
 *
 * API bodies are per-user data (employees, pay, approvals). Without an explicit
 * directive a shared office proxy or a browser's back/forward cache is allowed
 * to keep them, so one login's data could be shown to the next person at the
 * same machine. `no-store` forbids keeping any copy.
 *
 * Mounted on /api only: the public NFC media (`/nfc-media`) is deliberately
 * cacheable and lives outside /api. Mounted before the rate limiter so a 429
 * carries the header too.
 */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

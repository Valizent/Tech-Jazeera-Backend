/**
 * Central environment configuration.
 *
 * Why this file exists: reading `process.env` all over the codebase makes it
 * impossible to know what configuration the app actually needs, and a missing
 * variable then fails at some random moment deep in a request. Instead, this
 * file is the ONLY place that touches `process.env`. It validates everything
 * once, at boot, and the rest of the app imports the frozen `env` object.
 * If configuration is broken the process exits immediately with a message
 * that tells you exactly which variable to fix.
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

/** Accumulates human-readable problems so we can report them all at once. */
const problems = [];

/** Require a variable to be present and non-empty. */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    problems.push(`${name} is missing. See server/.env.example for the expected format.`);
    return undefined;
  }
  return value.trim();
}

/** Optional variable with a fallback — never blocks boot. */
function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/** Require a comma-separated list of values, trimmed and trailing-slash-stripped. */
function requiredList(name) {
  const value = required(name);
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((v) => v.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** Require a variable to be one of an allowed set of values. */
function requiredEnum(name, allowed) {
  const value = required(name);
  if (value !== undefined && !allowed.includes(value)) {
    problems.push(`${name} must be one of: ${allowed.join(', ')} (got "${value}").`);
    return undefined;
  }
  return value;
}

/** Require a variable to be a valid TCP port number. */
function requiredPort(name) {
  const value = required(name);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${name} must be an integer between 1 and 65535 (got "${value}").`);
    return undefined;
  }
  return port;
}

/** Require a secret with enough entropy to resist brute-forcing. */
function requiredSecret(name) {
  const value = required(name);
  if (value !== undefined && value.length < 32) {
    problems.push(`${name} must be at least 32 characters. Generate one with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`);
    return undefined;
  }
  return value;
}

/**
 * Require a filesystem path and return it ABSOLUTE. A relative value (e.g.
 * `./uploads`) is resolved against the process working directory (the server/
 * folder, since npm scripts run there). Storing the absolute path means the
 * rest of the app never has to reason about cwd.
 */
function requiredDir(name) {
  const value = required(name);
  if (value === undefined) return undefined;
  return path.resolve(value);
}

const env = Object.freeze({
  nodeEnv: requiredEnum('NODE_ENV', ['development', 'production']),
  port: requiredPort('PORT'),
  mongodbUri: required('MONGODB_URI'),
  clientUrls: requiredList('CLIENT_URL'),
  jwtAccessSecret: requiredSecret('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: requiredSecret('JWT_REFRESH_SECRET'),
  uploadDir: requiredDir('UPLOAD_DIR'),
  // Public origin the NFC tap pages are served on (goes into card URLs, QR
  // codes and CSV exports). Defaults to the local API origin; override in
  // production with the real card domain. Optional so it never blocks boot.
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:5000').replace(/\/+$/, ''),
  cloudinaryCloudName: required('CLOUDINARY_CLOUD_NAME'),
  cloudinaryApiKey: required('CLOUDINARY_API_KEY'),
  cloudinaryApiSecret: required('CLOUDINARY_API_SECRET'),
  // Web Push (P3-F) — optional, unlike the required config above: an
  // existing deployment without these configured yet shouldn't fail to
  // boot over a feature that degrades gracefully (see config/webPush.js).
  vapidPublicKey: optional('VAPID_PUBLIC_KEY', null),
  vapidPrivateKey: optional('VAPID_PRIVATE_KEY', null),
  vapidSubject: optional('VAPID_SUBJECT', null),
  // Error tracking (self-hosted GlitchTip) — optional, same posture as VAPID
  // above: an existing deployment without this set shouldn't fail to boot.
  sentryDsn: optional('SENTRY_DSN', null),
  isProduction: process.env.NODE_ENV === 'production',
});

// Fail fast: refuse to boot with broken configuration. We deliberately use
// console.error here (not the Winston logger) because the logger itself may
// depend on configuration.
if (problems.length > 0) {
  console.error('\n[env] Server cannot start — invalid environment configuration:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('\nFix server/.env and try again.\n');
  process.exit(1);
}

// Ensure the upload directory exists (create it if missing). Done here, once,
// so upload handlers can assume the destination is ready.
try {
  fs.mkdirSync(env.uploadDir, { recursive: true });
} catch (err) {
  console.error(`\n[env] Could not create UPLOAD_DIR at ${env.uploadDir}: ${err.message}\n`);
  process.exit(1);
}

export default env;

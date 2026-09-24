/**
 * Server boot — the process entry point.
 *
 * Boot order is a guarantee, not an accident:
 *   1. import env.js   → validates ALL env vars, exits if broken
 *   2. connect MongoDB → exits if unreachable
 *   3. listen          → only now can the app receive traffic
 *
 * The server therefore never runs in a half-configured state.
 */
import env from './config/env.js'; // side effect: validates env, may exit
import { captureError } from './config/sentry.js'; // side effect: initializes Sentry, if configured
import logger from './config/logger.js';
import { connectDb } from './config/db.js';
import { startPeriodicMonitoring } from './config/monitoring.js';
import app from './app.js';
import { runExpiryAlertCheck } from './modules/notifications/expiryAlert.job.js';
import { runMobilisationStaleCheck } from './modules/notifications/mobilisationStale.job.js';
import { runOverdueInvoiceCheck } from './modules/notifications/overdueInvoice.job.js';

// Without these, a stray unhandled promise rejection or thrown error outside
// Express's own request handling (e.g. inside a setInterval job's own bug,
// not the .catch()-wrapped job runs below) can kill the process with zero
// log of why — PM2 restarts it, but you'd never know what happened. Register
// before connectDb() so a boot-time failure is caught too.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
  captureError(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.stack || error}`);
  captureError(error);
  process.exit(1);
});

try {
  await connectDb();
} catch (err) {
  logger.error(`Failed to connect to MongoDB: ${err.message}`);
  logger.error(
    'Check MONGODB_URI in server/.env, and that your IP is allowed in Atlas → Network Access.'
  );
  process.exit(1);
}

const server = app.listen(env.port, () => {
  logger.info(`API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

// 2026-09-22, a real QA-audit finding — the "monitoring baseline"
// recommendation: event-loop delay + an aggregate Mongo operation count,
// logged every minute. See monitoring.js's own doc comment.
const monitoringInterval = startPeriodicMonitoring();

// P3-F: the expiry-alert notification job — once shortly after boot (so a
// server that's been down doesn't wait a full day for the first check),
// then every 24 hours. A plain setInterval, not a job-queue dependency —
// see expiryAlert.job.js's doc comment for why that's the right call here.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(() => runExpiryAlertCheck().catch((err) => logger.error(`[expiryAlertJob] failed: ${err.message}`)), 10_000);
const expiryAlertInterval = setInterval(
  () => runExpiryAlertCheck().catch((err) => logger.error(`[expiryAlertJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Same pattern, offset by 15s so the two jobs' initial runs don't overlap.
setTimeout(() => runMobilisationStaleCheck().catch((err) => logger.error(`[mobilisationStaleJob] failed: ${err.message}`)), 15_000);
const mobilisationStaleInterval = setInterval(
  () => runMobilisationStaleCheck().catch((err) => logger.error(`[mobilisationStaleJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Same pattern again, offset by 20s so all three jobs' initial runs don't overlap.
setTimeout(() => runOverdueInvoiceCheck().catch((err) => logger.error(`[overdueInvoiceJob] failed: ${err.message}`)), 20_000);
const overdueInvoiceInterval = setInterval(
  () => runOverdueInvoiceCheck().catch((err) => logger.error(`[overdueInvoiceJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then close the DB connection. Without this, a deploy/restart can
 * cut off requests mid-write.
 */
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);
  clearInterval(expiryAlertInterval);
  clearInterval(mobilisationStaleInterval);
  clearInterval(overdueInvoiceInterval);
  clearInterval(monitoringInterval);
  server.close(async () => {
    const { default: mongoose } = await import('mongoose');
    await mongoose.connection.close();
    logger.info('Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

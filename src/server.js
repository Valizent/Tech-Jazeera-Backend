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
import { ensureSelfServiceRoles } from './modules/approvals/approvals.service.js';
import { retireLegacyWorkflowIndex } from './modules/approvals/approvalWorkflow.model.js';
import { migrateLegacyEmployeeOverrides } from './modules/approvals/approvals.service.js';
import { runExpiryAlertCheck } from './modules/notifications/expiryAlert.job.js';
import { runApprovalEscalationCheck } from './modules/notifications/approvalEscalation.job.js';
import { runDeploymentBillingCheck } from './modules/notifications/deploymentBilling.job.js';
import { runCompanyDetailsCheck } from './modules/notifications/companyDetails.job.js';
import { runContractEndCheck } from './modules/notifications/contractEnd.job.js';
import { runOutsourcedDocumentCheck } from './modules/notifications/outsourcedDocuments.job.js';

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

// The reserved "Worker" and "Staff" approval roles must exist before anyone opens the
// Section Access page (2026-10-10). Idempotent; a failure here must not stop the API.
await ensureSelfServiceRoles().catch((err) => logger.error(`ensureSelfServiceRoles failed: ${err.message}`));
await retireLegacyWorkflowIndex().catch((err) => logger.error(`retireLegacyWorkflowIndex failed: ${err.message}`));
await migrateLegacyEmployeeOverrides().catch((err) => logger.error(`migrateLegacyEmployeeOverrides failed: ${err.message}`));

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

// Approval escalation reminders (the matrix set per workflow step), offset by 15s.
setTimeout(() => runApprovalEscalationCheck().catch((err) => logger.error(`[approvalEscalationJob] failed: ${err.message}`)), 15_000);
const approvalEscalationInterval = setInterval(
  () => runApprovalEscalationCheck().catch((err) => logger.error(`[approvalEscalationJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Same pattern again, offset by 25s.
setTimeout(() => runDeploymentBillingCheck().catch((err) => logger.error(`[deploymentBillingJob] failed: ${err.message}`)), 25_000);
const deploymentBillingInterval = setInterval(
  () => runDeploymentBillingCheck().catch((err) => logger.error(`[deploymentBillingJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Missing client/subcontractor details reminders and escalation, offset by 35s.
setTimeout(() => runCompanyDetailsCheck().catch((err) => logger.error(`[companyDetailsJob] failed: ${err.message}`)), 35_000);
const companyDetailsInterval = setInterval(
  () => runCompanyDetailsCheck().catch((err) => logger.error(`[companyDetailsJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Contract-end alerts to HR, offset by 45s.
setTimeout(() => runContractEndCheck().catch((err) => logger.error(`[contractEndJob] failed: ${err.message}`)), 45_000);
const contractEndInterval = setInterval(
  () => runContractEndCheck().catch((err) => logger.error(`[contractEndJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

// Outsourced workers' document reminders, offset by 55s.
setTimeout(() => runOutsourcedDocumentCheck().catch((err) => logger.error(`[outsourcedDocumentsJob] failed: ${err.message}`)), 55_000);
const outsourcedDocumentsInterval = setInterval(
  () => runOutsourcedDocumentCheck().catch((err) => logger.error(`[outsourcedDocumentsJob] failed: ${err.message}`)),
  ONE_DAY_MS
);

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then close the DB connection. Without this, a deploy/restart can
 * cut off requests mid-write.
 */
async function shutdown(signal) {
  logger.info(`${signal} received shutting down gracefully...`);
  clearInterval(expiryAlertInterval);
  clearInterval(approvalEscalationInterval);
  clearInterval(deploymentBillingInterval);
  clearInterval(companyDetailsInterval);
  clearInterval(contractEndInterval);
  clearInterval(outsourcedDocumentsInterval);
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

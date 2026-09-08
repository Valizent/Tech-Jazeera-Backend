/**
 * Express application assembly.
 *
 * This file wires middleware and routes together — nothing else. Keeping it
 * separate from server.js means the app can later be imported without
 * starting a listener (useful for testing and for keeping boot logic clean).
 *
 * MIDDLEWARE ORDER MATTERS and is deliberate:
 *   1. helmet     — set security headers before anything else runs
 *   2. cors       — reject foreign origins early, allow credentials for the
 *                   refresh-token cookie (M2)
 *   3. parsers    — JSON body with a size cap (large bodies are a DoS vector)
 *   4. rate limit — applied to /api as a whole
 *   5. routes     — feature modules mount here as milestones add them
 *   6. 404        — anything that fell through every route
 *   7. errors     — LAST, so it catches failures from all of the above
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import ApiResponse from './utils/ApiResponse.js';
import authRoutes from './modules/auth/auth.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import employeeRoutes from './modules/employees/employee.routes.js';
import clientRoutes from './modules/clients/client.routes.js';
import deploymentRoutes from './modules/deployments/deployment.routes.js';
import attendanceRoutes from './modules/attendance/attendance.routes.js';
import documentRoutes from './modules/documents/document.routes.js';
import quotationRoutes from './modules/quotations/quotation.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import timesheetProcessorRoutes from './modules/timesheetProcessor/timesheet.routes.js';
import nfcRoutes from './modules/nfc/nfc.routes.js';
import nfcPublicRoutes from './modules/nfc/nfc.public.routes.js';
import { serveNfcMedia } from './modules/nfc/nfc.upload.js';
import userRoutes from './modules/users/user.routes.js';
import leaveRoutes from './modules/leave/leave.routes.js';
import holidayRoutes from './modules/holidays/holiday.routes.js';
import ramadanPeriodRoutes from './modules/ramadan/ramadanPeriod.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import settlementRoutes from './modules/eosb/settlement.routes.js';
import financialRequestsRoutes from './modules/financialRequests/financialRequests.routes.js';
import assetRoutes from './modules/assets/asset.routes.js';
import exitDocumentsRoutes from './modules/exitDocuments/exitDocuments.routes.js';
import timesheetRoutes from './modules/timesheets/timesheet.routes.js';
import payrollRoutes from './modules/payroll/payroll.routes.js';
import invoiceRoutes from './modules/invoices/invoice.routes.js';
import expenseRoutes from './modules/expenses/expense.routes.js';
import meRoutes from './modules/me/me.routes.js';
import profileRoutes from './modules/me/profile.routes.js';
import staffAttendanceRoutes from './modules/staffAttendance/staffAttendance.routes.js';
import approvalsRoutes from './modules/approvals/approvals.routes.js';
import companySettingsRoutes from './modules/companySettings/companySettings.routes.js';
import subcontractorRoutes from './modules/subcontractors/subcontractor.routes.js';
import jobTitleRoutes from './modules/jobTitles/jobTitle.routes.js';
import mobilisationRoutes from './modules/mobilisations/mobilisation.routes.js';
import mobilisationSettingsRoutes from './modules/mobilisationSettings/mobilisationSettings.routes.js';
import sectionAccessRoutes from './modules/sectionAccess/sectionAccess.routes.js';

const app = express();

// Behind a reverse proxy (production), trust it so req.ip is the real client
// IP — otherwise rate limiting and audit logs would see the proxy's IP.
if (env.isProduction) app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.clientUrls, // array of exact origins, not '*' — required for cookies;
                            // `cors` reflects back only the matched origin
    credentials: true, // allow the httpOnly refresh-token cookie (M2)
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser()); // parses the httpOnly refresh-token cookie
app.use('/api', apiLimiter);

/**
 * GET /api/health — liveness check, public and unauthenticated (an uptime
 * monitor needs to reach it with no credentials). Deliberately minimal: it
 * used to also report environment and live DB connection state, which is
 * free reconnaissance for anyone on the internet and unnecessary for what
 * an uptime monitor actually needs — a 200.
 */
app.get('/api/health', (req, res) => {
  res.json(new ApiResponse('OK', { status: 'up' }));
});

// Feature modules — each module mounts its own router.
app.use('/api/auth', authRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/deployments', deploymentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/timesheet-processor', timesheetProcessorRoutes);
app.use('/api/nfc', nfcRoutes);
// P2-M2: staff-account management, leave (types + requests), and the
// self-service "me" surface a Worker's ESS portal runs on.
app.use('/api/users', userRoutes);
app.use('/api', leaveRoutes); // owns /api/leave-types and /api/leave
app.use('/api/holidays', holidayRoutes);
app.use('/api/ramadan-periods', ramadanPeriodRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/eosb', settlementRoutes);
app.use('/api/financial-requests', financialRequestsRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/exit-documents', exitDocumentsRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/me', meRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/staff-attendance', staffAttendanceRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/company-settings', companySettingsRoutes);
app.use('/api/subcontractors', subcontractorRoutes);
app.use('/api/job-titles', jobTitleRoutes);
app.use('/api/mobilisations', mobilisationRoutes);
app.use('/api/mobilisation-settings', mobilisationSettingsRoutes);
app.use('/api/section-access', sectionAccessRoutes);

// Public NFC tap pages — server-rendered HTML, NOT under /api (no auth, own
// rate limiter). Must be mounted before the 404 handler.
app.use('/c', nfcPublicRoutes);

// Public NFC media (logos/photos) — random-named files, cached, no auth.
app.get('/nfc-media/:filename', serveNfcMedia);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

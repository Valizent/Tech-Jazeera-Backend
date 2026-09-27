/**
 * Deployment billing overdue job (2026-09-27, the user's own described
 * process) — structurally mirrors mobilisationStale.job.js/overdueInvoice.
 * job.js (same setInterval registration in server.js, same notifyUser
 * dedupeKey fan-out — a fixed key per item+recipient means "notify once,
 * ever," so a daily re-scan never re-spams). Two independent checks:
 *
 *  - Timesheet overdue: a fully-elapsed calendar month, for an Active
 *    Deployment, with no monthlyHours entry yet — the user's own "45 days
 *    maximum" window for the client to send their timesheet. Notifies
 *    whoever holds 'deploymentsHours' write (they're the one who has to
 *    chase it).
 *  - Payment overdue: a monthlyHours entry that's been invoiced
 *    (`invoiceSentAt` set) but not yet fully resolved
 *    (`paymentDecisionStatus !== 'Approved'`) past its `invoiceDueAt` (set
 *    at send time, 50 days out — see deployment.service.js's sendInvoice).
 *    Notifies whoever holds 'deploymentsHours' write (chasing the client)
 *    AND 'deploymentsPaymentDecide' write (the Financial Manager, who needs
 *    to know real money is late).
 *
 * Company-wide, not Coordinator-scoped, same reasoning expiryAlert.job.js
 * gives for its own fan-out: whoever already owns this data company-wide.
 */
import Deployment from '../deployments/deployment.model.js';
import { getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const TIMESHEET_OVERDUE_DAYS = 45;
const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);

async function writeMembers(sectionKey) {
  const settings = await getSectionAccess(sectionKey);
  return membersOfRoles(settings.writeApprovalRoles);
}

/** 'YYYY-MM' strings for every fully-elapsed calendar month from
 *  `startDate` through last month (never the current, still-in-progress
 *  one), capped at `endDate` if the deployment has already ended. */
function elapsedMonths(startDate, endDate) {
  const months = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const now = new Date();
  const lastFullMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const cap = endDate && endDate < lastFullMonthEnd ? endDate : lastFullMonthEnd;

  while (cursor <= cap) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
    months.push({
      month: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      monthEnd,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

async function checkTimesheetOverdue() {
  const deployments = await Deployment.find({ status: 'Active', archived: { $ne: true } })
    .select('workerName startDate monthlyHours')
    .lean();
  if (deployments.length === 0) return { found: 0, sent: 0 };

  const recipients = await writeMembers('deploymentsHours');
  if (recipients.length === 0) return { found: 0, sent: 0 };

  let found = 0;
  let sent = 0;
  for (const d of deployments) {
    const enteredMonths = new Set(d.monthlyHours.map((m) => m.month));
    for (const { month, monthEnd } of elapsedMonths(new Date(d.startDate), null)) {
      if (enteredMonths.has(month)) continue;
      if (daysSince(monthEnd) < TIMESHEET_OVERDUE_DAYS) continue;
      found += 1;
      for (const userId of recipients) {
        const result = await notifyUser(userId, {
          type: 'RequestStatus',
          title: `${month} timesheet overdue for ${d.workerName}`,
          body: `${daysSince(monthEnd)} day(s) since month-end with no client timesheet entered.`,
          url: `/deployments/${d._id}`,
          dedupeKey: `deployment-timesheet-overdue:${d._id}:${month}:${userId}`,
        });
        if (result.wasNew) sent += 1;
      }
    }
  }
  return { found, sent };
}

async function checkPaymentOverdue() {
  const now = new Date();
  const deployments = await Deployment.find({
    archived: { $ne: true },
    monthlyHours: {
      $elemMatch: { invoiceSentAt: { $ne: null }, paymentDecisionStatus: { $ne: 'Approved' }, invoiceDueAt: { $lt: now } },
    },
  })
    .select('workerName monthlyHours')
    .lean();
  if (deployments.length === 0) return { found: 0, sent: 0 };

  const [hoursRecipients, fmRecipients] = await Promise.all([
    writeMembers('deploymentsHours'),
    writeMembers('deploymentsPaymentDecide'),
  ]);
  const recipients = [...new Set([...hoursRecipients, ...fmRecipients].map((id) => id.toString()))];
  if (recipients.length === 0) return { found: 0, sent: 0 };

  let found = 0;
  let sent = 0;
  for (const d of deployments) {
    for (const entry of d.monthlyHours) {
      if (!entry.invoiceSentAt || entry.paymentDecisionStatus === 'Approved') continue;
      if (!entry.invoiceDueAt || new Date(entry.invoiceDueAt) >= now) continue;
      found += 1;
      const days = daysSince(entry.invoiceDueAt);
      for (const userId of recipients) {
        const result = await notifyUser(userId, {
          type: 'RequestStatus',
          title: `Payment overdue for ${d.workerName} (${entry.month})`,
          body: `${days} day(s) past the invoice due date with no approved payment.`,
          url: `/deployments/${d._id}`,
          dedupeKey: `deployment-payment-overdue:${d._id}:${entry.month}:${userId}`,
        });
        if (result.wasNew) sent += 1;
      }
    }
  }
  return { found, sent };
}

export async function runDeploymentBillingCheck() {
  const [timesheet, payment] = await Promise.all([checkTimesheetOverdue(), checkPaymentOverdue()]);

  if (timesheet.found === 0 && payment.found === 0) {
    logger.info('[deploymentBillingJob] nothing overdue — skipped.');
  } else {
    logger.info(
      `[deploymentBillingJob] ${timesheet.found} timesheet(s) overdue (${timesheet.sent} notified), ${payment.found} payment(s) overdue (${payment.sent} notified).`
    );
  }
  return { timesheetFound: timesheet.found, timesheetNotified: timesheet.sent, paymentFound: payment.found, paymentNotified: payment.sent };
}

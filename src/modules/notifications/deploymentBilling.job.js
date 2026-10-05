/**
 * Deployment billing overdue job (2026-09-27, the user's own described
 * process) — structurally mirrors mobilisationStale.job.js/overdueInvoice.
 * job.js (same setInterval registration in server.js, same notifyUser
 * dedupeKey fan-out). Two independent checks:
 *
 *  - Timesheet overdue: a fully-elapsed calendar month, for an Active
 *    Deployment, with no monthlyHours entry yet — the user's own "45 days
 *    maximum" window for the client to send their timesheet. Notifies
 *    whoever holds 'deploymentsHours' write (they're the one who has to
 *    chase it). Fixed "notify once, ever" dedupeKey — a single nudge is
 *    enough here.
 *  - Payment due escalation (2026-09-27 follow-up, the user's own ask): a
 *    monthlyHours entry that's been invoiced (`invoiceSentAt` set) but
 *    still has a real outstanding balance — since the same-day bulk-payment
 *    redesign (see clientPayment.service.js), that's no longer a per-entry
 *    `paymentDecisionStatus`; it's this entry's own live FIFO allocation
 *    against its client's real payment history
 *    (deployment.service.js's getClientAllocation), walked once per
 *    distinct client here rather than once per entry. Notifies with
 *    INCREASING frequency as its `invoiceDueAt` (50 days out — see
 *    deployment.service.js's sendInvoice) approaches: at 10/5/3/2/1/0 days
 *    remaining, then EVERY SINGLE DAY once overdue (a real mounting
 *    drumbeat, not a one-time notice) — each stage gets its own dedupeKey,
 *    and "overdue" embeds the exact day count so it's a fresh key daily.
 *    Audience is deliberately NOT deploymentsHours/deploymentsPaymentDecide
 *    here — it's every coordinator on the source Mobilisation ("mainly
 *    coordinators" — they own the client relationship and are the ones who
 *    actually call/email to get paid) plus whoever holds 'mobilisationsViewer'
 *    write (this company's real MM already does — reused rather than a new
 *    Section Access key just for this audience).
 *
 * Timesheet-overdue stays company-wide, same reasoning expiryAlert.job.js
 * gives for its own fan-out; payment-due escalation is per-mobilisation
 * (coordinator-scoped by nature of who it notifies).
 */
import Deployment from '../deployments/deployment.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import { getClientAllocation } from '../deployments/deployment.service.js';
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

// Days-remaining thresholds that each fire exactly once (closing gaps as the
// deadline nears is what makes this feel like "more and more"); anything
// past 0 (overdue) is handled separately below since it fires every day.
const PRE_DUE_MILESTONES = [10, 5, 3, 2, 1, 0];

/** Which escalation stage (if any) fires today for this many days remaining
 *  until the invoice is due. `null` = nothing to send today. A negative
 *  number (already overdue) always returns a fresh, day-specific stage —
 *  that's the "every single day once overdue" half of the ask. */
function escalationStage(daysRemaining) {
  if (daysRemaining < 0) return `overdue-${Math.abs(daysRemaining)}`;
  if (PRE_DUE_MILESTONES.includes(daysRemaining)) return `t-minus-${daysRemaining}`;
  return null;
}

async function checkPaymentDueEscalation() {
  const deployments = await Deployment.find({
    archived: { $ne: true },
    monthlyHours: { $elemMatch: { invoiceSentAt: { $ne: null } } },
  })
    .select('client workerName clientName mobilisation monthlyHours')
    .lean();
  if (deployments.length === 0) return { found: 0, sent: 0 };

  const mmSettings = await getSectionAccess('mobilisationsViewer');
  const mmRecipients = (await membersOfRoles(mmSettings.writeApprovalRoles)).map((id) => id.toString());
  const coordinatorsCache = new Map(); // mobilisationId -> [coordinatorIdString]

  // One ledger walk per distinct client, not per entry — a client's real
  // outstanding balance depends on their FULL invoice history.
  const clientIds = [...new Set(deployments.map((d) => d.client.toString()))];
  const allocationByEntryId = new Map();
  for (const clientId of clientIds) {
    const { perEntry } = await getClientAllocation(clientId);
    for (const e of perEntry) allocationByEntryId.set(e.entryId.toString(), e);
  }

  const now = Date.now();
  let found = 0;
  let sent = 0;
  for (const d of deployments) {
    if (!d.mobilisation) continue;
    for (const entry of d.monthlyHours) {
      if (!entry.invoiceSentAt || !entry.invoiceDueAt) continue;
      const alloc = allocationByEntryId.get(entry._id.toString());
      if (!alloc || alloc.balanceDue <= 0) continue;
      const daysRemaining = Math.ceil((new Date(entry.invoiceDueAt).getTime() - now) / 86_400_000);
      const stage = escalationStage(daysRemaining);
      if (!stage) continue;
      found += 1;

      const mobId = d.mobilisation.toString();
      if (!coordinatorsCache.has(mobId)) {
        const mob = await Mobilisation.findById(mobId).select('coordinators').lean();
        coordinatorsCache.set(mobId, (mob?.coordinators ?? []).map((c) => c.user.toString()));
      }
      const audience = [...new Set([...coordinatorsCache.get(mobId), ...mmRecipients])];

      const title =
        daysRemaining < 0
          ? `Payment overdue for ${d.workerName} (${entry.month})`
          : `Payment due in ${daysRemaining} day(s) for ${d.workerName} (${entry.month})`;
      const invoiceRef = entry.invoiceNumber ? `Invoice ${entry.invoiceNumber} ` : '';
      const body =
        daysRemaining < 0
          ? `${invoiceRef}${Math.abs(daysRemaining)} day(s) past due follow up with ${d.clientName}.`
          : `${invoiceRef}due ${new Date(entry.invoiceDueAt).toDateString()} time to follow up with ${d.clientName}.`;

      for (const userId of audience) {
        const result = await notifyUser(userId, {
          type: 'RequestStatus',
          title,
          body,
          url: `/financial/payments-due`,
          dedupeKey: `deployment-payment-due:${d._id}:${entry.month}:${stage}:${userId}`,
        });
        if (result.wasNew) sent += 1;
      }
    }
  }
  return { found, sent };
}

export async function runDeploymentBillingCheck() {
  const [timesheet, payment] = await Promise.all([checkTimesheetOverdue(), checkPaymentDueEscalation()]);

  if (timesheet.found === 0 && payment.found === 0) {
    logger.info('[deploymentBillingJob] nothing overdue skipped.');
  } else {
    logger.info(
      `[deploymentBillingJob] ${timesheet.found} timesheet(s) overdue (${timesheet.sent} notified), ${payment.found} payment(s) overdue (${payment.sent} notified).`
    );
  }
  return { timesheetFound: timesheet.found, timesheetNotified: timesheet.sent, paymentFound: payment.found, paymentNotified: payment.sent };
}

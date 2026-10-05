/**
 * Expiry-alert background job (P3-F) — the "push channel for expiry alerts"
 * half of the plan. Runs the SAME identity-doc/document-expiry check the
 * dashboard already shows (IDENTITY_DOCS, EXPIRY_WARNING_DAYS, imported from
 * dashboard.service.js so there's one source of truth for "what counts as
 * expiring"), but as a proactive notification instead of something you only
 * see by opening the dashboard.
 *
 * Company-wide, not Coordinator-team-scoped: Admin/Manager/HR already see
 * every expiring item on the dashboard today (only Coordinator has the
 * team-scoped view), so they're this job's fan-out target. A Coordinator
 * still sees their own team's expiring documents when they log in — this
 * job just doesn't additionally push to them; a deliberate scope line, not
 * an oversight (see docs/P3-F-notes.md).
 *
 * No new scheduler dependency: a single setInterval in server.js is simpler
 * and entirely sufficient for a once-a-day check in a single-process app —
 * pulling in a job-queue library for this would be the "don't add a library
 * where ~30 lines would do" rule working in reverse.
 */
import Employee from '../employees/employee.model.js';
import Document from '../documents/document.model.js';
import User from '../auth/user.model.js';
import { IDENTITY_DOCS, EXPIRY_WARNING_DAYS } from '../dashboard/dashboard.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const daysUntil = (date) => Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

export async function runExpiryAlertCheck() {
  const threshold = new Date(Date.now() + EXPIRY_WARNING_DAYS * 86_400_000);
  const identityExpiryOr = IDENTITY_DOCS.map(([key]) => ({ [`${key}.expiry`]: { $ne: null, $lte: threshold } }));

  const [expiringEmployees, expiringDocs, staffUsers] = await Promise.all([
    Employee.find({ status: { $ne: 'Exited' }, $or: identityExpiryOr })
      .select('fullName employeeId passport visa iqama medical drivingLicense')
      .lean(),
    Document.find({ expiryDate: { $ne: null, $lte: threshold } })
      .populate('owner', 'fullName companyName')
      .limit(200)
      .lean(),
    User.find({ role: { $in: ['Admin', 'Manager', 'HR'] }, isActive: true }).select('_id').lean(),
  ]);

  const items = [];
  for (const e of expiringEmployees) {
    for (const [key, label] of IDENTITY_DOCS) {
      const expiry = e[key]?.expiry;
      if (expiry && new Date(expiry) <= threshold) {
        items.push({
          ownerName: e.fullName,
          ref: e.employeeId,
          label,
          expiry,
          dedupePart: `employee:${e._id}:${key}:${dayKey(expiry)}`,
        });
      }
    }
  }
  for (const d of expiringDocs) {
    items.push({
      ownerName: d.owner?.fullName ?? d.owner?.companyName ?? 'Unknown',
      ref: d.category,
      label: d.title,
      expiry: d.expiryDate,
      dedupePart: `document:${d._id}:${dayKey(d.expiryDate)}`,
    });
  }

  if (items.length === 0 || staffUsers.length === 0) {
    logger.info('[expiryAlertJob] nothing expiring, or no staff to notify skipped.');
    return { itemsFound: items.length, notificationsSent: 0 };
  }

  let notificationsSent = 0;
  for (const item of items) {
    const daysLeft = daysUntil(item.expiry);
    const title = daysLeft < 0 ? `${item.label} expired` : `${item.label} expiring soon`;
    const body = `${item.ownerName} (${item.ref}) ${
      daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day(s) ago` : `${daysLeft} day(s) left`
    }.`;
    for (const staff of staffUsers) {
      // A dedupeKey per (item, recipient): re-running this job daily must
      // not re-notify the same still-expiring item to the same person —
      // but each staff member still needs their own record (read status
      // is per-user, not shared).
      const result = await notifyUser(staff._id, {
        type: 'Expiry',
        title,
        body,
        url: '/',
        dedupeKey: `${item.dedupePart}:${staff._id}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
  }

  logger.info(`[expiryAlertJob] ${items.length} expiring item(s) → ${notificationsSent} notification(s) (new ones only, dedupe handles repeats).`);
  return { itemsFound: items.length, notificationsSent };
}

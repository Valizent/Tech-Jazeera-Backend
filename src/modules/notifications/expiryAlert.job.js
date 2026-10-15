/**
 * Expiry-alert background job. Two halves, one daily run:
 *
 * 1. Employee identity documents (rewritten 2026-10-14, the user's ask): the
 *    employee and HR are told on a ladder that gets tighter as the date
 *    approaches, and the heads join as it gets close.
 *
 *      Starts:   passport, driving licence  6 months before expiry
 *                iqama, medical, visa       3 months before expiry
 *      Repeats:  monthly while more than 30 days are left, weekly from 30 days,
 *                daily in the last 7 days, daily once expired - until HR enters
 *                the new expiry date (a new date starts a new ladder).
 *      Told:     the employee (their login, if any) and every active HR user
 *                from the first alert; from 30 days also the employee's
 *                coordinator and manager; from 14 days (and once expired) also
 *                the GM and COO approval roles and Admin.
 *
 *    One notification per (document, expiry date, step, person): re-running the
 *    job any number of times a day never repeats one (notifyUser's dedupeKey).
 *
 * 2. Company/client documents (the Documents module) keep the original rule:
 *    within EXPIRY_WARNING_DAYS, once per document, to Admin/Manager/HR.
 *
 * No scheduler dependency: a setInterval in server.js drives it.
 */
import Employee from '../employees/employee.model.js';
import Document from '../documents/document.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { IDENTITY_DOCS, EXPIRY_WARNING_DAYS } from '../dashboard/dashboard.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

/** Months before expiry that the ladder starts, per identity document. */
export const START_MONTHS = { passport: 6, drivingLicense: 6, iqama: 3, medical: 3, visa: 3 };
/** Approval roles told from ESCALATE_TO_HEADS_DAYS onwards (looked up by name; absent ones are skipped). */
const SENIOR_ROLE_NAMES = ['GM', 'COO'];
const ESCALATE_TO_LINE_DAYS = 30;
const ESCALATE_TO_HEADS_DAYS = 14;

const daysUntil = (date) => Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/** The notification step a document is in today; the key changes exactly when a new reminder is due. */
export function expiryStep(daysLeft) {
  if (daysLeft < 0) return `x${dayKey(new Date())}`;
  if (daysLeft <= 7) return `d${daysLeft}`;
  if (daysLeft <= 30) return `w${Math.ceil(daysLeft / 7)}`;
  return `m${Math.ceil(daysLeft / 30)}`;
}

const startsBy = (months) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

/** An employee's documents worth reminding about: the five identity documents and any "additional" ones. */
function employeeDocuments(employee) {
  return [
    ...IDENTITY_DOCS.map(([key, label]) => ({ key, label, expiry: employee[key]?.expiry, months: START_MONTHS[key] })),
    ...(employee.additionalDocuments ?? []).map((doc, i) => ({ key: `extra${i}`, label: doc.name, expiry: doc.expiry, months: 3 })),
  ];
}

async function runEmployeeDocuments() {
  const identityExpiryOr = [
    ...IDENTITY_DOCS.map(([key]) => ({ [`${key}.expiry`]: { $ne: null, $lte: startsBy(START_MONTHS[key]) } })),
    { 'additionalDocuments.expiry': { $ne: null, $lte: startsBy(3) } },
  ];
  const [employees, hr, seniorRoles, admins] = await Promise.all([
    Employee.find({ status: { $ne: 'Exited' }, $or: identityExpiryOr })
      .select('fullName employeeId passport visa iqama medical drivingLicense additionalDocuments coordinator manager')
      .lean(),
    User.find({ role: 'HR', isActive: true }).select('_id').lean(),
    ApprovalRole.find({ name: { $in: SENIOR_ROLE_NAMES }, isActive: true }).select('members').lean(),
    User.find({ role: 'Admin', isActive: true }).select('_id').lean(),
  ]);
  const logins = await User.find({ employee: { $in: employees.map((e) => e._id) }, isActive: true }).select('_id employee').lean();
  const loginOf = new Map(logins.map((u) => [String(u.employee), u._id]));
  const seniorIds = [...seniorRoles.flatMap((r) => r.members), ...admins.map((a) => a._id)];

  let itemsFound = 0;
  let notificationsSent = 0;
  for (const e of employees) {
    for (const { key, label, expiry, months } of employeeDocuments(e)) {
      if (!expiry || new Date(expiry) > startsBy(months)) continue;
      itemsFound += 1;
      const daysLeft = daysUntil(expiry);
      const step = expiryStep(daysLeft);
      const when = daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day(s) ago` : daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day(s)`;
      const title = daysLeft < 0 ? `${label} expired` : `${label} expiring soon`;
      const base = `${key}:${e._id}:${dayKey(expiry)}:${step}`;

      const line = [e.coordinator, e.manager].filter(Boolean);
      const recipients = new Map(); // userId -> message
      const about = `${e.fullName} (${e.employeeId}): ${label} ${when}.`;
      for (const u of hr) recipients.set(String(u._id), about);
      if (daysLeft <= ESCALATE_TO_LINE_DAYS) for (const id of line) recipients.set(String(id), about);
      if (daysLeft <= ESCALATE_TO_HEADS_DAYS) for (const id of seniorIds) recipients.set(String(id), about);
      const own = loginOf.get(String(e._id));
      if (own) recipients.set(String(own), `Your ${label} ${when}. Please renew it and give the new date to HR.`);

      for (const [userId, body] of recipients) {
        const result = await notifyUser(userId, {
          type: 'Expiry',
          title,
          body,
          url: `/employees/${e._id}`,
          dedupeKey: `${base}:${userId}`,
        });
        if (result.wasNew) notificationsSent += 1;
      }
    }
  }
  return { itemsFound, notificationsSent };
}

async function runCompanyDocuments() {
  const threshold = new Date(Date.now() + EXPIRY_WARNING_DAYS * 86_400_000);
  const [docs, staff] = await Promise.all([
    Document.find({ expiryDate: { $ne: null, $lte: threshold } })
      .populate('owner', 'fullName companyName name')
      .limit(200)
      .lean(),
    User.find({ role: { $in: ['Admin', 'Manager', 'HR'] }, isActive: true }).select('_id').lean(),
  ]);
  let notificationsSent = 0;
  for (const d of docs) {
    const daysLeft = daysUntil(d.expiryDate);
    const owner = d.owner?.fullName ?? d.owner?.companyName ?? d.owner?.name ?? 'Unknown';
    const body = `${owner} (${d.category}) ${daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day(s) ago` : `${daysLeft} day(s) left`}.`;
    for (const person of staff) {
      const result = await notifyUser(person._id, {
        type: 'Expiry',
        title: daysLeft < 0 ? `${d.title} expired` : `${d.title} expiring soon`,
        body,
        url: '/',
        dedupeKey: `document:${d._id}:${dayKey(d.expiryDate)}:${person._id}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
  }
  return { itemsFound: docs.length, notificationsSent };
}

export async function runExpiryAlertCheck() {
  const [employees, documents] = await Promise.all([runEmployeeDocuments(), runCompanyDocuments()]);
  const itemsFound = employees.itemsFound + documents.itemsFound;
  const notificationsSent = employees.notificationsSent + documents.notificationsSent;
  logger.info(`[expiryAlertJob] ${itemsFound} expiring item(s) -> ${notificationsSent} new notification(s).`);
  return { itemsFound, notificationsSent };
}

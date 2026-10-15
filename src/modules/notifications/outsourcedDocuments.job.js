/**
 * Outsourced workers' document reminders (2026-10-15, the user's own ask): each document the coordinators
 * record on an outsourced worker (Ajeer, Muqeem, passport...) carries its own "remind me N days before" lead
 * time. Once that window opens the worker's coordinator(s) are told; the Marketing Manager role joins in the
 * last week and once it has expired (and from the start when the worker has no coordinator on record).
 *
 *   inside the lead time:   one reminder
 *   last 14 days:           weekly
 *   last 3 days:            daily
 *   expired:                daily until the date is corrected or the document removed
 *
 * One notification per (document, expiry date, step, person), so running the job any number of times a day
 * never repeats one. A plain setInterval in server.js drives it, like the other jobs.
 */
import OutsourcedEmployee from '../employees/outsourcedEmployee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import User from '../auth/user.model.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

/** The approval role told as the expiry closes in (found by name; absent = skipped). */
const ESCALATION_ROLE = 'MM';
const DAY = 86_400_000;

const utcDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const dayKey = (date) => utcDay(date).toISOString().slice(0, 10);

/** The notification step a document is in today; the key changes exactly when a new reminder is due. */
export function outsourcedDocumentStep(daysLeft) {
  if (daysLeft < 0) return `x${dayKey(new Date())}`;
  if (daysLeft <= 3) return `d${daysLeft}`;
  if (daysLeft <= 14) return `w${Math.ceil(daysLeft / 7)}`;
  return 'start';
}

export async function runOutsourcedDocumentCheck() {
  const today = utcDay(new Date());
  const workers = await OutsourcedEmployee.find({ 'documents.expiryDate': { $ne: null } })
    .select('name iqamaNumber documents')
    .lean();

  const due = [];
  for (const worker of workers) {
    for (const doc of worker.documents ?? []) {
      if (!doc.expiryDate) continue;
      const daysLeft = Math.round((utcDay(doc.expiryDate).getTime() - today.getTime()) / DAY);
      if (daysLeft <= (doc.reminderDays ?? 30)) due.push({ worker, doc, daysLeft });
    }
  }
  if (due.length === 0) return { itemsFound: 0, notificationsSent: 0 };

  const [escalation] = await ApprovalRole.find({ name: ESCALATION_ROLE, isActive: true }).select('members').lean();
  const escalationIds = (escalation?.members ?? []).map(String);
  const active = new Set(
    (await User.find({ _id: { $in: escalationIds }, isActive: true }).select('_id').lean()).map((u) => String(u._id))
  );

  let notificationsSent = 0;
  for (const { worker, doc, daysLeft } of due) {
    const mobilisation = worker.iqamaNumber
      ? await Mobilisation.findOne({ iqamaNumber: worker.iqamaNumber, archived: { $ne: true } })
          .sort({ createdAt: -1 })
          .select('coordinators')
          .lean()
      : null;
    const coordinators = (mobilisation?.coordinators ?? []).map((c) => String(c.user));
    const recipients = new Set(coordinators);
    // The Marketing Manager joins as it closes in, and from the start when nobody coordinates the worker.
    if (daysLeft <= 7 || coordinators.length === 0) for (const id of escalationIds) if (active.has(id)) recipients.add(id);

    const when = daysLeft < 0 ? `expired ${Math.abs(daysLeft)} day(s) ago` : daysLeft === 0 ? 'expires today' : `expires in ${daysLeft} day(s)`;
    const step = outsourcedDocumentStep(daysLeft);
    for (const userId of recipients) {
      const result = await notifyUser(userId, {
        type: 'Expiry',
        title: daysLeft < 0 ? `${doc.title} expired` : `${doc.title} expiring soon`,
        body: `${worker.name}: ${doc.title} ${when}.`,
        url: '/outsourced-employees',
        dedupeKey: `outdoc:${worker._id}:${doc._id}:${dayKey(doc.expiryDate)}:${step}:${userId}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
  }
  logger.info(`[outsourcedDocumentsJob] ${due.length} document(s) in a reminder window -> ${notificationsSent} new notification(s).`);
  return { itemsFound: due.length, notificationsSent };
}

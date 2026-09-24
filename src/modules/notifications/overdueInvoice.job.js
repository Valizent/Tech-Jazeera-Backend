/**
 * Overdue-invoice background job (2026-09-24) — same "no new scheduler
 * dependency, a single setInterval is entirely sufficient for a once-a-day
 * check" reasoning as expiryAlert.job.js's own doc comment.
 *
 * Notifies once per invoice going overdue (Invoice.overdueNotifiedAt is set
 * the first time, so re-running this daily doesn't re-notify the same
 * still-overdue invoice) — reset to null if a payment/credit brings the
 * invoice current again, so a LATER relapse notifies again (see
 * invoice.service.js's recordPayment and creditNote.service.js's
 * createCreditNote).
 *
 * Notify target: Admin/Manager/Accounts — the roles who actually handle
 * invoices, same reasoning expiryAlert.job.js gives for its own fan-out
 * list (whoever already sees this data on their own dashboard/module).
 */
import Invoice from '../invoices/invoice.model.js';
import User from '../auth/user.model.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

export async function runOverdueInvoiceCheck() {
  const now = new Date();
  const [overdueInvoices, staffUsers] = await Promise.all([
    Invoice.find({ status: { $ne: 'Paid' }, dueDate: { $ne: null, $lt: now }, overdueNotifiedAt: null })
      .select('invoiceNumber clientName balanceDue dueDate')
      .lean(),
    User.find({ role: { $in: ['Admin', 'Manager', 'Accounts'] }, isActive: true }).select('_id').lean(),
  ]);

  if (overdueInvoices.length === 0 || staffUsers.length === 0) {
    logger.info('[overdueInvoiceJob] no newly-overdue invoices, or no staff to notify — skipped.');
    return { invoicesFound: 0, notificationsSent: 0 };
  }

  let notificationsSent = 0;
  for (const inv of overdueInvoices) {
    const daysOverdue = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86_400_000);
    const title = 'Invoice overdue';
    const body = `${inv.invoiceNumber} — ${inv.clientName} — SAR ${inv.balanceDue} — ${daysOverdue} day(s) overdue.`;
    for (const staff of staffUsers) {
      const result = await notifyUser(staff._id, {
        type: 'RequestStatus',
        title,
        body,
        url: `/invoices/${inv._id}`,
        dedupeKey: `invoice-overdue:${inv._id}:${dayKey(inv.dueDate)}:${staff._id}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
    // Set AFTER notifying every recipient — a crash mid-fan-out simply
    // retries the whole invoice next run (notifyUser's own dedupeKey makes
    // that safe/idempotent per recipient), rather than silently under-
    // notifying half the staff list.
    await Invoice.updateOne({ _id: inv._id }, { overdueNotifiedAt: now });
  }

  logger.info(`[overdueInvoiceJob] ${overdueInvoices.length} newly-overdue invoice(s) → ${notificationsSent} notification(s).`);
  return { invoicesFound: overdueInvoices.length, notificationsSent };
}

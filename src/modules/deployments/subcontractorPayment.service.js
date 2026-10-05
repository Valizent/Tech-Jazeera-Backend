/**
 * Subcontractor payment ledger — bulk, subcontractor-level payment tracking on top of
 * Deployment.monthlyHours' per-worker invoices (2026-09-27, the user's own
 * correction: "a subcontractor doesn't pay per worker, they pay one amount for
 * everyone that month"). See subcontractorPayment.model.js's own doc comment for
 * why nothing beyond the raw payment amounts is ever stored.
 *
 * Deliberately knows NOTHING about Deployment/Mobilisation/how an invoiced
 * amount is computed — `allocateSubcontractorPayments` below is pure ledger math,
 * given a list of already-priced invoiced items by deployment.service.js
 * (which owns that domain knowledge). This is the same one-directional
 * dependency rule this app already follows elsewhere (see
 * deployment.service.js's own top doc comment on why it depends on
 * Mobilisation's MODEL, never its service) — deployment.service.js is
 * allowed to import FROM this file; this file must never import FROM
 * deployment.service.js, or the two would form a circular service
 * dependency. Audience lookups below query the Deployment MODEL directly
 * (fine, same as everywhere else in this app), never its service.
 */
import Deployment from './deployment.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import SubcontractorPayment from './subcontractorPayment.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from '../notifications/notification.service.js';

function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function decidersOfDeploymentsPayment() {
  const settings = await getSectionAccess('deploymentsPaymentDecide');
  return membersOfRoles(settings.writeApprovalRoles);
}

/**
 * Every coordinator on any mobilisation behind a Deployment placed at this
 * subcontractor, plus whoever holds 'mobilisationsViewer' write (this company's
 * real MM) — the same broad-visibility audience sendInvoice's own
 * paymentTrackingAudience(mobilisationId) already uses, just widened from
 * one mobilisation to every mobilisation this subcontractor has.
 */
async function subcontractorPaymentAudience(subcontractorId) {
  const [deployments, mmSettings] = await Promise.all([
    Deployment.find({ subcontractor: subcontractorId, archived: { $ne: true } })
      .select('mobilisation')
      .populate('mobilisation', 'coordinators')
      .lean(),
    getSectionAccess('mobilisationsViewer'),
  ]);
  const coordinatorIds = new Set();
  for (const dep of deployments) {
    for (const c of dep.mobilisation?.coordinators ?? []) coordinatorIds.add(c.user.toString());
  }
  const mmIds = await membersOfRoles(mmSettings.writeApprovalRoles);
  for (const id of mmIds) coordinatorIds.add(id.toString());
  return [...coordinatorIds];
}

/**
 * Pure ledger math: given every invoiced-but-outstanding item for a subcontractor
 * (each `{ ...whateverTheCallerWants, revenue, invoiceSentAt }`, from
 * deployment.service.js, which is the only place that knows how to price
 * one), decide how much of each has actually been paid — oldest invoice
 * first — against this subcontractor's own Approved payments, oldest payment
 * first within that. Recomputed live on every call, never cached, same
 * discipline computeMonthlyRevenueAndExpenses itself already follows.
 * Whatever's left in the pool once every item is fully covered is an
 * implicit credit balance — needs no field of its own, since the next call
 * that includes a newer invoice will simply see a bigger pool.
 *
 * Each entry's `amountAllocated`/`balanceDue`/`fullyPaid` stay the
 * invoice's own CUMULATIVE totals, exactly as before — every existing
 * caller (Payments Due, the Actual Performance dashboard, coordinator
 * targets) keeps working unchanged. `payments` is new (2026-10-01, the
 * user's own ask — Paid Invoices shows a real $3,000-then-$2,000 history as
 * two rows, not one $5,000 lump): the real, ordered list of which specific
 * SubcontractorPayment(s) actually cover this invoice and how much of each, with
 * `runningBalance` = what was still owed on THIS invoice immediately after
 * that one payment landed — a second-dimension FIFO (a payment can span
 * across invoices, and an invoice can draw from more than one payment) on
 * top of the existing oldest-invoice-first order.
 */
export async function allocateSubcontractorPayments(subcontractorId, invoicedItems) {
  const sorted = [...invoicedItems].sort((a, b) => new Date(a.invoiceSentAt) - new Date(b.invoiceSentAt));

  const approvedPayments = await SubcontractorPayment.find({ subcontractor: subcontractorId, decisionStatus: 'Approved' })
    .select('amount paymentDate paymentReference')
    .sort({ paymentDate: 1, _id: 1 })
    .lean();
  const pool = approvedPayments.map((p) => ({ ...p, remaining: p.amount }));
  let poolIndex = 0;

  const perEntry = [];
  for (const item of sorted) {
    let needed = item.revenue;
    let runningBalance = item.revenue;
    const payments = [];
    while (needed > 0 && poolIndex < pool.length) {
      const p = pool[poolIndex];
      if (p.remaining <= 0) {
        poolIndex += 1;
        continue;
      }
      const take = money(Math.min(needed, p.remaining));
      p.remaining = money(p.remaining - take);
      needed = money(needed - take);
      runningBalance = money(runningBalance - take);
      payments.push({
        paymentId: p._id,
        amount: take,
        paymentDate: p.paymentDate,
        paymentReference: p.paymentReference,
        runningBalance,
      });
      if (p.remaining <= 0) poolIndex += 1;
    }
    const allocated = money(item.revenue - needed);
    const balanceDue = money(needed);
    perEntry.push({ ...item, amountAllocated: allocated, balanceDue, fullyPaid: balanceDue <= 0, payments });
  }

  const creditBalance = money(pool.reduce((sum, p) => sum + p.remaining, 0));
  return { perEntry, creditBalance };
}

/** One subcontractor's real payment history — Pending/Approved/Rejected, newest
 *  first — for the Payments Due page's drill-down. */
export async function getSubcontractorPaymentHistory(subcontractorId) {
  return SubcontractorPayment.find({ subcontractor: subcontractorId })
    .sort({ recordedAt: -1 })
    .populate('recordedBy', 'name')
    .populate('decidedBy', 'name')
    .lean();
}

/** One flat list of all Pending payments across all subcontractors — for the manager's review queue. */
export async function getPendingPaymentsQueue(actor) {
  const allowed = await canAccessSection('deploymentsPaymentDecide', actor);
  if (!allowed && actor.role !== 'Admin') {
    throw new ApiError(403, 'You do not have permission to view the payments approval queue.');
  }
  return SubcontractorPayment.find({ decisionStatus: 'Pending' })
    .sort({ recordedAt: 1 })
    .populate('subcontractor', 'name')
    .populate('recordedBy', 'name')
    .lean();
}

/**
 * Office Secretary (or 'deploymentsHours' write) records what the subcontractor
 * actually paid, in bulk, this time — sits Pending until the Financial
 * Manager decides it. Recording does NOT itself allocate anything (see
 * allocateSubcontractorPayments's own doc comment); only an Approved payment ever
 * counts toward it.
 */
export async function recordSubcontractorPayment(subcontractorId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to record a received payment.');

  const subcontractor = await Subcontractor.findById(subcontractorId).select('name').lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');

  const payment = await SubcontractorPayment.create({
    subcontractor: subcontractorId,
    amount: data.amount,
    paymentReference: data.paymentReference || null,
    ...(data.paymentDate && { paymentDate: data.paymentDate }),
    recordedBy: actor.userId,
  });

  await logAudit({
    user: actor.userId,
    action: 'subcontractorPayment.record',
    targetType: 'SubcontractorPayment',
    targetId: payment._id,
    meta: { subcontractor: subcontractorId, amount: data.amount },
    ip: actor.ip,
  });

  const deciders = await decidersOfDeploymentsPayment();
  for (const userId of deciders) {
    await notifyUser(userId, {
      type: 'RequestStatus',
      title: `A payment for ${subcontractor.name} needs your approval`,
      body: `SAR ${data.amount} recorded as received.`,
      url: '/financial/payments-due',
    });
  }
  return payment.toObject();
}

/**
 * Financial-Manager sign-off. Approving is the ONLY thing that makes a
 * payment count in allocateSubcontractorPayments — no separate "apply" step,
 * nothing else to keep in sync. Rejecting simply leaves it out forever.
 */
export async function decideSubcontractorPayment(paymentId, data, actor) {
  const allowed = await canAccessSection('deploymentsPaymentDecide', actor);
  if (!allowed) throw new ApiError(403, 'You do not have permission to approve a received payment.');

  const existing = await SubcontractorPayment.findById(paymentId);
  if (!existing) throw new ApiError(404, 'Payment not found.');
  if (existing.decisionStatus !== 'Pending') throw new ApiError(400, 'Only a pending payment can be decided.');

  const subcontractor = await Subcontractor.findById(existing.subcontractor).select('name').lean();

  // Atomic transition (2026-09-29, a real audit finding): the old
  // read-then-save let two concurrent deciders on the same Pending payment
  // race — the second save would silently overwrite the first's decision.
  // Filtering the update on `decisionStatus: 'Pending'` means only the
  // first of two concurrent requests can match; the loser gets a clean 400.
  const payment = await SubcontractorPayment.findOneAndUpdate(
    { _id: paymentId, decisionStatus: 'Pending' },
    { decisionStatus: data.decision, decidedBy: actor.userId, decidedAt: new Date(), decisionNote: data.note || null },
    { new: true }
  );
  if (!payment) throw new ApiError(400, 'Only a pending payment can be decided.');

  await logAudit({
    user: actor.userId,
    action: 'subcontractorPayment.decide',
    targetType: 'SubcontractorPayment',
    targetId: payment._id,
    meta: { subcontractor: payment.subcontractor, decision: data.decision, amount: payment.amount },
    ip: actor.ip,
  });

  await notifyUser(payment.recordedBy.toString(), {
    type: 'RequestStatus',
    title:
      data.decision === 'Approved'
        ? `Payment for ${subcontractor?.name ?? 'a subcontractor'} approved`
        : `Payment for ${subcontractor?.name ?? 'a subcontractor'} rejected`,
    body: data.note || undefined,
    url: '/financial/payments-due',
  });

  if (data.decision === 'Approved') {
    const audience = await subcontractorPaymentAudience(payment.subcontractor);
    for (const userId of audience) {
      if (userId === payment.recordedBy.toString()) continue;
      await notifyUser(userId, {
        type: 'RequestStatus',
        title: `A payment for ${subcontractor?.name ?? 'a subcontractor'} was approved`,
        body: `SAR ${payment.amount} now credited against outstanding invoices.`,
        url: '/financial/payments-due',
      });
    }
  }

  return payment.toObject();
}

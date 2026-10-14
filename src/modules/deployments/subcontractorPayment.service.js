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
import { allocatePayments } from './paymentAllocation.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles, decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { startApproval } from '../approvals/approvals.service.js';
import { populateTrail } from '../approvals/approvalFields.js';
import { notifyUser } from '../notifications/notification.service.js';

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
  const approvedPayments = await SubcontractorPayment.find({ subcontractor: subcontractorId, decisionStatus: 'Approved' })
    .select('amount paymentDate paymentReference allocated allocations')
    .lean();
  return allocatePayments(invoicedItems, approvedPayments);
}

/** One subcontractor's real payment history — Pending/Approved/Rejected, newest
 *  first — for the Payments Due page's drill-down. */
export async function getSubcontractorPaymentHistory(subcontractorId) {
  return SubcontractorPayment.find({ subcontractor: subcontractorId })
    .sort({ recordedAt: -1 })
    .populate('recordedBy', 'name')
    .populate('decidedBy', 'name')
    .populate(populateTrail())
    .lean();
}

/** One flat list of all Pending payments across all subcontractors — for the manager's review queue. */
export async function getPendingPaymentsQueue(actor) {
  const allowed = await canAccessSection('deploymentsPaymentDecide', actor);
  if (!allowed && actor.role !== 'Admin') {
    throw new ApiError(403, 'You do not have permission to view the payments approval queue.');
  }
  const pending = await SubcontractorPayment.find({ decisionStatus: 'Pending' })
    .sort({ recordedAt: 1 })
    .populate('subcontractor', 'name')
    .populate('recordedBy', 'name')
    .populate(populateTrail())
    .lean();
  return annotateCanDecide(pending, actor, { pendingStatus: 'Pending', statusField: 'decisionStatus', legacyCanDecide: true });
}

/**
 * Office Secretary (or 'deploymentsHours' write) records what the subcontractor
 * actually paid, in bulk, this time — sits Pending until the Financial
 * Manager decides it. Recording does NOT itself allocate anything (see
 * allocateSubcontractorPayments's own doc comment); only an Approved payment ever
 * counts toward it.
 */
export async function recordSubcontractorPayment(subcontractorId, data, actor, planAllocations = null) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to record a received payment.');

  const subcontractor = await Subcontractor.findById(subcontractorId).select('name').lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');

  // The invoices the recorder picked, in order, turned into amounts (see
  // clientPayment.service.js's recordClientPayment).
  const picked = data.invoiceKeys?.length && planAllocations ? await planAllocations(data.amount, data.invoiceKeys) : null;

  const payment = await SubcontractorPayment.create({
    subcontractor: subcontractorId,
    amount: data.amount,
    paymentReference: data.paymentReference || null,
    ...(data.paymentDate && { paymentDate: data.paymentDate }),
    ...(picked && { allocated: true, allocations: picked.allocations }),
    recordedBy: actor.userId,
    ...(await startApproval('SubcontractorPayment')),
  });

  await logAudit({
    user: actor.userId,
    action: 'subcontractorPayment.record',
    targetType: 'SubcontractorPayment',
    targetId: payment._id,
    meta: { subcontractor: subcontractorId, amount: data.amount },
    ip: actor.ip,
  });

  const needsApproval = {
    type: 'RequestStatus',
    title: `A payment for ${subcontractor.name} needs your approval`,
    body: `SAR ${data.amount} recorded as paid.`,
    url: '/financial/sub-payments-review',
  };
  if (payment.workflow) {
    await notifySubmission(payment.toObject(), () => needsApproval);
  } else {
    const deciders = await decidersOfDeploymentsPayment();
    for (const userId of deciders) await notifyUser(userId, needsApproval);
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

  const existing = await SubcontractorPayment.findById(paymentId).select('subcontractor').lean();
  if (!existing) throw new ApiError(404, 'Payment not found.');
  const subcontractor = await Subcontractor.findById(existing.subcontractor).select('name').lean();
  const subName = subcontractor?.name ?? 'a subcontractor';

  // Through the shared approval engine (2026-10-14), same shape as decideClientPayment.
  return decideApprovalStep({
    Model: SubcontractorPayment,
    id: paymentId,
    decision: data.decision,
    note: data.note || null,
    actor,
    pendingStatus: 'Pending',
    statusField: 'decisionStatus',
    authorizeLegacy: async () => {},
    notFoundMessage: 'Payment not found.',
    auditAction: 'subcontractorPayment',
    buildFinalNotification: (payment) => ({
      type: 'RequestStatus',
      title: `Payment for ${subName} ${payment.decisionStatus === 'Approved' ? 'approved' : 'rejected'}`,
      body: payment.decisionNote || undefined,
      url: '/financial/sub-payments-due',
    }),
    buildStepNotification: (payment) => ({
      type: 'RequestStatus',
      title: `A payment for ${subName} needs your approval`,
      body: `SAR ${payment.amount} recorded as paid.`,
      url: '/financial/sub-payments-review',
    }),
    notifyFinal: (payment, notification) => notifyUser(payment.recordedBy.toString(), notification),
    onApproved: async (payment) => {
      const audience = await subcontractorPaymentAudience(payment.subcontractor);
      for (const userId of audience) {
        if (userId === payment.recordedBy.toString()) continue;
        await notifyUser(userId, {
          type: 'RequestStatus',
          title: `A payment for ${subName} was approved`,
          body: `SAR ${payment.amount} now credited against outstanding invoices.`,
          url: '/financial/sub-payments-due',
        });
      }
    },
  });
}

/**
 * Client payment ledger — bulk, client-level payment tracking on top of
 * Deployment.monthlyHours' per-worker invoices (2026-09-27, the user's own
 * correction: "a client doesn't pay per worker, they pay one amount for
 * everyone that month"). See clientPayment.model.js's own doc comment for
 * why nothing beyond the raw payment amounts is ever stored.
 *
 * Deliberately knows NOTHING about Deployment/Mobilisation/how an invoiced
 * amount is computed — `allocateClientPayments` below is pure ledger math,
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
import Client from '../clients/client.model.js';
import ClientPayment from './clientPayment.model.js';
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
 * client, plus whoever holds 'mobilisationsViewer' write (this company's
 * real MM) — the same broad-visibility audience sendInvoice's own
 * paymentTrackingAudience(mobilisationId) already uses, just widened from
 * one mobilisation to every mobilisation this client has.
 */
async function clientPaymentAudience(clientId) {
  const [deployments, mmSettings] = await Promise.all([
    Deployment.find({ client: clientId, archived: { $ne: true } })
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
 * Pure ledger math: given every invoiced-but-outstanding item for a client
 * (each `{ ...whateverTheCallerWants, revenue, invoiceSentAt }`, from
 * deployment.service.js, which is the only place that knows how to price
 * one), decide how much of each has actually been paid — oldest invoice
 * first — against this client's own Approved payments. Recomputed live on
 * every call, never cached, same discipline
 * computeMonthlyRevenueAndExpenses itself already follows. Whatever's left
 * in the pool once every item is fully covered is an implicit credit
 * balance — needs no field of its own, since the next call that includes a
 * newer invoice will simply see a bigger pool.
 */
export async function allocateClientPayments(clientId, invoicedItems) {
  const sorted = [...invoicedItems].sort((a, b) => new Date(a.invoiceSentAt) - new Date(b.invoiceSentAt));

  const approvedPayments = await ClientPayment.find({ client: clientId, decisionStatus: 'Approved' })
    .select('amount')
    .lean();
  let pool = money(approvedPayments.reduce((sum, p) => sum + p.amount, 0));

  const perEntry = [];
  for (const item of sorted) {
    const allocated = money(Math.min(pool, item.revenue));
    pool = money(pool - allocated);
    const balanceDue = money(item.revenue - allocated);
    perEntry.push({ ...item, amountAllocated: allocated, balanceDue, fullyPaid: balanceDue <= 0 });
  }

  return { perEntry, creditBalance: pool };
}

/** One client's real payment history — Pending/Approved/Rejected, newest
 *  first — for the Payments Due page's drill-down. */
export async function getClientPaymentHistory(clientId) {
  return ClientPayment.find({ client: clientId })
    .sort({ recordedAt: -1 })
    .populate('recordedBy', 'name')
    .populate('decidedBy', 'name')
    .lean();
}

/** One flat list of all Pending payments across all clients — for the manager's review queue. */
export async function getPendingPaymentsQueue(actor) {
  const allowed = await canAccessSection('deploymentsPaymentDecide', actor);
  if (!allowed && actor.role !== 'Admin') {
    throw new ApiError(403, 'You do not have permission to view the payments approval queue.');
  }
  return ClientPayment.find({ decisionStatus: 'Pending' })
    .sort({ recordedAt: 1 })
    .populate('client', 'companyName')
    .populate('recordedBy', 'name')
    .lean();
}

/**
 * Office Secretary (or 'deploymentsHours' write) records what the client
 * actually paid, in bulk, this time — sits Pending until the Financial
 * Manager decides it. Recording does NOT itself allocate anything (see
 * allocateClientPayments's own doc comment); only an Approved payment ever
 * counts toward it.
 */
export async function recordClientPayment(clientId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to record a received payment.');

  const client = await Client.findById(clientId).select('companyName').lean();
  if (!client) throw new ApiError(404, 'Client not found.');

  const payment = await ClientPayment.create({
    client: clientId,
    amount: data.amount,
    paymentReference: data.paymentReference || null,
    ...(data.paymentDate && { paymentDate: data.paymentDate }),
    recordedBy: actor.userId,
  });

  await logAudit({
    user: actor.userId,
    action: 'clientPayment.record',
    targetType: 'ClientPayment',
    targetId: payment._id,
    meta: { client: clientId, amount: data.amount },
    ip: actor.ip,
  });

  const deciders = await decidersOfDeploymentsPayment();
  for (const userId of deciders) {
    await notifyUser(userId, {
      type: 'RequestStatus',
      title: `A payment for ${client.companyName} needs your approval`,
      body: `SAR ${data.amount} recorded as received.`,
      url: '/financial/payments-due',
    });
  }
  return payment.toObject();
}

/**
 * Financial-Manager sign-off. Approving is the ONLY thing that makes a
 * payment count in allocateClientPayments — no separate "apply" step,
 * nothing else to keep in sync. Rejecting simply leaves it out forever.
 */
export async function decideClientPayment(paymentId, data, actor) {
  const allowed = await canAccessSection('deploymentsPaymentDecide', actor);
  if (!allowed) throw new ApiError(403, 'You do not have permission to approve a received payment.');

  const payment = await ClientPayment.findById(paymentId);
  if (!payment) throw new ApiError(404, 'Payment not found.');
  if (payment.decisionStatus !== 'Pending') throw new ApiError(400, 'Only a pending payment can be decided.');

  const client = await Client.findById(payment.client).select('companyName').lean();

  payment.decisionStatus = data.decision;
  payment.decidedBy = actor.userId;
  payment.decidedAt = new Date();
  payment.decisionNote = data.note || null;
  await payment.save();

  await logAudit({
    user: actor.userId,
    action: 'clientPayment.decide',
    targetType: 'ClientPayment',
    targetId: payment._id,
    meta: { client: payment.client, decision: data.decision, amount: payment.amount },
    ip: actor.ip,
  });

  await notifyUser(payment.recordedBy.toString(), {
    type: 'RequestStatus',
    title:
      data.decision === 'Approved'
        ? `Payment for ${client?.companyName ?? 'a client'} approved`
        : `Payment for ${client?.companyName ?? 'a client'} rejected`,
    body: data.note || undefined,
    url: '/financial/payments-due',
  });

  if (data.decision === 'Approved') {
    const audience = await clientPaymentAudience(payment.client);
    for (const userId of audience) {
      if (userId === payment.recordedBy.toString()) continue;
      await notifyUser(userId, {
        type: 'RequestStatus',
        title: `A payment for ${client?.companyName ?? 'a client'} was approved`,
        body: `SAR ${payment.amount} now credited against outstanding invoices.`,
        url: '/financial/payments-due',
      });
    }
  }

  return payment.toObject();
}

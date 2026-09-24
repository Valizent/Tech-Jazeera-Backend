/**
 * Salary advance service — submit/decide/repay. Money is always rounded and
 * server-computed, same discipline as quotation totals.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import SalaryAdvance from './advance.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The ORIGINAL decide-route role gate for a SalaryAdvance — preserved
 *  exactly as the authorization used whenever no ApprovalWorkflow governs a
 *  request (see approvalEngine.service.js's legacy path). */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR'];

/** Shared by submitAdvance (notifySubmission) and decideAdvance
 *  (buildStepNotification) so the text can't drift between them. */
function buildAdvanceStepNotification() {
  return {
    type: 'RequestStatus',
    title: 'A salary advance request needs your approval',
    url: '/financial-requests',
  };
}

/** The one real formula for "how much of this advance is still owed" —
 *  exported (2026-09-24) so payroll.service.js's payroll-deduction
 *  suggestion reuses it instead of re-deriving the same math a second time. */
export function computeOutstanding(advance) {
  const amountRepaid = money(advance.repayments.reduce((sum, r) => sum + r.amount, 0));
  return money(advance.amount - amountRepaid);
}

/** Adds the derived repayment figures every caller needs — never stored,
 *  always computed fresh from the repayments ledger so it can't drift. */
function withBalance(advance) {
  const amountRepaid = money(advance.repayments.reduce((sum, r) => sum + r.amount, 0));
  return { ...advance, amountRepaid, outstandingBalance: computeOutstanding(advance) };
}

export async function submitAdvance(employeeId, data, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  const active = await SalaryAdvance.findOne({
    employee: employeeId,
    status: { $in: ['Pending', 'Approved'] },
  }).lean();
  if (active) {
    throw new ApiError(409, 'You already have an advance request in progress — it must be decided and repaid before requesting another.');
  }

  // Unlike Leave, every advance request needs a real decision (no
  // auto-approval concept here) — so the workflow, if any, is resolved
  // unconditionally at submission, not gated on a particular status.
  let workflowFields = {};
  const workflow = await resolveApprovalWorkflow(employee, 'SalaryAdvance');
  if (workflow) {
    workflowFields = { workflow: workflow._id, workflowName: workflow.name, steps: workflow.steps, currentStep: 0 };
  }

  const advance = await SalaryAdvance.create({ employee: employeeId, ...data, ...workflowFields });
  await logAudit({
    user: actor.userId,
    action: 'advance.submit',
    targetType: 'SalaryAdvance',
    targetId: advance._id,
    meta: { employeeId: employee.employeeId, amount: data.amount },
    ip: actor.ip,
  });
  const plain = advance.toObject();
  await notifySubmission(plain, buildAdvanceStepNotification, LEGACY_DECIDE_ROLES);
  return withBalance(plain);
}

export async function listOwnAdvances(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    SalaryAdvance.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SalaryAdvance.countDocuments(filter),
  ]);
  return { items: items.map(withBalance), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function cancelAdvance(employeeId, id, actor) {
  const advance = await SalaryAdvance.findById(id);
  if (!advance) throw new ApiError(404, 'Advance request not found.');
  if (advance.employee.toString() !== employeeId) {
    throw new ApiError(403, 'You can only cancel your own advance requests.');
  }
  if (advance.status !== 'Pending') throw new ApiError(400, 'Only a pending request can be cancelled.');

  advance.status = 'Cancelled';
  await advance.save();
  await logAudit({
    user: actor.userId,
    action: 'advance.cancel',
    targetType: 'SalaryAdvance',
    targetId: advance._id,
    ip: actor.ip,
  });
  return withBalance(advance.toObject());
}

/**
 * Staff review queue. Coordinator is NOT part of the financial-requests
 * review circle (unlike Leave) — the ORIGINAL design here already excluded
 * them from deciding/handling money. Now that Coordinators can self-submit
 * (P2-M4+), they may see this list too, but scoped to ONLY their own
 * requests — never the company-wide view the original 4 reviewer roles get.
 */
export async function listAdvances({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;

  if (actor?.role === 'Coordinator') {
    if (employee && employee !== actor.employee) {
      throw new ApiError(403, 'You do not have access to this employee.');
    }
    filter.employee = actor.employee;
  }

  const [rawItems, total] = await Promise.all([
    SalaryAdvance.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    SalaryAdvance.countDocuments(filter),
  ]);
  let items = rawItems;
  if (actor) {
    items = await annotateCanDecide(rawItems, actor, { pendingStatus: 'Pending', legacyAllowedRoles: LEGACY_DECIDE_ROLES });
    // The route's real gate (financialRequests.routes.js's canDecideFinancialRequests)
    // requires Section Access write for EVERY decide, workflow-governed or
    // not — annotateCanDecide only knows about ApprovalRole/legacy-role
    // membership, so its hint could say "yes" for a legacy-role match (e.g.
    // Manager) even after an Admin narrows the real 'financialRequests'
    // grant to exclude them (2026-09-14, a real QA-audit-found gap: the
    // Approve/Reject buttons rendered for someone whose click would 403).
    const hasSectionWrite = await canAccessSection('financialRequests', actor, 'write');
    items = items.map((item) => ({ ...item, canDecideCurrentStep: item.canDecideCurrentStep && hasSectionWrite }));
  }
  return { items: items.map(withBalance), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function decideAdvance(id, { status, decisionNote }, actor) {
  const advance = await decideApprovalStep({
    Model: SalaryAdvance,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'Pending',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    notFoundMessage: 'Advance request not found.',
    auditAction: 'advance',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `Salary advance ${doc.status.toLowerCase()}`,
      body: doc.decisionNote || undefined,
      url: (role) => (role === 'Worker' ? '/me/requests' : '/financial-requests'),
    }),
    buildStepNotification: buildAdvanceStepNotification,
  });
  return withBalance(advance);
}

export async function addRepayment(id, data, actor) {
  const advance = await SalaryAdvance.findById(id).lean();
  if (!advance) throw new ApiError(404, 'Advance request not found.');
  if (advance.status !== 'Approved') {
    throw new ApiError(400, 'Repayments can only be recorded against an approved advance.');
  }
  const alreadyRepaid = money(advance.repayments.reduce((sum, r) => sum + r.amount, 0));
  const outstanding = money(advance.amount - alreadyRepaid);
  if (data.amount > outstanding) {
    throw new ApiError(400, `That exceeds the outstanding balance (SAR ${outstanding}).`);
  }

  // Atomic update, not read-then-save (fixed 2026-09-14, a real QA-audit-
  // found race — F1, same class as invoice.service.js's recordPayment): two
  // concurrent repayments could both pass the plain-JS check above against
  // the same stale read, then both save, over-repaying the advance. `$expr`
  // re-sums the CURRENT `repayments` array live in the filter, so it's
  // checked atomically against the real total at write time, not a value
  // read moments earlier. Both sides are rounded to 2dp (fixed 2026-09-15,
  // a real QA-audit-found bug — F5): raw IEEE-754 addition can land a cent
  // or two off zero (1.10 + 0.10 = 1.2000000000000002 in JS/BSON double
  // math), so an exact `$lte` against the unrounded sum could reject a
  // legitimate final repayment that pays the balance down to exactly zero.
  // `$literal` around the appended repayment (fixed 2026-09-15, a real
  // QA-audit-found injection — S1, same class as invoice.service.js's
  // recordPayment): this is a PIPELINE update, so every value in it is
  // otherwise evaluated as an aggregation expression — a validated-as-a-
  // string `note` like "$reason" was silently resolved against the CURRENT
  // document instead of stored as the literal text the user typed.
  // `recordedBy` is also explicitly cast to ObjectId — a pipeline update
  // bypasses Mongoose's normal schema-driven casting entirely.
  const updated = await SalaryAdvance.findOneAndUpdate(
    {
      _id: id,
      status: 'Approved',
      $expr: {
        $lte: [
          { $round: [{ $add: [{ $sum: '$repayments.amount' }, data.amount] }, 2] },
          { $round: ['$amount', 2] },
        ],
      },
    },
    [
      {
        $set: {
          repayments: {
            $concatArrays: [
              '$repayments',
              [{ $literal: { ...data, recordedBy: new mongoose.Types.ObjectId(actor.userId) } }],
            ],
          },
        },
      },
      {
        $set: {
          status: {
            $cond: [
              { $eq: [{ $round: [{ $sum: '$repayments.amount' }, 2] }, { $round: ['$amount', 2] }] },
              'Closed',
              '$status',
            ],
          },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    const fresh = await SalaryAdvance.findById(id).lean();
    if (!fresh) throw new ApiError(404, 'Advance request not found.');
    if (fresh.status !== 'Approved') {
      throw new ApiError(400, 'Repayments can only be recorded against an approved advance.');
    }
    const freshOutstanding = money(fresh.amount - fresh.repayments.reduce((sum, r) => sum + r.amount, 0));
    throw new ApiError(400, `That exceeds the outstanding balance (SAR ${freshOutstanding}).`);
  }

  const newOutstanding = money(updated.amount - updated.repayments.reduce((sum, r) => sum + r.amount, 0));
  await logAudit({
    user: actor.userId,
    action: 'advance.repayment.add',
    targetType: 'SalaryAdvance',
    targetId: updated._id,
    meta: { amount: data.amount, newOutstanding },
    ip: actor.ip,
  });
  return withBalance(updated.toObject());
}

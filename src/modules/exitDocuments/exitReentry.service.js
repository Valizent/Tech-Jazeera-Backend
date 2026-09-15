/**
 * Exit Re-Entry visa request service — submit/decide/mark-issued.
 * Submit/decide now run through the same Configurable Approval Hierarchy
 * engine as Leave/Timesheet/SalaryAdvance/Reimbursement — see
 * approvals/approvalEngine.service.js; `mark-issued` stays a separate,
 * un-workflowed HR/compliance step regardless (see exitReentry.model.js).
 */
import Employee from '../employees/employee.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import ExitReentryRequest from './exitReentry.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';

/** The ORIGINAL decide-route role gate — preserved exactly as the
 *  authorization used whenever no ApprovalWorkflow governs a request. */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR'];

/** Shared by submitExitReentry (notifySubmission) and decideExitReentry
 *  (buildStepNotification) so the text can never drift between steps. */
function buildExitReentryStepNotification(doc, stepIndex) {
  return {
    type: 'RequestStatus',
    title: 'An exit re-entry visa request needs your approval',
    body: doc.steps?.[stepIndex]?.label ? `Step: ${doc.steps[stepIndex].label}` : undefined,
    url: '/exit-documents',
  };
}

async function assertOwnsLeaveRequest(employeeId, leaveRequestId) {
  if (!leaveRequestId) return;
  const leave = await LeaveRequest.findById(leaveRequestId).select('employee').lean();
  if (!leave || leave.employee.toString() !== employeeId) {
    throw new ApiError(400, 'That leave request does not belong to this employee.');
  }
}

export async function submitExitReentry(employeeId, data, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  await assertOwnsLeaveRequest(employeeId, data.linkedLeaveRequest);

  const workflow = await resolveApprovalWorkflow(employee, 'ExitReentry');
  const workflowFields = workflow
    ? { workflow: workflow._id, workflowName: workflow.name, steps: workflow.steps, currentStep: 0 }
    : {};

  const request = await ExitReentryRequest.create({ employee: employeeId, ...data, ...workflowFields });
  await logAudit({
    user: actor.userId,
    action: 'exitReentry.submit',
    targetType: 'ExitReentryRequest',
    targetId: request._id,
    meta: { employeeId: employee.employeeId, visaType: data.visaType },
    ip: actor.ip,
  });
  const plain = request.toObject();
  await notifySubmission(plain, buildExitReentryStepNotification, LEGACY_DECIDE_ROLES);
  return plain;
}

export async function listOwnExitReentry(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    ExitReentryRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ExitReentryRequest.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function cancelExitReentry(employeeId, id, actor) {
  const request = await ExitReentryRequest.findById(id);
  if (!request) throw new ApiError(404, 'Exit re-entry request not found.');
  if (request.employee.toString() !== employeeId) {
    throw new ApiError(403, 'You can only cancel your own requests.');
  }
  if (request.status !== 'Pending') throw new ApiError(400, 'Only a pending request can be cancelled.');

  request.status = 'Cancelled';
  await request.save();
  await logAudit({
    user: actor.userId,
    action: 'exitReentry.cancel',
    targetType: 'ExitReentryRequest',
    targetId: request._id,
    ip: actor.ip,
  });
  return request.toObject();
}

// Fixed 2026-09-15, a real QA-audit-found gap — A2's sibling case
// (certificate.service.js's own equivalent fix has the full reasoning):
// this module had no Coordinator team-scoping anywhere either.
export async function listExitReentry({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;
  if (actor?.role === 'Coordinator') {
    if (employee) {
      await assertEmployeeVisibleToActor(employee, actor);
    } else {
      const teamIds = await Employee.find({ coordinator: actor.userId }).distinct('_id');
      filter.employee = { $in: teamIds };
    }
  }
  const [rawItems, total] = await Promise.all([
    ExitReentryRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('decidedBy', 'name')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    ExitReentryRequest.countDocuments(filter),
  ]);
  // Real, server-computed "can this viewer decide it" per row — see
  // approvalEngine.service.js. Convenience for the UI only; decideExitReentry
  // remains the actual gate.
  const items = await annotateCanDecide(rawItems, actor, {
    pendingStatus: 'Pending',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
  });
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Delegates the actual step/authorization logic to the shared engine: a
 * request with no `workflow` runs the exact original single-level flow
 * (LEGACY_DECIDE_ROLES, unchanged); one WITH a workflow is decided
 * step-by-step against real ApprovalRole membership instead.
 */
export async function decideExitReentry(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: ExitReentryRequest,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'Pending',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    assertScope: assertEmployeeVisibleToActor,
    notFoundMessage: 'Exit re-entry request not found.',
    auditAction: 'exitReentry',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `Exit re-entry visa request ${doc.status.toLowerCase()}`,
      body: doc.decisionNote || undefined,
      url: (role) => (role === 'Worker' || role === 'Staff' ? '/me/exit-documents' : '/exit-documents'),
    }),
    buildStepNotification: buildExitReentryStepNotification,
  });
}

/** HR records that the visa was actually processed with Jawazat/Muqeem. */
export async function markExitReentryIssued(id, { visaReferenceNumber }, actor) {
  const request = await ExitReentryRequest.findById(id);
  if (!request) throw new ApiError(404, 'Exit re-entry request not found.');
  if (request.status !== 'Approved') throw new ApiError(400, 'Only an approved request can be marked issued.');

  request.status = 'Issued';
  request.issuedAt = new Date();
  request.issuedBy = actor.userId;
  request.visaReferenceNumber = visaReferenceNumber;
  await request.save();
  await logAudit({
    user: actor.userId,
    action: 'exitReentry.issued',
    targetType: 'ExitReentryRequest',
    targetId: request._id,
    meta: { visaReferenceNumber },
    ip: actor.ip,
  });
  return request.toObject();
}

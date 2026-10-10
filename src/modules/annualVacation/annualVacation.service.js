/**
 * Annual Vacation service — submit / list / cancel / decide.
 *
 * Replaces the half-built endpoint that used to live in financialRequests
 * (2026-10-10): it accepted a request but had no review queue, no decision
 * step, no screen, and its ownership check compared fields that don't exist
 * (QA audit V2-S01/F09). Submit and decide now run through the same
 * Configurable Approval Hierarchy engine as Leave and Exit Re-Entry
 * (approvals/approvalEngine.service.js); final approval also creates the
 * matching approved LeaveRequest so the employee shows as on leave.
 *
 * Who may file:
 *   - an employee for themself (ESS `/api/me`, or a staff login with a linked
 *     employee) — `submitOwnAnnualVacation`, no grant needed;
 *   - HR/staff for someone else — `submitAnnualVacationFor`, needs Write on
 *     the 'annualVacation' Section Access key plus the Coordinator team scope.
 */
import Employee from '../employees/employee.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import LeaveType from '../leave/leaveType.model.js';
import AnnualVacationRequest from './annualVacation.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

/** The ORIGINAL decide-route role gate, used whenever no ApprovalWorkflow governs a request. */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR'];

/** The leave type the approved vacation is recorded under (created on first use). */
export const ANNUAL_VACATION_LEAVE_TYPE = 'Annual Vacation';

const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the calendar day `date` falls on — the day granularity Leave counts in. */
function utcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Shared by submit (notifySubmission) and decide (buildStepNotification) so the text can't drift. */
function buildStepNotification(doc, stepIndex) {
  return {
    type: 'RequestStatus',
    title: 'An annual vacation request needs your approval',
    body: doc.steps?.[stepIndex]?.label ? `Step: ${doc.steps[stepIndex].label}` : undefined,
    url: '/annual-vacation',
  };
}

/**
 * An employee may take annual vacation once a contract period has ended: the
 * recorded contract end date has passed, or the contract was renewed (the
 * current contract started well after joining, so the first one is over).
 */
function assertEligible(employee) {
  if (employee.status === 'Exited') throw new ApiError(400, 'This employee has exited the company.');
  if (!employee.contractEndDate) {
    throw new ApiError(400, 'Contract end date is not set on this employee. Please contact HR.');
  }
  if (new Date() >= new Date(employee.contractEndDate)) return;
  if (employee.contractStartDate && employee.joiningDate) {
    const gapDays = (new Date(employee.contractStartDate) - new Date(employee.joiningDate)) / MS_PER_DAY;
    if (gapDays > 30) return;
  }
  throw new ApiError(400, 'Annual vacation can only be requested after a contract period has ended.');
}

async function createRequest(employeeId, { startDate, requestedDays, reason }, actor, onBehalf) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  assertEligible(employee);

  const start = utcDay(startDate);
  if (start < utcDay(new Date())) throw new ApiError(400, 'The vacation cannot start in the past.');
  const end = new Date(start.getTime() + (requestedDays - 1) * MS_PER_DAY);

  const open = await AnnualVacationRequest.exists({ employee: employee._id, status: 'PendingReview' });
  if (open) throw new ApiError(409, 'There is already an annual vacation request waiting for review.');
  await assertNoOverlap(employee._id, start, end);

  const workflow = await resolveApprovalWorkflow(employee, 'AnnualVacation');
  const workflowFields = workflow
    ? { workflow: workflow._id, workflowName: workflow.name, steps: workflow.steps, currentStep: 0 }
    : {};

  const request = await AnnualVacationRequest.create({
    employee: employee._id,
    submittedBy: actor.userId,
    startDate: start,
    endDate: end,
    requestedDays,
    reason,
    ...workflowFields,
  });
  await logAudit({
    user: actor.userId,
    action: 'annualVacation.submit',
    targetType: 'AnnualVacationRequest',
    targetId: request._id,
    meta: { employeeId: employee.employeeId, requestedDays, onBehalf },
    ip: actor.ip,
  });
  const plain = request.toObject();
  await notifySubmission(
    plain,
    buildStepNotification,
    LEGACY_DECIDE_ROLES,
    employee.coordinator ? [employee.coordinator] : []
  );
  return plain;
}

/** No overlapping leave or another vacation (pending or approved) on those dates. */
async function assertNoOverlap(employeeId, start, end, excludeVacationId = null) {
  const overlapsLeave = await LeaveRequest.exists({
    employee: employeeId,
    status: { $in: ['AutoApproved', 'Approved', 'PendingReview'] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });
  if (overlapsLeave) throw new ApiError(409, 'A leave request already exists that overlaps these dates.');
  const overlapsVacation = await AnnualVacationRequest.exists({
    employee: employeeId,
    ...(excludeVacationId && { _id: { $ne: excludeVacationId } }),
    status: { $in: ['PendingReview', 'Approved'] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });
  if (overlapsVacation) throw new ApiError(409, 'An annual vacation request already covers these dates.');
}

/** An employee (or a staff login) filing their OWN request — ownership is the caller's. */
export async function submitOwnAnnualVacation(employeeId, data, actor) {
  return createRequest(employeeId, data, actor, false);
}

/** HR/staff filing on someone else's behalf: needs Write on the section and team scope. */
export async function submitAnnualVacationFor(employeeId, data, actor) {
  if (!(await canAccessSection('annualVacation', actor, 'write'))) {
    throw new ApiError(403, 'You do not have permission to file an annual vacation for someone else.');
  }
  await assertEmployeeVisibleToActor(employeeId, actor);
  return createRequest(employeeId, data, actor, true);
}

export async function listOwnAnnualVacation(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    AnnualVacationRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AnnualVacationRequest.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function cancelAnnualVacation(employeeId, id, actor) {
  const request = await AnnualVacationRequest.findOneAndUpdate(
    { _id: id, employee: employeeId, status: 'PendingReview' },
    { $set: { status: 'Cancelled' } },
    { new: true }
  ).lean();
  if (!request) {
    const exists = await AnnualVacationRequest.findById(id).select('employee status').lean();
    if (!exists) throw new ApiError(404, 'Annual vacation request not found.');
    if (String(exists.employee) !== String(employeeId)) throw new ApiError(403, 'You can only cancel your own requests.');
    throw new ApiError(400, 'Only a pending request can be cancelled.');
  }
  await logAudit({
    user: actor.userId,
    action: 'annualVacation.cancel',
    targetType: 'AnnualVacationRequest',
    targetId: request._id,
    ip: actor.ip,
  });
  return request;
}

/** The staff review queue, scoped to a Coordinator's own team. */
export async function listAnnualVacation({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;
  if (actor.role === 'Coordinator') {
    if (employee) {
      await assertEmployeeVisibleToActor(employee, actor);
    } else {
      const teamIds = await Employee.find({ coordinator: actor.userId }).distinct('_id');
      filter.employee = { $in: teamIds };
    }
  }
  const [rawItems, total] = await Promise.all([
    AnnualVacationRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('decidedBy', 'name')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    AnnualVacationRequest.countDocuments(filter),
  ]);
  const annotated = await annotateCanDecide(rawItems, actor, {
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
  });
  // The route already requires Read; deciding additionally needs Write, so a
  // read-only viewer in a workflow step never sees Approve/Reject buttons.
  const hasWrite = await canAccessSection('annualVacation', actor, 'write');
  const items = annotated.map((item) => ({ ...item, canDecideCurrentStep: item.canDecideCurrentStep && hasWrite }));
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Find (or create on first use) the leave type approved vacations are recorded under. */
async function ensureLeaveType() {
  const existing = await LeaveType.findOne({ name: ANNUAL_VACATION_LEAVE_TYPE });
  if (existing) return existing;
  try {
    return await LeaveType.create({ name: ANNUAL_VACATION_LEAVE_TYPE, recurrence: 'Manual', isPaid: true });
  } catch (err) {
    if (err?.code === 11000) return LeaveType.findOne({ name: ANNUAL_VACATION_LEAVE_TYPE });
    throw err;
  }
}

/**
 * Final approval: record the vacation as an approved leave. Runs inside the
 * engine BEFORE the requester is told "approved". If it fails (typically the
 * employee filed other leave over the same dates in the meantime), the
 * approval is reverted so a reviewer can decide again — same compensation
 * as Mobilisation's deployment creation.
 */
async function recordApprovedLeave(vacation) {
  try {
    await assertNoOverlap(vacation.employee, vacation.startDate, vacation.endDate, vacation._id);
    const leaveType = await ensureLeaveType();
    const leave = await LeaveRequest.create({
      employee: vacation.employee,
      leaveType: leaveType._id,
      leaveTypeName: leaveType.name,
      startDate: vacation.startDate,
      endDate: vacation.endDate,
      days: vacation.requestedDays,
      reason: vacation.reason,
      status: 'Approved',
      eligibility: { ruleApplied: 'Annual vacation approved through the annual vacation request.' },
      decidedBy: vacation.decidedBy,
      decidedAt: vacation.decidedAt,
    });
    await AnnualVacationRequest.updateOne({ _id: vacation._id }, { $set: { linkedLeaveRequest: leave._id } });
  } catch (err) {
    await AnnualVacationRequest.updateOne(
      { _id: vacation._id, status: 'Approved' },
      {
        $set: { status: 'PendingReview', currentStep: vacation.currentStep ?? 0 },
        $pop: { approvalTrail: 1 },
        $unset: { decidedBy: '', decidedAt: '', decisionNote: '' },
      }
    );
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, 'Approval could not be completed because recording the leave failed. It was reverted, please try again.');
  }
}

export async function decideAnnualVacation(id, { status, decisionNote }, actor) {
  if (!(await canAccessSection('annualVacation', actor, 'write'))) {
    throw new ApiError(403, 'You do not have permission to decide annual vacation requests.');
  }
  return decideApprovalStep({
    Model: AnnualVacationRequest,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    assertScope: assertEmployeeVisibleToActor,
    notFoundMessage: 'Annual vacation request not found.',
    auditAction: 'annualVacation',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `Annual vacation request ${doc.status.toLowerCase()}`,
      body: doc.decisionNote || undefined,
      url: (role) => (role === 'Worker' || role === 'Staff' ? '/me/annual-vacation' : '/annual-vacation'),
    }),
    buildStepNotification,
    onApproved: recordApprovedLeave,
  });
}

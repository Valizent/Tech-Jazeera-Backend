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
import logger from '../../config/logger.js';
import { logAudit } from '../audit/audit.service.js';
import ExitReentryRequest from '../exitDocuments/exitReentry.model.js';
import { resolveApprovalWorkflow, resolveHrRole } from '../approvals/approvals.service.js';
import {
  decideApprovalStep,
  annotateCanDecide,
  assignStepApprovers,
  withApprovalTrail,
  notifySubmission,
  resolveStepAuthority,
  membersOfRoles,
} from '../approvals/approvalEngine.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import { notifyUser, notifyEmployeeUser } from '../notifications/notification.service.js';
import { signedDownloadUrl } from '../../middleware/upload.js';
import { addRestrictedStoredDocument } from '../documents/document.service.js';

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
  const step = doc.steps?.[stepIndex];
  return {
    type: 'RequestStatus',
    title: 'An annual vacation request needs your approval',
    body: step?.label ? `Step: ${step.label}` : undefined,
    url: '/annual-vacation',
  };
}

const fmtDay = (date) => {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Tells the roles the workflow lists as "informed" (2026-10-14: the Marketing Manager for an annual vacation, the
 * Financial Manager for someone in Accounts): when the request is submitted, and again when it is approved. They
 * are told, they are not asked. Best effort: it never fails the request itself.
 */
async function notifyInformed(doc, event) {
  try {
    if (!doc.informRoles?.length) return;
    const employee = await Employee.findById(doc.employee).select('fullName').lean();
    const name = employee?.fullName ?? 'An employee';
    const span = `from ${fmtDay(doc.startDate)} to ${fmtDay(doc.endDate)}`;
    const notification =
      event === 'approved'
        ? { type: 'RequestStatus', title: `${name} is going on annual leave`, body: `${name} will be on annual leave ${span} (${doc.requestedDays} days).`, url: '/annual-vacation' }
        : { type: 'RequestStatus', title: `${name} has requested annual vacation`, body: `${name} asked for annual vacation ${span} (${doc.requestedDays} days).`, url: '/annual-vacation' };
    const userIds = await membersOfRoles(doc.informRoles);
    await Promise.allSettled(userIds.map((userId) => notifyUser(userId, notification)));
  } catch (err) {
    logger.error(`[annualVacation] informing roles failed: ${err.message}`);
  }
}

/**
 * The contract period the next vacation follows (2026-10-14, the user's rule). A request may be filed at any
 * time, but its first day must come after that period's end date: the contract end date, or, when the contract
 * was renewed before it ended, the END THE RENEWAL REPLACED (`previousContractEndDate`, kept by the server), so
 * a renewal never costs the vacation. Records renewed before this field existed fall back to the old
 * "current contract started well after joining" reading (the vacation may start any time). One approved
 * vacation per period: it opens again when HR renews the contract.
 */
async function vacationCycle(employee) {
  if (employee.status === 'Exited') throw new ApiError(400, 'This employee has exited the company.');
  if (!employee.contractEndDate) {
    throw new ApiError(400, 'Contract end date is not set on this employee. Please contact HR.');
  }
  let anchor = employee.previousContractEndDate ?? employee.contractEndDate;
  if (!employee.previousContractEndDate && employee.contractStartDate && employee.joiningDate) {
    const gapDays = (new Date(employee.contractStartDate) - new Date(employee.joiningDate)) / MS_PER_DAY;
    if (gapDays > 30 && !(await AnnualVacationRequest.exists({ employee: employee._id }))) anchor = employee.contractStartDate;
  }
  anchor = utcDay(anchor);
  const taken = await AnnualVacationRequest.exists({ employee: employee._id, periodEnd: anchor, status: 'Approved' });
  if (taken) {
    throw new ApiError(400, 'An annual vacation was already taken for this contract period. The next one opens when the contract is renewed.');
  }
  return { anchor, earliestStart: new Date(anchor.getTime() + MS_PER_DAY) };
}

/** Non-throwing form of the rule above, for the request form and the portal home. */
export async function vacationEligibility(employee) {
  const contractDays = employee.annualVacationDays ?? null;
  try {
    const { earliestStart } = await vacationCycle(employee);
    assertContractDays(employee);
    return { eligible: true, reason: null, contractDays, earliestStart };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { eligible: false, reason: error.message, contractDays, earliestStart: null };
  }
}

/** The number of days is the contract's, set by HR on the employee record. */
function assertContractDays(employee) {
  if (!(employee.annualVacationDays > 0)) {
    throw new ApiError(400, 'The annual vacation days from the contract are not set on this record yet. Please ask HR to set them.');
  }
}

async function createRequest(employeeId, { startDate, reason }, actor, onBehalf) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  const { anchor, earliestStart } = await vacationCycle(employee);
  assertContractDays(employee);
  const requestedDays = employee.annualVacationDays;

  const start = utcDay(startDate);
  if (start < utcDay(new Date())) throw new ApiError(400, 'The vacation cannot start in the past.');
  if (start < earliestStart) throw new ApiError(400, `The vacation can start only after the contract end date (${fmtDay(anchor)}).`);
  const end = new Date(start.getTime() + (requestedDays - 1) * MS_PER_DAY);

  const open = await AnnualVacationRequest.exists({ employee: employee._id, status: 'PendingReview' });
  if (open) throw new ApiError(409, 'There is already an annual vacation request waiting for review.');
  await assertNoOverlap(employee._id, start, end);

  const workflow = await resolveApprovalWorkflow(employee, 'AnnualVacation');
  const workflowFields = workflow
    ? {
        workflow: workflow._id,
        workflowName: workflow.name,
        steps: await assignStepApprovers(workflow.steps),
        currentStep: 0,
        currentStepEnteredAt: new Date(),
        informRoles: workflow.notifyRoles ?? [],
      }
    : {};

  const request = await AnnualVacationRequest.create({
    employee: employee._id,
    submittedBy: actor.userId,
    startDate: start,
    endDate: end,
    requestedDays,
    periodEnd: anchor,
    contractDays: employee.annualVacationDays,
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
  await notifyInformed(plain, 'submitted');
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

const VISA_SUMMARY_FIELDS = 'status visaReferenceNumber departureDate expectedReturnDate issuedAt visaFile.originalName';

/** A request as clients may see it: ticket names and sizes (never the storage id), and where the visa stands. */
function publicVacation(item) {
  const visa = item.visaRequest && typeof item.visaRequest === 'object' && item.visaRequest._id ? item.visaRequest : null;
  const { visaFile, ...visaRest } = visa ?? {};
  return {
    ...item,
    tickets: (item.tickets ?? []).map(({ _id, originalName, mimeType, size, uploadedAt, uploadedBy, step, stage }) => ({
      _id,
      originalName,
      mimeType,
      size,
      uploadedAt,
      step,
      stage,
      uploadedBy: uploadedBy && typeof uploadedBy === 'object' ? uploadedBy.name ?? null : null,
    })),
    visaRequest: visa ? { ...visaRest, hasFile: Boolean(visaFile?.originalName), fileName: visaFile?.originalName ?? null } : item.visaRequest ?? null,
  };
}

export async function listOwnAnnualVacation(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    withApprovalTrail(
      AnnualVacationRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('visaRequest', VISA_SUMMARY_FIELDS)
        .populate('tickets.uploadedBy', 'name')
    ).lean(),
    AnnualVacationRequest.countDocuments(filter),
  ]);
  return { items: items.map(publicVacation), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
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
      .populate('steps.assignee', 'name')
      .populate('tickets.uploadedBy', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .populate('visaRequest', VISA_SUMMARY_FIELDS)
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
  const hrId = await hrRoleId();
  const items = annotated.map((item) =>
    publicVacation({ ...item, canDecideCurrentStep: item.canDecideCurrentStep && hasWrite, canChangeDays: atHrStep(item, hrId) })
  );
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
    // A re-entry visa request raised by the retired travel step points at the approved leave.
    if (vacation.visaRequest) {
      await ExitReentryRequest.updateOne({ _id: vacation.visaRequest }, { $set: { linkedLeaveRequest: leave._id } });
    }
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
  await pushContractEnd(vacation);
  await copyAttachmentsToDocuments(vacation);
  // Only once the leave is really recorded: tell the roles the workflow lists (the Marketing Manager, or the
  // Financial Manager for an Accounts person) that this person is going on annual leave.
  await notifyInformed(vacation, 'approved');
}

/**
 * The documents attached while approving become the employee's own (restricted) documents once the vacation
 * is finally approved: only that employee and an Admin can open them from Documents. Best effort: the leave is
 * already recorded, and the files stay on the request either way.
 */
async function copyAttachmentsToDocuments(vacation) {
  try {
    const label = `Annual vacation ${fmtDay(vacation.startDate)} to ${fmtDay(vacation.endDate)}`;
    for (const file of vacation.tickets ?? []) {
      await addRestrictedStoredDocument({
        title: `${label}: ${file.originalName}`,
        owner: vacation.employee,
        stored: file,
        uploadedBy: file.uploadedBy ?? vacation.decidedBy,
        source: { kind: 'AnnualVacation', ref: vacation._id },
      });
    }
  } catch (err) {
    logger.error(`[annualVacation] copying documents to the employee failed: ${err.message}`);
  }
}

/**
 * The contract was renewed since this vacation was filed (its end date is no longer the period it follows), so
 * the time away does not count toward it: the renewed end date moves later by the days taken. A contract that
 * was not renewed changes nothing. Best effort: the leave is already recorded, so a failure here is logged,
 * never turned into a failed approval.
 */
async function pushContractEnd(vacation) {
  try {
    if (!vacation.periodEnd || vacation.contractPush?.to) return;
    const employee = await Employee.findById(vacation.employee).select('contractEndDate').lean();
    if (!employee?.contractEndDate) return;
    const current = utcDay(employee.contractEndDate);
    if (current.getTime() === utcDay(vacation.periodEnd).getTime()) return;
    const to = new Date(current.getTime() + vacation.requestedDays * MS_PER_DAY);
    await Employee.updateOne({ _id: vacation.employee }, { $set: { contractEndDate: to } });
    await AnnualVacationRequest.updateOne({ _id: vacation._id }, { $set: { contractPush: { from: current, to } } });
    await logAudit({
      user: vacation.decidedBy,
      action: 'annualVacation.contractPush',
      targetType: 'Employee',
      targetId: vacation.employee,
      meta: { vacationId: String(vacation._id), days: vacation.requestedDays, from: current, to },
    });
  } catch (err) {
    logger.error(`[annualVacation] moving the contract end date failed: ${err.message}`);
  }
}

/** The most documents one request may carry (each upload is also capped per file by the upload middleware). */
const MAX_ATTACHMENTS = 20;

const asStored = (file) => ({
  fileName: file.filename,
  resourceType: 'raw',
  originalName: file.originalname,
  mimeType: file.mimetype,
  size: file.size,
});

/**
 * Approve or reject. While approving, the approver may attach documents (air tickets and the like): they are
 * kept on the request for everyone in the chain and copied to the employee's restricted documents on final
 * approval. The remark (`decisionNote`) goes into the approval trail and is shown with the stage.
 * Files are stored before the decision runs, so the final approval sees them; if the decision then fails they
 * are taken off again.
 */
export async function decideAnnualVacation(id, { status, decisionNote }, actor, files = []) {
  if (!(await canAccessSection('annualVacation', actor, 'write'))) {
    throw new ApiError(403, 'You do not have permission to decide annual vacation requests.');
  }
  if (!files?.length) return runDecision(id, status, decisionNote, actor);
  if (status !== 'Approved') throw new ApiError(400, 'Documents can only be attached when approving.');

  const doc = await AnnualVacationRequest.findById(id).lean();
  if (!doc) throw new ApiError(404, 'Annual vacation request not found.');
  if (doc.status !== 'PendingReview') throw new ApiError(409, 'This request is no longer waiting for review.');
  // Authorised first, so a person who may not decide it never gets anything stored.
  const step = doc.workflow ? doc.steps?.[doc.currentStep] : null;
  if (step) {
    const { authorized } = await resolveStepAuthority(actor, step.roles, step);
    if (!authorized) throw new ApiError(403, 'You are not an approver for the current step of this request.');
  } else {
    if (!LEGACY_DECIDE_ROLES.includes(actor.role)) throw new ApiError(403, 'You do not have permission to perform this action.');
    await assertEmployeeVisibleToActor(doc.employee, actor);
  }
  if ((doc.tickets?.length ?? 0) + files.length > MAX_ATTACHMENTS) {
    throw new ApiError(400, `A request can carry at most ${MAX_ATTACHMENTS} documents.`);
  }

  const stage = step?.label || null;
  const added = files.map((file) => ({
    ...asStored(file),
    uploadedBy: actor.userId,
    uploadedAt: new Date(),
    step: doc.currentStep ?? 0,
    stage,
  }));
  const pushed = await AnnualVacationRequest.updateOne(
    { _id: id, status: 'PendingReview', currentStep: doc.currentStep ?? 0 },
    { $push: { tickets: { $each: added } } }
  );
  if (!pushed.modifiedCount) throw new ApiError(409, 'This request was already decided by someone else.');

  try {
    return await runDecision(id, status, decisionNote, actor);
  } catch (err) {
    await AnnualVacationRequest.updateOne({ _id: id }, { $pull: { tickets: { fileName: { $in: added.map((a) => a.fileName) } } } });
    throw err;
  }
}

function runDecision(id, status, decisionNote, actor) {
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

// ---------------------------------------------------------------------------
// HR's days (2026-10-14)
// ---------------------------------------------------------------------------

/** The HR approval role (the step that holds it is the one that may change the days): the one chosen on the
 *  Approval Hierarchy page, else the role named HR; null when there is neither. */
async function hrRoleId() {
  const role = await resolveHrRole('_id');
  return role?._id ?? null;
}

/** Is the request's current step one the HR role sits in? Steps may be populated (`{ _id, name }`) or plain ids. */
function atHrStep(item, hrId) {
  if (!hrId || item.status !== 'PendingReview') return false;
  const step = item.workflow ? item.steps?.[item.currentStep] : null;
  return Boolean(step?.roles?.some((r) => String(r?._id ?? r) === String(hrId)));
}

/** The request at the HR step, and the actor really holds that step (or is Admin). */
async function loadAtHrStep(id, actor) {
  const doc = await AnnualVacationRequest.findById(id);
  if (!doc) throw new ApiError(404, 'Annual vacation request not found.');
  if (doc.status !== 'PendingReview') throw new ApiError(409, 'This request is no longer waiting for review.');
  if (!atHrStep(doc, await hrRoleId())) {
    throw new ApiError(409, 'The days can only be changed at the HR step.');
  }
  const step = doc.steps[doc.currentStep];
  const { authorized } = await resolveStepAuthority(actor, step.roles, step);
  if (!authorized) throw new ApiError(403, 'You are not an approver for the current step of this request.');
  await assertEmployeeVisibleToActor(doc.employee, actor);
  return doc;
}

/** HR changing the number of days for this one request, with the reason (usually what the employee asked in the notes). */
export async function changeVacationDays(id, { requestedDays, note }, actor) {
  const doc = await loadAtHrStep(id, actor);
  if (requestedDays === doc.requestedDays) throw new ApiError(400, 'The request already has that number of days.');
  const start = utcDay(doc.startDate);
  const end = new Date(start.getTime() + (requestedDays - 1) * MS_PER_DAY);
  await assertNoOverlap(doc.employee, start, end, doc._id);

  const from = doc.requestedDays;
  doc.requestedDays = requestedDays;
  doc.endDate = end;
  doc.daysChange = { from, to: requestedDays, note, by: actor.userId, at: new Date() };
  await doc.save();

  await logAudit({
    user: actor.userId,
    action: 'annualVacation.daysChanged',
    targetType: 'AnnualVacationRequest',
    targetId: doc._id,
    meta: { from, to: requestedDays, note },
    ip: actor.ip,
  });
  await notifyEmployeeUser(doc.employee, {
    type: 'RequestStatus',
    title: 'HR changed the days of your annual vacation',
    body: `From ${from} to ${requestedDays} days${note ? `: ${note}` : ''}.`,
    url: '/me/annual-vacation',
  }).catch(() => {});
  const item = await AnnualVacationRequest.findById(id).populate('visaRequest', VISA_SUMMARY_FIELDS).lean();
  return publicVacation(item);
}

// ---------------------------------------------------------------------------
// Reading the documents back (anyone who may see the request; the employee for their own)
// ---------------------------------------------------------------------------

async function loadVisibleVacation(id, viewer) {
  const doc = await AnnualVacationRequest.findById(id).lean();
  if (!doc) throw new ApiError(404, 'Annual vacation request not found.');
  if (viewer.ownEmployeeId) {
    if (String(doc.employee) !== String(viewer.ownEmployeeId)) throw new ApiError(403, 'You can only open your own documents.');
  } else if (!(viewer.actor.employee && String(doc.employee) === String(viewer.actor.employee))) {
    // Someone else's request: a reader of the section (read-only for the rest of management), team-scoped for a Coordinator.
    if (!(await canAccessSection('annualVacation', viewer.actor, 'read'))) {
      throw new ApiError(403, 'You do not have access to this request.');
    }
    await assertEmployeeVisibleToActor(doc.employee, viewer.actor);
  }
  return doc;
}

/** @param viewer {{actor}|{ownEmployeeId}} - a staff actor (team-scoped for a Coordinator) or the employee themselves. */
export async function getTicketFile(id, fileId, viewer) {
  const doc = await loadVisibleVacation(id, viewer);
  const ticket = (doc.tickets ?? []).find((t) => String(t._id) === String(fileId));
  if (!ticket) throw new ApiError(404, 'Ticket not found.');
  return { url: signedDownloadUrl(ticket.fileName, ticket.resourceType), mimeType: ticket.mimeType, originalName: ticket.originalName };
}

export async function getVisaFile(id, viewer) {
  const doc = await loadVisibleVacation(id, viewer);
  const visa = doc.visaRequest ? await ExitReentryRequest.findById(doc.visaRequest).select('visaFile').lean() : null;
  if (!visa?.visaFile?.fileName) throw new ApiError(404, 'The re-entry visa has not been uploaded yet.');
  return { url: signedDownloadUrl(visa.visaFile.fileName, visa.visaFile.resourceType), mimeType: visa.visaFile.mimeType, originalName: visa.visaFile.originalName };
}

/** Can this employee ask for vacation, and with how many days — for the request form. */
export async function getEligibility(employeeId, actor, { onBehalf = false } = {}) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (onBehalf) {
    if (!(await canAccessSection('annualVacation', actor, 'write'))) {
      throw new ApiError(403, 'You do not have permission to file an annual vacation for someone else.');
    }
    await assertEmployeeVisibleToActor(employeeId, actor);
  }
  return vacationEligibility(employee);
}

/**
 * Leave service — LeaveType configuration and the leave-request eligibility
 * engine.
 *
 * The eligibility engine is the heart of this module: entitlement is ALWAYS
 * computed here, server-side, from the employee's real joining date and their
 * actual leave history — never trusted from the client, exactly like
 * quotation totals. It is re-derived at submission time and frozen into
 * `eligibility` on the request (see leaveRequest.model.js) so a later policy
 * change can't retroactively rewrite why a past request was decided the way
 * it was.
 */
import Employee from '../employees/employee.model.js';
import LeaveType from './leaveType.model.js';
import LeaveRequest from './leaveRequest.model.js';
import LeaveSubmissionLock from './leaveSubmissionLock.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { signedDownloadUrl } from '../../middleware/upload.js';

/** The ORIGINAL decide-route role gate for Leave — preserved exactly as the
 *  authorization used whenever no ApprovalWorkflow governs a request (see
 *  approvalEngine.service.js's legacy path). */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR', 'Coordinator'];

/** Shared by submitLeaveRequest (notifySubmission) and decideLeaveRequest
 *  (buildStepNotification) so the "needs your approval" text can never drift
 *  between a request's first step and a later one. */
function buildLeaveStepNotification(doc, stepIndex) {
  return {
    type: 'RequestStatus',
    title: `A ${doc.leaveTypeName} request needs your approval`,
    body: doc.steps?.[stepIndex]?.label ? `Step: ${doc.steps[stepIndex].label}` : undefined,
    url: '/leave',
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole calendar days between two dates, inclusive of both ends. */
function daysInclusive(start, end) {
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/** Full months of continuous service between `joiningDate` and `now`. Also
 *  used by the EOSB calculator (settlement.service.js) — one tenure formula,
 *  not two that could quietly drift apart. */
export function monthsOfService(joiningDate, now) {
  let months = (now.getFullYear() - joiningDate.getFullYear()) * 12 + (now.getMonth() - joiningDate.getMonth());
  if (now.getDate() < joiningDate.getDate()) months -= 1;
  return Math.max(0, months);
}

/** Start of the employee's CURRENT leave-year (anniversary of joining), as of `now`. */
function currentLeaveYearStart(joiningDate, now) {
  const anniversary = new Date(joiningDate);
  anniversary.setFullYear(now.getFullYear());
  if (anniversary > now) anniversary.setFullYear(anniversary.getFullYear() - 1);
  return anniversary;
}

async function evaluateAnnual(employee, leaveType, requestedDays, now) {
  const serviceMonths = monthsOfService(employee.joiningDate, now);
  if (serviceMonths < leaveType.minServiceMonths) {
    return {
      eligible: false,
      autoApprovable: false,
      continuousServiceMonths: serviceMonths,
      entitlementDays: 0,
      usedDays: 0,
      remainingDays: 0,
      ruleApplied: `Requires ${leaveType.minServiceMonths} months of continuous service (has ${serviceMonths}).`,
    };
  }
  const entitlementDays =
    leaveType.tierYears && serviceMonths / 12 >= leaveType.tierYears
      ? leaveType.tierDaysPerYear
      : leaveType.daysPerYear;
  const yearStart = currentLeaveYearStart(employee.joiningDate, now);
  const [usedAgg] = await LeaveRequest.aggregate([
    {
      $match: {
        employee: employee._id,
        leaveType: leaveType._id,
        status: { $in: ['AutoApproved', 'Approved'] },
        startDate: { $gte: yearStart },
      },
    },
    { $group: { _id: null, total: { $sum: '$days' } } },
  ]);
  const usedDays = usedAgg?.total ?? 0;
  const remainingDays = Math.max(0, entitlementDays - usedDays);
  return {
    eligible: remainingDays >= requestedDays,
    autoApprovable: true,
    continuousServiceMonths: serviceMonths,
    entitlementDays,
    usedDays,
    remainingDays,
    ruleApplied: `Annual leave: ${entitlementDays} days/year, ${usedDays} used since ${yearStart.toDateString()}.`,
  };
}

async function evaluateContractCycle(employee, leaveType, requestedDays, now) {
  const serviceMonths = monthsOfService(employee.joiningDate, now);
  const cycleMonths = leaveType.cycleYears * 12;
  const cyclesCompleted = Math.floor(serviceMonths / cycleMonths);
  if (cyclesCompleted < 1) {
    return {
      eligible: false,
      autoApprovable: true,
      continuousServiceMonths: serviceMonths,
      entitlementDays: 0,
      usedDays: 0,
      remainingDays: 0,
      ruleApplied: `Requires a full ${leaveType.cycleYears}-year contract cycle (has ${(serviceMonths / 12).toFixed(1)} years).`,
    };
  }
  const cyclesUsed = await LeaveRequest.countDocuments({
    employee: employee._id,
    leaveType: leaveType._id,
    status: { $in: ['AutoApproved', 'Approved'] },
  });
  const cyclesAvailable = Math.max(0, cyclesCompleted - cyclesUsed);
  return {
    eligible: cyclesAvailable >= 1 && requestedDays <= leaveType.daysPerCycle,
    autoApprovable: true,
    continuousServiceMonths: serviceMonths,
    entitlementDays: leaveType.daysPerCycle,
    usedDays: cyclesUsed * leaveType.daysPerCycle,
    remainingDays: cyclesAvailable * leaveType.daysPerCycle,
    ruleApplied: `Contract-cycle leave: ${leaveType.daysPerCycle} days every ${leaveType.cycleYears} years — ${cyclesCompleted} cycle(s) completed, ${cyclesUsed} already taken.`,
  };
}

/**
 * Split `requestedDays` across `tiers` given `usedDays` already consumed
 * this leave year — tiers are consumed in array order (Article 117: the
 * first 30 days of a company's sick days this year are the "full pay"
 * tier, REGARDLESS of which request they came from, so a worker's 3rd
 * request this year might start mid-tier or straddle two tiers). Exported
 * for payroll.service.js, which reuses the exact same math to figure out
 * which calendar days within a request fall in which tier.
 */
export function allocateSickDays(usedDays, requestedDays, tiers) {
  const totalCap = tiers.reduce((sum, t) => sum + t.days, 0);
  const remainingDays = Math.max(0, totalCap - usedDays);
  const eligible = requestedDays <= remainingDays;

  let cursor = 0; // cumulative tier-days walked past so far
  let toAllocate = requestedDays;
  const payBreakdown = [];
  for (const tier of tiers) {
    const tierStart = cursor;
    const tierEnd = cursor + tier.days;
    cursor = tierEnd;
    if (usedDays >= tierEnd || toAllocate <= 0) continue; // tier fully used already, or nothing left to place
    const availableInTier = tierEnd - Math.max(usedDays, tierStart);
    const daysHere = Math.min(toAllocate, availableInTier);
    if (daysHere > 0) {
      payBreakdown.push({ days: daysHere, payPercent: tier.payPercent });
      toAllocate -= daysHere;
    }
  }
  // Beyond every configured tier (a manager approving a request over the
  // remaining balance anyway — `eligible` is already false here, but the
  // decision is theirs to make) is unpaid, not silently full-pay-by-
  // omission: Article 117's whole point is that pay tapers to zero past
  // the cap, it doesn't reset to 100% once the tiers run out. Merged into
  // the previous entry if that was already 0% (the request's own last
  // tier ending at 0%, same as the overflow) rather than showing two
  // adjacent "at 0% pay" lines.
  if (toAllocate > 0) {
    const last = payBreakdown[payBreakdown.length - 1];
    if (last?.payPercent === 0) last.days += toAllocate;
    else payBreakdown.push({ days: toAllocate, payPercent: 0 });
  }
  return { totalCap, remainingDays, eligible, payBreakdown };
}

async function evaluateSick(employee, leaveType, requestedDays, now) {
  const serviceMonths = monthsOfService(employee.joiningDate, now);
  if (serviceMonths < leaveType.minServiceMonths) {
    return {
      eligible: false,
      autoApprovable: false,
      continuousServiceMonths: serviceMonths,
      entitlementDays: 0,
      usedDays: 0,
      remainingDays: 0,
      ruleApplied: `Requires ${leaveType.minServiceMonths} months of continuous service (has ${serviceMonths}).`,
      payBreakdown: [],
    };
  }

  const yearStart = currentLeaveYearStart(employee.joiningDate, now);
  const [usedAgg] = await LeaveRequest.aggregate([
    {
      $match: {
        employee: employee._id,
        leaveType: leaveType._id,
        status: { $in: ['AutoApproved', 'Approved'] },
        startDate: { $gte: yearStart },
      },
    },
    { $group: { _id: null, total: { $sum: '$days' } } },
  ]);
  const usedDays = usedAgg?.total ?? 0;

  const { totalCap, remainingDays, eligible, payBreakdown } = allocateSickDays(usedDays, requestedDays, leaveType.sickPayTiers);
  const breakdownText = payBreakdown.map((b) => `${b.days} day${b.days > 1 ? 's' : ''} at ${b.payPercent}% pay`).join(', ');

  return {
    eligible,
    autoApprovable: true,
    continuousServiceMonths: serviceMonths,
    entitlementDays: totalCap,
    usedDays,
    remainingDays,
    ruleApplied: eligible
      ? `Sick leave: ${breakdownText || 'no days allocated'}. ${usedDays} used of ${totalCap} this leave year (since ${yearStart.toDateString()}).`
      : `Sick leave: only ${remainingDays} of ${totalCap} day(s) remain this leave year (since ${yearStart.toDateString()}) — requested ${requestedDays}.`,
    payBreakdown,
  };
}

function evaluateManual(employee, leaveType, requestedDays, now) {
  const serviceMonths = monthsOfService(employee.joiningDate, now);
  const meetsMinService = serviceMonths >= leaveType.minServiceMonths;
  return {
    eligible: false,
    autoApprovable: false,
    continuousServiceMonths: serviceMonths,
    entitlementDays: 0,
    usedDays: 0,
    remainingDays: 0,
    ruleApplied: meetsMinService
      ? 'This leave type always requires manager review.'
      : `Requires ${leaveType.minServiceMonths} months of continuous service (has ${serviceMonths}).`,
  };
}

/** Compute eligibility for one employee/leaveType/requestedDays combination. */
export async function evaluateEligibility(employee, leaveType, requestedDays, now = new Date()) {
  // joiningDate is required for 'Outsourced'/'Subcontracted' employees but
  // optional for 'Own' ones (see employee.model.js) — every recurrence type below needs it, so
  // fail with a clear message rather than crash if it's genuinely missing.
  if (!employee.joiningDate) {
    throw new ApiError(
      400,
      'This employee has no joining date on file — add one before requesting leave.'
    );
  }
  if (leaveType.recurrence === 'Annual') return evaluateAnnual(employee, leaveType, requestedDays, now);
  if (leaveType.recurrence === 'ContractCycle') {
    return evaluateContractCycle(employee, leaveType, requestedDays, now);
  }
  if (leaveType.recurrence === 'Sick') return evaluateSick(employee, leaveType, requestedDays, now);
  return evaluateManual(employee, leaveType, requestedDays, now);
}

// ---------------------------------------------------------------------------
// LeaveType configuration (Admin/Manager — the "customizable" policy layer)
// ---------------------------------------------------------------------------

export async function listLeaveTypes({ activeOnly } = {}) {
  const filter = activeOnly === 'true' ? { isActive: true } : {};
  return LeaveType.find(filter).sort({ name: 1 }).lean();
}

export async function createLeaveType(data, actor) {
  const existing = await LeaveType.findOne({ name: data.name }).lean();
  if (existing) throw new ApiError(409, 'A leave type with this name already exists.');
  const type = await LeaveType.create(data);
  await logAudit({
    user: actor.userId,
    action: 'leaveType.create',
    targetType: 'LeaveType',
    targetId: type._id,
    meta: { name: type.name, recurrence: type.recurrence },
    ip: actor.ip,
  });
  return type.toObject();
}

export async function updateLeaveType(id, data, actor) {
  const type = await LeaveType.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
  if (!type) throw new ApiError(404, 'Leave type not found.');
  await logAudit({
    user: actor.userId,
    action: 'leaveType.update',
    targetType: 'LeaveType',
    targetId: type._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return type;
}

// ---------------------------------------------------------------------------
// LeaveRequest — submit, list, decide, acknowledge, cancel
// ---------------------------------------------------------------------------

/** A Coordinator may only touch requests for employees assigned to them. */
async function assertEmployeeScope(actor, employeeId) {
  if (actor.role !== 'Coordinator') return; // everyone else's existing access is unchanged
  const employee = await Employee.findById(employeeId).select('coordinator').lean();
  if (!employee || employee.coordinator?.toString() !== actor.userId) {
    throw new ApiError(403, 'You do not have access to this employee.');
  }
}

/** Build the embedded `attachment` from an uploaded file — see
 *  leaveRequest.model.js's attachmentSchema. Mirrors reimbursement.service.js's
 *  receiptFromFile exactly, except this is only ever called when a file is
 *  actually present (the attachment is optional, unlike a receipt). */
function attachmentFromFile(file) {
  return {
    fileName: file.filename, // Cloudinary public_id, set by uploadSingle
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

export async function submitLeaveRequest(employeeId, { leaveType: leaveTypeId, startDate, endDate, reason }, file, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  const leaveType = await LeaveType.findById(leaveTypeId).lean();
  if (!leaveType || !leaveType.isActive) throw new ApiError(400, 'This leave type is not available.');

  if (endDate < startDate) throw new ApiError(400, 'End date cannot be before the start date.');
  const days = daysInclusive(startDate, endDate);

  if (leaveType.maxDaysPerRequest && days > leaveType.maxDaysPerRequest) {
    throw new ApiError(
      400,
      `${leaveType.name} is capped at ${leaveType.maxDaysPerRequest} day${leaveType.maxDaysPerRequest > 1 ? 's' : ''} per request.`
    );
  }

  // Fixed 2026-09-15, a real QA-audit-found gap — F3: the overlap check and
  // the entitlement evaluation below (and the create that follows) used to
  // run as plain, unserialized reads-then-write — two concurrent
  // submissions for the SAME employee could both read "no overlap" / "days
  // remaining" against the same pre-either-request snapshot, then both
  // create, leaving two overlapping requests and combined approved days
  // exceeding the real entitlement. Neither check has an existing document
  // to run an atomic conditional update against (there's no LeaveRequest
  // yet to compare against), so a real serialization point is needed — see
  // leaveSubmissionLock.model.js's own doc comment for the full reasoning.
  // Acquired here, released in `finally` below, however this function
  // exits (success, a thrown ApiError, or an unexpected error).
  try {
    await LeaveSubmissionLock.create({ employee: employee._id });
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError(409, 'Another leave submission for this employee is already being processed — try again in a moment.');
    }
    throw err;
  }

  try {
    const overlap = await LeaveRequest.findOne({
      employee: employee._id,
      status: { $in: ['AutoApproved', 'Approved', 'PendingReview'] },
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    }).lean();
    if (overlap) throw new ApiError(409, 'A leave request already exists that overlaps these dates.');

    const evaluation = await evaluateEligibility(employee, leaveType, days);
    const status = evaluation.eligible && evaluation.autoApprovable ? 'AutoApproved' : 'PendingReview';

    // Only a request that will actually go through decide() needs a workflow —
    // an auto-approved request is never decided, so resolving one for it would
    // be dead weight. null (no configured workflow) is the normal case; the
    // legacy single-level flow runs unchanged in decideLeaveRequest().
    let workflowFields = {};
    if (status === 'PendingReview') {
      const workflow = await resolveApprovalWorkflow(employee, 'Leave');
      if (workflow) {
        workflowFields = {
          workflow: workflow._id,
          workflowName: workflow.name,
          steps: workflow.steps,
          currentStep: 0,
        };
      }
    }

    const request = await LeaveRequest.create({
      employee: employee._id,
      leaveType: leaveType._id,
      leaveTypeName: leaveType.name,
      startDate,
      endDate,
      days,
      reason,
      attachment: file ? attachmentFromFile(file) : undefined,
      status,
      eligibility: {
        continuousServiceMonths: evaluation.continuousServiceMonths,
        entitlementDays: evaluation.entitlementDays,
        usedDays: evaluation.usedDays,
        remainingDays: evaluation.remainingDays,
        ruleApplied: evaluation.ruleApplied,
        // Only 'Sick' requests ever populate this — see evaluateSick().
        payBreakdown: evaluation.payBreakdown?.length ? evaluation.payBreakdown : undefined,
      },
      ...workflowFields,
    });

    await logAudit({
      user: actor.userId,
      action: status === 'AutoApproved' ? 'leave.request.auto_approved' : 'leave.request.submitted',
      targetType: 'LeaveRequest',
      targetId: request._id,
      meta: { employeeId: employee.employeeId, leaveType: leaveType.name, days, status },
      ip: actor.ip,
    });

    const plain = request.toObject();
    // An AutoApproved request has nobody left to notify — it's already done.
    if (status === 'PendingReview') {
      await notifySubmission(
        plain,
        buildLeaveStepNotification,
        LEGACY_DECIDE_ROLES,
        employee.coordinator ? [employee.coordinator] : []
      );
    }
    return plain;
  } finally {
    await LeaveSubmissionLock.deleteOne({ employee: employee._id });
  }
}

/**
 * Staff review queue — scoped to a Coordinator's own team automatically.
 * A Coordinator's OWN self-submitted requests (P2-M4: staff self-submission)
 * are included too, even though they aren't their own coordinator — without
 * this, a Coordinator who submits their own leave would have no screen that
 * ever shows it back to them (they have no ESS access to fall back on).
 */
export async function listLeaveRequests({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;

  if (actor.role === 'Coordinator') {
    const teamIds = await Employee.find({ coordinator: actor.userId }).distinct('_id');
    const visibleIds = actor.employee ? [...teamIds, actor.employee] : teamIds;
    const visibleIdStrings = visibleIds.map((id) => id.toString());
    if (employee && !visibleIdStrings.includes(employee)) {
      throw new ApiError(403, 'You do not have access to this employee.');
    }
    filter.employee = employee ?? { $in: visibleIds };
  }

  const [rawItems, total] = await Promise.all([
    LeaveRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('decidedBy', 'name')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  // Real, server-computed "can this viewer decide it" per row — see
  // approvalEngine.service.js. Convenience for the UI only; decideLeaveRequest
  // remains the actual gate.
  const items = await annotateCanDecide(rawItems, actor, {
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
  });
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function listOwnLeaveRequests(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    LeaveRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    LeaveRequest.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Approve/reject a PendingReview request. Auto-approved ones are never
 * decided — see acknowledge(). Delegates the actual step/authorization
 * logic to the shared engine (approvalEngine.service.js): a request with no
 * `workflow` runs the exact original single-level flow (LEGACY_DECIDE_ROLES
 * + assertEmployeeScope, unchanged); a request WITH a workflow is decided
 * step-by-step against real ApprovalRole membership instead.
 */
export async function decideLeaveRequest(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: LeaveRequest,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    assertScope: assertEmployeeScope,
    notFoundMessage: 'Leave request not found.',
    auditAction: 'leave.request',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `${doc.leaveTypeName} request ${doc.status}`,
      body: doc.decisionNote || undefined,
      // The requester may be a Worker (ESS) or a staff self-submitter
      // (Coordinator/HR/Manager/Accounts, admin shell) — see
      // notifyEmployeeUser's doc comment.
      url: (role) => (role === 'Worker' ? '/me/leave' : '/leave'),
    }),
    buildStepNotification: buildLeaveStepNotification,
  });
}

/** Mark an auto-approved request as seen — the "notice" a coordinator/manager clears. */
export async function acknowledgeLeaveRequest(id, actor) {
  const request = await LeaveRequest.findById(id);
  if (!request) throw new ApiError(404, 'Leave request not found.');
  if (request.status !== 'AutoApproved') {
    throw new ApiError(400, 'Only auto-approved requests can be acknowledged.');
  }
  await assertEmployeeScope(actor, request.employee);

  request.acknowledgedByManager = true;
  await request.save();

  await logAudit({
    user: actor.userId,
    action: 'leave.request.acknowledged',
    targetType: 'LeaveRequest',
    targetId: request._id,
    ip: actor.ip,
  });
  return request.toObject();
}

/** An attachment for its OWN requester only — used by the /api/me route. */
export async function getMyAttachmentFile(employeeId, id) {
  const request = await LeaveRequest.findById(id).lean();
  if (!request || request.employee.toString() !== employeeId) {
    throw new ApiError(404, 'Leave request not found.');
  }
  return resolveAttachment(request);
}

/** An attachment for staff review, team-scoped exactly like listLeaveRequests/
 *  decideLeaveRequest above. Fixed 2026-09-15, a real QA-audit-found gap —
 *  A2: the controller never passed an actor here at all, so a Coordinator
 *  who correctly gets 403 listing a foreign employee's requests could still
 *  pull that request's attachment bytes directly by id — the Worker
 *  self-service equivalent (getOwnAttachmentFile above) already scopes
 *  correctly by comparing against the caller's own employee id. */
export async function getAttachmentFile(id, actor) {
  const request = await LeaveRequest.findById(id).lean();
  if (!request) throw new ApiError(404, 'Leave request not found.');
  await assertEmployeeScope(actor, request.employee);
  return resolveAttachment(request);
}

function resolveAttachment(request) {
  if (!request.attachment) throw new ApiError(404, 'This request has no attachment.');
  return {
    url: signedDownloadUrl(request.attachment.fileName, request.attachment.resourceType),
    mimeType: request.attachment.mimeType,
    originalName: request.attachment.originalName,
  };
}

/** A worker cancels their own not-yet-started request. */
export async function cancelLeaveRequest(id, actor) {
  const request = await LeaveRequest.findById(id);
  if (!request) throw new ApiError(404, 'Leave request not found.');
  if (request.employee.toString() !== actor.employee) {
    throw new ApiError(403, 'You can only cancel your own leave requests.');
  }
  if (!['PendingReview', 'AutoApproved'].includes(request.status)) {
    throw new ApiError(400, 'This request can no longer be cancelled.');
  }
  if (new Date(request.startDate) <= new Date()) {
    throw new ApiError(400, 'This leave has already started and can no longer be cancelled.');
  }

  request.status = 'Cancelled';
  await request.save();

  await logAudit({
    user: actor.userId,
    action: 'leave.request.cancelled',
    targetType: 'LeaveRequest',
    targetId: request._id,
    ip: actor.ip,
  });
  return request.toObject();
}

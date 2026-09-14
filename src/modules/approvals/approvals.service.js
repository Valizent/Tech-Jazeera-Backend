/**
 * Approvals service — ApprovalRole/ApprovalWorkflow configuration (the
 * Admin-configurable half of the hierarchy) plus resolveApprovalWorkflow(),
 * which the shared approvalEngine (approvalEngine.service.js) and every
 * request-submit function (leave.service.js etc.) call to find out which
 * workflow, if any, governs a given employee/request-type combination.
 */
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow from './approvalWorkflow.model.js';
import User from '../auth/user.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import ExitReentryRequest from '../exitDocuments/exitReentry.model.js';
import CertificateRequest from '../exitDocuments/certificate.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import ReimbursementClaim from '../financialRequests/reimbursement.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

// Not STAFF_ROLES (rbac.js) — that constant also excludes Executive, who is
// still a legitimate ApprovalRole member (in fact it's their ONLY route into
// deciding anything, since Executive is deny-by-default at the router
// level; Office Secretary used to be the same but moved into STAFF_ROLES
// 2026-09-13). Only the two purely self-service personas, Worker and Staff,
// can never sit in an approval chain.
const SELF_SERVICE_ROLES = ['Worker', 'Staff'];

// ---------------------------------------------------------------------------
// ApprovalRole
// ---------------------------------------------------------------------------

export async function listApprovalRoles() {
  return ApprovalRole.find().sort({ name: 1 }).populate('members', 'name email role').lean();
}

/** Every member must be a real, non-self-service User account. */
async function assertValidMembers(memberIds = []) {
  if (memberIds.length === 0) return;
  const uniqueIds = [...new Set(memberIds.map(String))];
  const count = await User.countDocuments({ _id: { $in: uniqueIds }, role: { $nin: SELF_SERVICE_ROLES } });
  if (count !== uniqueIds.length) {
    throw new ApiError(400, 'One or more selected members are not valid staff accounts.');
  }
}

export async function createApprovalRole(data, actor) {
  const existing = await ApprovalRole.findOne({ name: data.name }).lean();
  if (existing) throw new ApiError(409, 'An approval role with this name already exists.');
  await assertValidMembers(data.members);
  const role = await ApprovalRole.create(data);
  await logAudit({
    user: actor.userId,
    action: 'approvalRole.create',
    targetType: 'ApprovalRole',
    targetId: role._id,
    meta: { name: role.name },
    ip: actor.ip,
  });
  return role.toObject();
}

export async function updateApprovalRole(id, data, actor) {
  if (data.members) await assertValidMembers(data.members);
  const role = await ApprovalRole.findByIdAndUpdate(id, data, { new: true, runValidators: true })
    .populate('members', 'name email role')
    .lean();
  if (!role) throw new ApiError(404, 'Approval role not found.');
  await logAudit({
    user: actor.userId,
    action: 'approvalRole.update',
    targetType: 'ApprovalRole',
    targetId: role._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return role;
}

// ---------------------------------------------------------------------------
// ApprovalWorkflow
// ---------------------------------------------------------------------------

export async function listApprovalWorkflows() {
  return ApprovalWorkflow.find().sort({ name: 1 }).populate('steps.roles', 'name isActive').lean();
}

/** Every role referenced by a step must exist and be active. */
async function assertValidSteps(steps) {
  const roleIds = [...new Set(steps.flatMap((s) => s.roles.map(String)))];
  if (roleIds.length === 0) return;
  const count = await ApprovalRole.countDocuments({ _id: { $in: roleIds }, isActive: true });
  if (count !== roleIds.length) {
    throw new ApiError(400, 'One or more selected roles are invalid or inactive.');
  }
}

/** MongoDB's duplicate-key error on the appliesTo partial-unique index is the
 *  ONE way this collision surfaces (see approvalWorkflow.model.js) — this
 *  turns that generic 11000 into the specific, actionable message. */
function rethrowAppliesToCollision(err) {
  if (err.code === 11000) {
    throw new ApiError(409, 'One of the selected request types already has an active default workflow.');
  }
  throw err;
}

export async function createApprovalWorkflow(data, actor) {
  const existing = await ApprovalWorkflow.findOne({ name: data.name }).lean();
  if (existing) throw new ApiError(409, 'An approval workflow with this name already exists.');
  await assertValidSteps(data.steps);

  let workflow;
  try {
    workflow = await ApprovalWorkflow.create(data);
  } catch (err) {
    rethrowAppliesToCollision(err);
  }

  await logAudit({
    user: actor.userId,
    action: 'approvalWorkflow.create',
    targetType: 'ApprovalWorkflow',
    targetId: workflow._id,
    meta: { name: workflow.name, appliesTo: workflow.appliesTo },
    ip: actor.ip,
  });
  return workflow.toObject();
}

export async function updateApprovalWorkflow(id, data, actor) {
  if (data.steps) await assertValidSteps(data.steps);

  let workflow;
  try {
    workflow = await ApprovalWorkflow.findByIdAndUpdate(id, data, { new: true, runValidators: true })
      .populate('steps.roles', 'name isActive')
      .lean();
  } catch (err) {
    rethrowAppliesToCollision(err);
  }
  if (!workflow) throw new ApiError(404, 'Approval workflow not found.');

  await logAudit({
    user: actor.userId,
    action: 'approvalWorkflow.update',
    targetType: 'ApprovalWorkflow',
    targetId: workflow._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return workflow;
}

/**
 * Which workflow governs `requestType` for this employee: an explicit
 * per-employee override (Employee.approvalWorkflow) if set and still active,
 * otherwise the company-wide default for that type. Returns null when
 * neither exists — meaning "run the legacy single-level flow" (see
 * approvalEngine.service.js). Never throws: a stale/deactivated override is
 * treated the same as no override, not an error, so deactivating a workflow
 * never breaks submission for employees still pointed at it.
 */
export async function resolveApprovalWorkflow(employee, requestType) {
  if (employee.approvalWorkflow) {
    const override = await ApprovalWorkflow.findById(employee.approvalWorkflow).lean();
    if (override?.isActive) return override;
  }
  return ApprovalWorkflow.findOne({ appliesTo: requestType, isActive: true }).lean();
}

// ---------------------------------------------------------------------------
// Approval Log — cross-request-type, ordered view of every workflow-decided
// step, for whoever sits in the hierarchy (not just Admin) to see "who
// approved what."
//
// NOTE: SalaryAdvance/Reimbursement/Timesheet/Mobilisation all support a
// workflow too (see their own service files) but were never added here —
// found while wiring ExitReentry/Certificate onto the engine, flagged as a
// separate follow-up rather than fixed in the same pass (Mobilisation in
// particular has a different shape — its `coordinators` are Users directly,
// not an Employee — worth verifying on its own before reusing this exact
// query shape for it).
// ---------------------------------------------------------------------------

// Timesheet/SalaryAdvance/Reimbursement added 2026-09-14 (a real QA-audit-
// found gap, D1) — all three have supported real ApprovalWorkflows for a
// while (see CLAUDE.md's own Status history), but were never added here, so
// a workflow-decided one of these never showed up in the cross-type log.
// Mobilisation deliberately stays OUT — its `coordinators` are Users
// directly, not an `employee` ref, so the shared `filter.employee = ...`
// line below doesn't apply to it the same way; folding it in needs its own
// pass, not a blind copy-paste (flagged when Timesheet/etc. were originally
// deferred too — still true, not a new gap).
const LOG_SOURCES = {
  Leave: { Model: LeaveRequest, typeNameField: 'leaveTypeName' },
  ExitReentry: { Model: ExitReentryRequest, typeNameField: 'visaType' },
  Certificate: { Model: CertificateRequest, typeNameField: 'type' },
  // No natural short "sub-type" label exists on these two — typeName
  // resolves to undefined for them (item[null] is a safe no-op, not a
  // crash), same as if the field were simply absent from a document.
  Timesheet: { Model: Timesheet, typeNameField: null },
  SalaryAdvance: { Model: SalaryAdvance, typeNameField: null },
  Reimbursement: { Model: ReimbursementClaim, typeNameField: 'category' },
};

/** Is this user a member of ANY approval role — the dynamic "sits somewhere
 *  in the hierarchy" check that (alongside Admin) unlocks the Approval Log.
 *  `isActive: true` (added 2026-09-14, a real QA-audit-found gap): deactivating
 *  a role must actually revoke what it granted, not just hide it from new
 *  assignment — membership in a disabled role no longer counts. */
export async function isApprovalRoleMember(userId) {
  const role = await ApprovalRole.findOne({ members: userId, isActive: true }).select('_id').lean();
  return Boolean(role);
}

/**
 * Is `userId` a member of any role in `roleIds` — a generalization of
 * isApprovalRoleMember to a specific SUBSET of roles, for callers that need
 * "one of THESE roles," not "any role at all." Used throughout for a Section
 * Access `allowedApprovalRoles` membership check (see sectionAccess.
 * service.js's canAccessSection), including mobilisations/mobilisation.
 * service.js's read-only viewer circle ('mobilisationsViewer') — one query
 * shape, reused everywhere, rather than inventing a per-feature membership
 * check. `isActive: true` (2026-09-14 QA-audit fix, same reasoning as
 * isApprovalRoleMember above) — a Section Access grant naming a since-
 * deactivated role no longer authorizes its members.
 */
export async function isMemberOfAnyRole(userId, roleIds) {
  if (!roleIds?.length) return false;
  const role = await ApprovalRole.findOne({ _id: { $in: roleIds }, members: userId, isActive: true }).select('_id').lean();
  return Boolean(role);
}

/**
 * Merge every configured request type's workflow-governed requests into one
 * ordered, filterable log. In-memory merge + pagination across the (small
 * number of) source collections — plenty for this app's scale, and far
 * simpler than a cross-collection server-side merge-sort for a handful of
 * request types.
 */
export async function listApprovalLog({ type, status, employee, from, to, page, limit }) {
  const typesToQuery = type ? [type] : Object.keys(LOG_SOURCES);
  const results = [];

  for (const requestType of typesToQuery) {
    const source = LOG_SOURCES[requestType];
    if (!source) continue;

    // Only requests actually governed by a workflow carry a real trail —
    // this log is about the configurable hierarchy, not the legacy
    // single-decision flow (which every review screen already shows).
    const filter = { workflow: { $ne: null } };
    if (status) filter.status = status;
    if (employee) filter.employee = employee;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }

    const items = await source.Model.find(filter)
      .populate('employee', 'fullName employeeId')
      .populate('workflow', 'name')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .populate('decidedBy', 'name role')
      .lean();

    for (const item of items) {
      results.push({ requestType, typeName: item[source.typeNameField], ...item });
    }
  }

  results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = results.length;
  const start = (page - 1) * limit;
  const items = results.slice(start, start + limit);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

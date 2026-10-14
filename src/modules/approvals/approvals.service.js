/**
 * Approvals service — ApprovalRole/ApprovalWorkflow configuration (the
 * Admin-configurable half of the hierarchy) plus resolveApprovalWorkflow(),
 * which the shared approvalEngine (approvalEngine.service.js) and every
 * request-submit function (leave.service.js etc.) call to find out which
 * workflow, if any, governs a given employee/request-type combination.
 */
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow, { EMPLOYEE_APPROVAL_TYPES } from './approvalWorkflow.model.js';
import Employee from '../employees/employee.model.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { normalizeDepartment } from '../employees/departments.js';
import User from '../auth/user.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import ExitReentryRequest from '../exitDocuments/exitReentry.model.js';
import AnnualVacationRequest from '../annualVacation/annualVacation.model.js';
import CertificateRequest from '../exitDocuments/certificate.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import ReimbursementClaim from '../financialRequests/reimbursement.model.js';
import Client from '../clients/client.model.js';
import ClientPayment from '../deployments/clientPayment.model.js';
import SubcontractorPayment from '../deployments/subcontractorPayment.model.js';
import Deployment from '../deployments/deployment.model.js';
import SubcontractorTransfer from '../subcontractorTransfers/subcontractorTransfer.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { SELF_SERVICE_ROLE_NAMES } from '../sectionAccess/selfService.constants.js';
import { renameDesignation, syncDesignationsToRoleChange } from '../employees/designationSync.service.js';

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

/**
 * Every member must be a real User account — and not a self-service (Worker/
 * Staff) one, except in a reserved role (`allowsSelfService`: "Worker" and
 * "Staff"), which exists precisely to hold those individual logins.
 */
async function assertValidMembers(memberIds = [], { allowsSelfService = false } = {}) {
  if (memberIds.length === 0) return;
  const uniqueIds = [...new Set(memberIds.map(String))];
  const filter = { _id: { $in: uniqueIds }, ...(allowsSelfService ? {} : { role: { $nin: SELF_SERVICE_ROLES } }) };
  const count = await User.countDocuments(filter);
  if (count !== uniqueIds.length) {
    throw new ApiError(
      400,
      allowsSelfService
        ? 'One or more selected members are not valid accounts.'
        : 'One or more selected members are not valid staff accounts. Worker and Staff logins can only join the "Worker" and "Staff" roles.'
    );
  }
}

/**
 * Create the two reserved roles if they are missing, and make sure an
 * existing role of the same name carries the flag (an Admin may already have
 * created "Staff" by hand). Idempotent — called at every server start.
 */
export async function ensureSelfServiceRoles() {
  for (const name of SELF_SERVICE_ROLE_NAMES) {
    await ApprovalRole.updateOne(
      { name },
      { $set: { allowsSelfService: true }, $setOnInsert: { name, description: `Logins of type ${name}: grant this role access on the Section Access page.`, isActive: true, members: [] } },
      { upsert: true }
    );
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
  const existing = await ApprovalRole.findById(id).select('name members allowsSelfService').lean();
  if (!existing) throw new ApiError(404, 'Approval role not found.');
  if (data.members) await assertValidMembers(data.members, { allowsSelfService: Boolean(existing.allowsSelfService) });
  const role = await ApprovalRole.findByIdAndUpdate(id, data, { new: true, runValidators: true })
    .populate('members', 'name email role')
    .lean();
  if (!role) throw new ApiError(404, 'Approval role not found.');
  // Designation on the employee record is the other half of role membership (employees/designationSync.service.js).
  if (data.name && data.name !== existing.name && !existing.allowsSelfService) await renameDesignation(existing.name, role.name);
  if (data.members) await syncDesignationsToRoleChange(role, existing.members, role.members.map((m) => m._id));
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
  return ApprovalWorkflow.find()
    .sort({ name: 1 })
    .populate('steps.roles', 'name isActive')
    .populate('notifyRoles', 'name isActive')
    .populate('departmentRoutes.workflow', 'name isActive')
    .lean();
}

/** Every role referenced by a step must exist and be active. */
async function assertValidSteps(steps, notifyRoles = []) {
  const duties = steps.map((s) => s.duty).filter(Boolean);
  if (new Set(duties).size !== duties.length) {
    throw new ApiError(400, 'Each special step duty can be given to only one step of a workflow.');
  }
  const roleIds = [...new Set([...steps.flatMap((s) => s.roles.map(String)), ...notifyRoles.map(String)])];
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

/** Every route must point at a real, active workflow other than the one being
 *  saved, and only a workflow that is itself a default can carry routes. */
async function assertValidDepartmentRoutes(routes, appliesTo, selfId) {
  if (!routes?.length) return;
  if (!appliesTo?.length) {
    throw new ApiError(400, 'Department routes can only be set on a default workflow (one that applies to a request type).');
  }
  const ids = routes.map((r) => String(r.workflow));
  if (selfId && ids.includes(String(selfId))) throw new ApiError(400, 'A workflow cannot route to itself.');
  const found = await ApprovalWorkflow.countDocuments({ _id: { $in: ids }, isActive: true });
  if (found !== new Set(ids).size) throw new ApiError(400, 'One or more department routes point at a workflow that is missing or inactive.');
}

export async function createApprovalWorkflow(data, actor) {
  const existing = await ApprovalWorkflow.findOne({ name: data.name }).lean();
  if (existing) throw new ApiError(409, 'An approval workflow with this name already exists.');
  await assertValidSteps(data.steps, data.notifyRoles);
  await assertValidDepartmentRoutes(data.departmentRoutes, data.appliesTo, null);

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
  if (data.steps || data.notifyRoles) {
    const current = data.steps ? null : await ApprovalWorkflow.findById(id).select('steps').lean();
    await assertValidSteps(data.steps ?? current?.steps ?? [], data.notifyRoles);
  }
  if (data.departmentRoutes?.length) {
    const current = await ApprovalWorkflow.findById(id).select('appliesTo').lean();
    await assertValidDepartmentRoutes(data.departmentRoutes, data.appliesTo ?? current?.appliesTo, id);
  }

  let workflow;
  try {
    workflow = await ApprovalWorkflow.findByIdAndUpdate(id, data, { new: true, runValidators: true })
      .populate('steps.roles', 'name isActive')
      .populate('notifyRoles', 'name isActive')
      .populate('departmentRoutes.workflow', 'name isActive')
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
  const own = employee.approvalOverrides?.find((o) => o.requestType === requestType);
  if (own) {
    const override = await ApprovalWorkflow.findById(own.workflow).lean();
    if (override?.isActive) return override;
  }
  const companyDefault = await ApprovalWorkflow.findOne({ appliesTo: requestType, isActive: true }).lean();
  // 2026-10-13: the default may route by the employee's department (e.g. annual
  // vacation: Accounts -> FM, everyone else -> MM). Only a clearly recognisable
  // department routes; anything else falls back to the default itself.
  const department = normalizeDepartment(employee.department);
  const route = department && companyDefault?.departmentRoutes?.find((r) => r.department === department);
  if (route) {
    const routed = await ApprovalWorkflow.findById(route.workflow).lean();
    if (routed?.isActive) return routed;
  }
  return companyDefault;
}

/**
 * The fields that put a new (or resubmitted) request at the first step of the hierarchy set up for
 * `requestType`, or the empty set when none is (then the original single-step rule applies unchanged).
 * `approvalTrail: []` clears a previous round on a resubmission. For requests with no employee behind them
 * (client approval, payments, monthly hours, subcontractor transfers).
 */
export async function startApproval(requestType) {
  const workflow = await resolveApprovalWorkflow({}, requestType);
  if (!workflow) return { workflow: null, workflowName: null, steps: undefined, currentStep: 0, approvalTrail: [] };
  return {
    workflow: workflow._id,
    workflowName: workflow.name,
    steps: workflow.steps.map(({ label, roles }) => ({ label, roles })),
    currentStep: 0,
    approvalTrail: [],
  };
}

// ---------------------------------------------------------------------------
// Employees' approval hierarchy: who uses the default chain for which module, and who has their own.
// ---------------------------------------------------------------------------

export async function listEmployeeApprovals({ search, page = 1, limit = 25 }) {
  const filter = { status: { $ne: 'Exited' } };
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ fullName: pattern }, { employeeId: pattern }];
  }
  const [items, total] = await Promise.all([
    Employee.find(filter)
      .select('fullName employeeId department designation approvalOverrides')
      .sort({ fullName: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('approvalOverrides.workflow', 'name isActive')
      .lean(),
    Employee.countDocuments(filter),
  ]);
  return {
    items: items.map((e) => ({
      _id: e._id,
      fullName: e.fullName,
      employeeId: e.employeeId,
      department: e.department ?? null,
      designation: e.designation,
      overrides: (e.approvalOverrides ?? []).filter((o) => o.workflow).map((o) => ({ requestType: o.requestType, workflow: o.workflow })),
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Give one employee their own hierarchy for one module, or (workflow null) put them back on the default. */
export async function setEmployeeApprovalOverride(employeeId, { requestType, workflow }, actor) {
  if (!EMPLOYEE_APPROVAL_TYPES.includes(requestType)) {
    throw new ApiError(400, 'This module is not set per employee.');
  }
  const employee = await Employee.findById(employeeId).select('fullName employeeId approvalOverrides');
  if (!employee) throw new ApiError(404, 'Employee not found.');
  let chosen = null;
  if (workflow) {
    chosen = await ApprovalWorkflow.findById(workflow).select('name isActive').lean();
    if (!chosen || !chosen.isActive) throw new ApiError(400, 'Selected approval hierarchy is not valid or is inactive.');
  }
  employee.approvalOverrides = employee.approvalOverrides.filter((o) => o.requestType !== requestType);
  if (chosen) employee.approvalOverrides.push({ requestType, workflow: chosen._id });
  await employee.save();
  await logAudit({
    user: actor.userId,
    action: 'employee.approvalOverride',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { employeeId: employee.employeeId, fullName: employee.fullName, requestType, workflow: chosen?.name ?? null },
    ip: actor.ip,
  });
  return {
    _id: employee._id,
    overrides: employee.approvalOverrides.map((o) => ({ requestType: o.requestType, workflow: o.workflow })),
  };
}

/**
 * One-off, idempotent: the single per-employee override that existed before 2026-10-14 applied to every module
 * the employee files, so it becomes one entry per employee-filed module (existing entries are kept), then the
 * old field is removed. Runs at boot; does nothing once converted.
 */
export async function migrateLegacyEmployeeOverrides() {
  const legacy = await Employee.collection.find({ approvalWorkflow: { $exists: true, $ne: null } }).toArray();
  for (const e of legacy) {
    const have = new Set((e.approvalOverrides ?? []).map((o) => o.requestType));
    const added = EMPLOYEE_APPROVAL_TYPES.filter((t) => !have.has(t)).map((requestType) => ({ requestType, workflow: e.approvalWorkflow }));
    await Employee.collection.updateOne(
      { _id: e._id },
      { $set: { approvalOverrides: [...(e.approvalOverrides ?? []), ...added] }, $unset: { approvalWorkflow: '' } }
    );
  }
  await Employee.collection.updateMany({ approvalWorkflow: null }, { $unset: { approvalWorkflow: '' } });
  return legacy.length;
}

// ---------------------------------------------------------------------------
// Approval Log — cross-request-type, ordered view of every workflow-decided
// step, for whoever sits in the hierarchy (not just Admin) to see "who
// approved what."
//
// Fixed 2026-09-15, a real QA-audit-found gap — D3: this section used to
// carry an older NOTE claiming Timesheet/SalaryAdvance/Reimbursement/
// Mobilisation were "never added here" as a still-open follow-up —
// contradicted by the LOG_SOURCES mapping right below it, which already
// includes three of those four (see the 2026-09-14 fix noted just below).
// Removed rather than left standing next to code that disproves it.
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
// `pendingStatus` (added 2026-09-15, a real QA-audit-found gap — F9): each
// source model's own literal "awaiting decision" status value — they are
// NOT all the same string (Leave's is 'PendingReview', Timesheet's is
// 'Submitted', every other source's is 'Pending'). listApprovalLog
// translates the client's normalized `status=Pending` into whichever of
// these applies per source type it's currently querying; 'Approved'/
// 'Rejected' need no such table, every source uses those exact literals.
const LOG_SOURCES = {
  Leave: { Model: LeaveRequest, typeNameField: 'leaveTypeName', pendingStatus: 'PendingReview' },
  ExitReentry: { Model: ExitReentryRequest, typeNameField: 'visaType', pendingStatus: 'Pending' },
  AnnualVacation: { Model: AnnualVacationRequest, typeNameField: null, pendingStatus: 'PendingReview' },
  Certificate: { Model: CertificateRequest, typeNameField: 'type', pendingStatus: 'Pending' },
  // No natural short "sub-type" label exists on these two — typeName
  // resolves to undefined for them (item[null] is a safe no-op, not a
  // crash), same as if the field were simply absent from a document.
  Timesheet: { Model: Timesheet, typeNameField: null, pendingStatus: 'Submitted' },
  SalaryAdvance: { Model: SalaryAdvance, typeNameField: null, pendingStatus: 'Pending' },
  Reimbursement: { Model: ReimbursementClaim, typeNameField: 'category', pendingStatus: 'Pending' },
  // 2026-10-14: decisions that are not tied to one employee. `subject` says who/what it is about; their
  // status lives in `statusField` (the log hands the UI a normalised `status`).
  ClientApproval: {
    Model: Client,
    typeNameField: null,
    pendingStatus: 'Pending',
    statusField: 'approvalStatus',
    subject: (i) => ({ subject: i.companyName, subjectRef: null }),
  },
  ClientPayment: {
    Model: ClientPayment,
    typeNameField: null,
    pendingStatus: 'Pending',
    statusField: 'decisionStatus',
    populate: [{ path: 'client', select: 'companyName' }],
    subject: (i) => ({ subject: i.client?.companyName ?? '-', subjectRef: `SAR ${i.amount}` }),
  },
  SubcontractorPayment: {
    Model: SubcontractorPayment,
    typeNameField: null,
    pendingStatus: 'Pending',
    statusField: 'decisionStatus',
    populate: [{ path: 'subcontractor', select: 'name' }],
    subject: (i) => ({ subject: i.subcontractor?.name ?? '-', subjectRef: `SAR ${i.amount}` }),
  },
  SubcontractorTransfer: {
    Model: SubcontractorTransfer,
    typeNameField: null,
    pendingStatus: 'Pending',
    subject: (i) => ({ subject: i.workerName, subjectRef: `${i.from?.name} → ${i.to?.name}` }),
  },
  // Entries inside a deployment: flattened below.
  MonthlyHours: { Model: Deployment, embedded: 'monthlyHours', typeNameField: 'month', pendingStatus: 'Pending' },
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
    // The employee filter only makes sense for requests an employee filed.
    if (employee && (source.statusField || source.embedded || requestType === 'SubcontractorTransfer')) continue;
    const statusField = source.statusField ?? 'status';
    const wanted = status === 'Pending' ? source.pendingStatus : status;
    const inRange = (date) => (!from || date >= from) && (!to || date <= to);

    // Entries inside a deployment (monthly hours): one result per entry that sits on a hierarchy.
    if (source.embedded) {
      const deployments = await source.Model.find({ [`${source.embedded}.workflow`]: { $ne: null } })
        .populate('monthlyHours.steps.roles', 'name')
        .populate('monthlyHours.approvalTrail.approvalRole', 'name')
        .populate('monthlyHours.approvalTrail.approvedBy', 'name role')
        .populate('monthlyHours.decidedBy', 'name role')
        .lean();
      for (const dep of deployments) {
        for (const entry of dep.monthlyHours) {
          if (!entry.workflow) continue;
          if (wanted && entry.status !== wanted) continue;
          if (!inRange(new Date(entry.enteredAt))) continue;
          results.push({
            ...entry,
            requestType,
            typeName: entry.month,
            createdAt: entry.enteredAt,
            workflow: { _id: entry.workflow, name: entry.workflowName },
            subject: dep.workerName,
            subjectRef: entry.month,
          });
        }
      }
      continue;
    }

    // Only requests actually governed by a workflow carry a real trail — this log is about the configurable
    // hierarchy, not the legacy single-decision flow (which every review screen already shows).
    const filter = { workflow: { $ne: null } };
    if (wanted) filter[statusField] = wanted;
    if (employee) filter.employee = employee;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }

    let query = source.Model.find(filter);
    if (!source.subject) query = query.populate('employee', 'fullName employeeId');
    for (const populate of source.populate ?? []) query = query.populate(populate);
    const items = await query
      .populate('workflow', 'name')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .populate('decidedBy', 'name role')
      .lean();

    for (const item of items) {
      const who = source.subject
        ? source.subject(item)
        : { subject: item.employee?.fullName, subjectRef: item.employee?.employeeId };
      results.push({
        requestType,
        typeName: source.typeNameField ? item[source.typeNameField] : undefined,
        ...item,
        // One normalised status for the UI, whatever field this request type keeps it in.
        status: item[statusField],
        ...who,
      });
    }
  }

  results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = results.length;
  const start = (page - 1) * limit;
  const items = results.slice(start, start + limit);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

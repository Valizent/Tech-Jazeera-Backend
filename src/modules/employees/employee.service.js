/**
 * Employee service — all employee business logic. Controllers only translate
 * HTTP; nothing in here touches req/res.
 */
import Employee, { WORKFORCE_TYPES } from './employee.model.js';
import User, { MANAGER_ELIGIBLE_ROLES } from '../auth/user.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import Attendance from '../attendance/attendance.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import ApiError from '../../utils/ApiError.js';
import { hashPassword, generateTempPassword } from '../auth/auth.service.js';
import { logAudit } from '../audit/audit.service.js';

/**
 * A document counts as "needs attention" when it expires within this many
 * days (or already has). The client mirrors this constant for its badges —
 * if you change it, change client/src/lib/constants.js too.
 */
export const EXPIRY_WARNING_DAYS = 30;

/** Fields the expiry-alert filter inspects. */
const EXPIRY_FIELDS = [
  'passport.expiry',
  'visa.expiry',
  'iqama.expiry',
  'medical.expiry',
  'drivingLicense.expiry',
];

/** Escape user text before embedding it in a $regex — prevents both regex
 *  injection and accidental syntax errors from names like "O'Brien (Ops)". */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Paginated, searchable, sortable listing.
 * search       → case-insensitive match on name / employeeId / mobile / email
 * status       → exact match
 * alerts       → 'true' keeps only employees with a document expiring within
 *                thresholdDays (default EXPIRY_WARNING_DAYS), or already expired
 * thresholdDays→ override the alert window (P2-M2, customizable per viewer)
 * client       → only employees currently assigned to that client
 * team         → 'mine' (Manager only) — only employees under their coordinators
 *
 * `actor` (role + userId) is optional so internal callers (e.g. a future
 * script) can still list company-wide; every HTTP call supplies it.
 */
export async function listEmployees(
  { page, limit, search, status, type, alerts, thresholdDays, client, team, createdByRole, sortBy, sortOrder },
  actor
) {
  // Each condition is AND-ed; search and alerts are each internally OR-ed.
  const conditions = [];
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({
      $or: [{ fullName: rx }, { employeeId: rx }, { mobile: rx }, { email: rx }],
    });
  }
  if (status) conditions.push({ status });
  if (type) conditions.push({ type });
  if (client) conditions.push({ currentClient: client });
  if (alerts === 'true') {
    const days = thresholdDays ?? EXPIRY_WARNING_DAYS;
    const threshold = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    // $lte against a Date matches only real dates — documents with no expiry
    // (null/absent) are naturally excluded.
    conditions.push({ $or: EXPIRY_FIELDS.map((field) => ({ [field]: { $lte: threshold } })) });
  }
  if (createdByRole === 'Coordinator') {
    const coordinatorIds = await User.find({ role: 'Coordinator' }).distinct('_id');
    conditions.push({ createdBy: { $in: coordinatorIds } });
  }
  // P2-M2: a Coordinator sees their own assigned employees — this is not a
  // filter the caller can opt out of. Milestone 5: PLUS every standby
  // workforce employee (coordinator: null) company-wide, so any Coordinator
  // can find and mobilise them — visibility only, never approval authority
  // (leave/attendance/dashboard scoping deliberately stay coordinator-owned-
  // only, unchanged). A Manager may narrow to their coordinators' teams with
  // team=mine; without it a Manager keeps the existing company-wide view
  // (adding Coordinator must not shrink anyone else's established access).
  if (actor?.role === 'Coordinator') {
    conditions.push({ $or: [{ coordinator: actor.userId }, { coordinator: null, type: { $in: WORKFORCE_TYPES } }] });
  } else if (actor?.role === 'Manager' && team === 'mine') {
    // The Manager's direct 'Own' reports (e.g. their Coordinators) → the
    // Users linked to those Employee records → the Employees THOSE
    // Coordinators hold. Employee.manager replaced User.managedBy as the
    // hierarchy field, so this is now an Employee lookup, not a User one.
    const reportIds = await Employee.find({ type: 'Own', manager: actor.userId }).distinct('_id');
    const coordinatorIds = await User.find({ role: 'Coordinator', employee: { $in: reportIds } }).distinct(
      '_id'
    );
    conditions.push({ coordinator: { $in: coordinatorIds } });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  // Secondary _id sort keeps pagination stable when the primary key ties
  // (e.g. many employees created the same day).
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };

  const [items, total] = await Promise.all([
    Employee.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('createdBy', 'name role')
      .lean(),
    Employee.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getEmployee(id, actor) {
  // Populate the current client's name, and the assigned coordinator's name
  // (P2-M2), so the profile can show/link both rather than a raw id.
  // currentClient is set by the deployment workflow (M6).
  const employee = await Employee.findById(id)
    .populate('currentClient', 'companyName')
    .populate('coordinator', 'name email')
    .populate('manager', 'name email')
    .populate('approvalWorkflow', 'name isActive')
    .populate('subcontractor', 'name')
    .populate('createdBy', 'name role')
    .lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  // P2-M2: a Coordinator may only open employees assigned to them, PLUS
  // (Milestone 5) any standby workforce employee — everyone else's existing
  // access (Admin/Manager/HR/Accounts see everyone) is unchanged. Same
  // visibility-only widening as listEmployees above.
  if (actor?.role === 'Coordinator') {
    const isMyAssignment = employee.coordinator?._id?.toString() === actor.userId;
    const isStandbyWorkforce = !employee.coordinator && WORKFORCE_TYPES.includes(employee.type);
    if (!isMyAssignment && !isStandbyWorkforce) {
      throw new ApiError(403, 'You do not have access to this employee.');
    }
  }
  // P2-M1: surface whether this employee has a login so the profile can show
  // account status (and hide "create login" once one exists) without a second
  // round-trip. Minimal, non-sensitive fields only — never the hash.
  const login = await User.findOne({ employee: id }).select('email role isActive').lean();
  employee.login = login
    ? { id: login._id.toString(), email: login.email, role: login.role, isActive: login.isActive }
    : null;
  return employee;
}

/** The assigned manager, if any, must be an Admin or Manager user. */
async function assertValidManager(managerId) {
  if (!managerId) return;
  const manager = await User.findById(managerId).lean();
  if (!manager || !MANAGER_ELIGIBLE_ROLES.includes(manager.role)) {
    throw new ApiError(400, 'Selected manager must be an Admin or Manager account.');
  }
}

/** The assigned approval-workflow override, if any, must actually exist and be active. */
async function assertValidApprovalWorkflow(workflowId) {
  if (!workflowId) return;
  const workflow = await ApprovalWorkflow.findById(workflowId).lean();
  if (!workflow || !workflow.isActive) {
    throw new ApiError(400, 'Selected approval workflow is not valid or is inactive.');
  }
}

/** A 'Subcontracted' employee's supplier, if given, must be a real Subcontractor. */
async function assertValidSubcontractor(subcontractorId) {
  if (!subcontractorId) return;
  const subcontractor = await Subcontractor.findById(subcontractorId).lean();
  if (!subcontractor) {
    throw new ApiError(400, 'Selected subcontractor is not valid.');
  }
}

/**
 * Provision a login for an existing employee, with any role except Admin —
 * the ONE way to create a login in this app (Admin/HR only, enforced on the
 * route). Generates a temporary password, returns it ONCE to the caller to
 * hand over, and never stores or logs it in plaintext.
 *
 * Guards:
 *  - employee must exist (404)
 *  - employee must not already have a login (409) — the one-to-one link
 *  - a login needs an email: use the employee's, or one the admin supplies
 *    when the record has none (400 if neither)
 *  - that email must be free (409) — checked here for a clear message, with
 *    the User email/employee unique indexes as the final backstop on a race
 */
export async function createEmployeeLogin(employeeId, { email, role }, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  // Milestone 4: the ESS portal is Own-type-only now, so provisioning a login
  // for an Outsourced/Subcontracted employee would just create a login that
  // can never sign into anything — reject it at the source instead.
  if (employee.type !== 'Own') {
    throw new ApiError(
      400,
      'A login can only be created for an Own-type (internal staff) employee — the self-service portal is not available to Outsourced or Subcontracted workers.'
    );
  }

  const existing = await User.findOne({ employee: employeeId }).lean();
  if (existing) throw new ApiError(409, 'This employee already has a login.');

  const loginEmail = email ?? employee.email;
  if (!loginEmail) {
    throw new ApiError(
      400,
      'This employee has no email on file — add one, or provide an email for the login.'
    );
  }

  const emailTaken = await User.findOne({ email: loginEmail }).lean();
  if (emailTaken) throw new ApiError(409, 'A user with this email already exists.');

  const tempPassword = generateTempPassword();
  const user = await User.create({
    name: employee.fullName,
    email: loginEmail,
    passwordHash: await hashPassword(tempPassword),
    role,
    employee: employee._id,
  });

  await logAudit({
    user: actor.userId,
    action: 'user.provision.employee',
    targetType: 'User',
    targetId: user._id,
    // Password is NEVER logged — only the identity of the account created.
    meta: { employeeId: employee.employeeId, email: loginEmail, role },
    ip: actor.ip,
  });

  return {
    user: { id: user._id.toString(), name: user.name, email: user.email, role: user.role },
    tempPassword,
  };
}

/**
 * Admin/HR corrects an existing login's role — e.g. it was provisioned as
 * 'Worker' when this is really an internal 'Own'-type employee who should
 * have gotten 'Staff' instead. The Users module's updateStaffUser() covers
 * this same action for the 5 non-Worker roles, but deliberately excludes
 * Worker (and, by the same logic, Staff) — those self-service logins aren't
 * listed on the company-wide Team page at all, so this employee-scoped
 * route is the only place either of them can be corrected. Revokes every
 * existing session for the login: the role is baked into its access token,
 * so an old token would otherwise keep acting under the previous role until
 * it naturally expired.
 */
export async function updateEmployeeLoginRole(employeeId, role, actor) {
  const login = await User.findOne({ employee: employeeId });
  if (!login) throw new ApiError(404, 'This employee does not have a login yet.');

  const previousRole = login.role;
  login.role = role;
  await login.save();
  await RefreshToken.deleteMany({ user: login._id });

  await logAudit({
    user: actor.userId,
    action: 'user.role.update',
    targetType: 'User',
    targetId: login._id,
    meta: { email: login.email, employeeId, from: previousRole, to: role },
    ip: actor.ip,
  });

  return { id: login._id.toString(), name: login.name, email: login.email, role: login.role };
}

/**
 * Admin/HR resets a Worker's password — the recovery path for a forgotten
 * or lost temp password, mirroring resetStaffPassword() in the Users module.
 * No self-service email flow exists for this project (no email provider is
 * configured; see docs/P2-M4-notes.md), so this admin-initiated reset is the
 * only recovery path today.
 */
export async function resetEmployeeLoginPassword(employeeId, actor) {
  const login = await User.findOne({ employee: employeeId });
  if (!login) throw new ApiError(404, 'This employee does not have a login yet.');

  const tempPassword = generateTempPassword();
  login.passwordHash = await hashPassword(tempPassword);
  await login.save();
  await RefreshToken.deleteMany({ user: login._id });

  await logAudit({
    user: actor.userId,
    action: 'user.password.reset',
    targetType: 'User',
    targetId: login._id,
    meta: { email: login.email, employeeId },
    ip: actor.ip,
  });

  return { tempPassword };
}

/** Duplicate employeeId is caught by the unique index → 409 via errorHandler. */
export async function createEmployee(data, actor) {
  const payload = { ...data, createdBy: actor.userId };
  // A Coordinator can never create an internal-staff record — only 'Own' is
  // overridden (their choice of 'Outsourced' vs 'Subcontracted' is left
  // alone, both are "their deployable team"). This is an override (not just
  // a default) so a hand-crafted request can't smuggle an 'Own' type
  // through. Coordinator is deliberately NOT auto-assigned here (Milestone
  // 5): a newly created employee always starts on standby (coordinator:
  // null), visible to every Coordinator, and only gets one once a real
  // Mobilisation actually places them — see mobilisation.service.js's
  // createMobilisation.
  if (actor.role === 'Coordinator' && payload.type === 'Own') payload.type = 'Outsourced';
  await assertValidManager(payload.manager);
  await assertValidApprovalWorkflow(payload.approvalWorkflow);
  await assertValidSubcontractor(payload.subcontractor);
  const employee = await Employee.create(payload);
  await logAudit({
    user: actor.userId,
    action: 'employee.create',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { employeeId: employee.employeeId, fullName: employee.fullName },
    ip: actor.ip,
  });
  return employee.toObject();
}

export async function updateEmployee(id, data, actor) {
  if ('manager' in data) await assertValidManager(data.manager);
  if ('approvalWorkflow' in data) await assertValidApprovalWorkflow(data.approvalWorkflow);
  if ('subcontractor' in data) await assertValidSubcontractor(data.subcontractor);
  const employee = await Employee.findByIdAndUpdate(id, data, {
    new: true, // return the updated document, not the stale one
    runValidators: true, // Mongoose skips schema validation on updates unless told
  }).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  await logAudit({
    user: actor.userId,
    action: 'employee.update',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { employeeId: employee.employeeId, fields: Object.keys(data) },
    ip: actor.ip,
  });
  return employee;
}

/**
 * Deleting an Employee must not leave anything dangling behind — a real
 * incident, not a hypothetical: an earlier version of this function deleted
 * only the Employee row, leaving its Attendance history AND its login (if
 * any) pointing at an id that no longer resolved to anything. `.populate()`
 * on those orphaned Attendance rows returned `null` instead of erroring,
 * which crashed every attempt to load the Records grid. Cascade cleanup
 * fixes it at the source: no login without a real Employee, no Attendance
 * without a real Employee.
 */
export async function deleteEmployee(id, actor) {
  const employee = await Employee.findByIdAndDelete(id).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  await Attendance.deleteMany({ employee: id });

  const login = await User.findOne({ employee: id });
  if (login) {
    await RefreshToken.deleteMany({ user: login._id });
    await User.findByIdAndDelete(login._id);
  }

  await logAudit({
    user: actor.userId,
    action: 'employee.delete',
    targetType: 'Employee',
    targetId: employee._id,
    meta: {
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      loginRemoved: Boolean(login),
    },
    ip: actor.ip,
  });
}

/**
 * Employee service — all employee business logic. Controllers only translate
 * HTTP; nothing in here touches req/res.
 */
import Employee from './employee.model.js';
import User, { MANAGER_ELIGIBLE_ROLES } from '../auth/user.model.js';
import Attendance from '../attendance/attendance.model.js';
import { activeMobilisationWorkerIds } from '../mobilisations/mobilisation.service.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import ApiError from '../../utils/ApiError.js';
import { hashPassword, generateTempPassword, revokeAllSessions } from '../auth/auth.service.js';
import { logAudit } from '../audit/audit.service.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

/**
 * A document counts as "needs attention" when it expires within this many
 * days (or already has). The client mirrors this constant for its badges —
 * if you change it, change client/src/lib/constants.js too.
 */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * Pay figures (2026-10-13, Section Access redesign): salary and the WPS
 * breakdown only ever leave the server for an actor holding `employeeFinancial`
 * Read (the controller resolves that once per request into `actor.canSeeFinancial`).
 * Everyone else gets the record without them plus `salaryOnFile`, so a screen
 * can say "salary recorded" without the number. Stripped here, in the service,
 * so the web, the phone and any future client all get the same answer.
 */
export const FINANCIAL_FIELDS = ['salary', 'basicSalary', 'housingAllowance', 'transportAllowance'];

export function redactFinancial(employee, actor) {
  if (actor?.canSeeFinancial) return employee;
  const copy = { ...employee, salaryOnFile: employee.salary != null };
  for (const field of FINANCIAL_FIELDS) delete copy[field];
  return copy;
}

/** `{ field: { from, to } }` for the submitted fields whose value really changed -
 *  what the Security Log keeps for an edit (the user chose old and new values).
 *  Long values are cut so one audit row stays small. */
export function changedValues(before, after, fields) {
  const show = (v) => {
    const text = v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
    return typeof text === 'string' && text.length > 200 ? `${text.slice(0, 200)}...` : text;
  };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed = {};
  for (const field of fields) {
    if (!same(before[field], after[field])) changed[field] = { from: show(before[field] ?? null), to: show(after[field] ?? null) };
  }
  return changed;
}

/**
 * A Coordinator may only see/act on employees assigned to them — the one
 * scoping rule this app enforces everywhere an Employee is the subject
 * (listEmployees, Attendance, Leave, ...). Added here as a single shared
 * export (2026-09-14, a real QA-audit-found gap) after Documents, Assets,
 * EOSB Settlements, and Deployment detail were all found reading/mutating
 * an arbitrary employee's records with no team check at all, despite the
 * employee's OWN profile correctly 403ing for the same Coordinator — every
 * one of those had grown its own copy-pasted (or entirely missing) version
 * of this exact check. No-op for every non-Coordinator actor; Admin's own
 * bypass lives in the STAFF_ROLES/Section-Access floor upstream of this,
 * unrelated to team scope.
 */
export async function assertEmployeeVisibleToActor(employeeId, actor) {
  if (!employeeId || actor?.role !== 'Coordinator') return;
  const owned = await Employee.exists({ _id: employeeId, coordinator: actor.userId });
  if (!owned) throw new ApiError(403, 'You do not have access to this employee.');
}

/** Fields the expiry-alert filter inspects. */
const EXPIRY_FIELDS = [
  'passport.expiry',
  'visa.expiry',
  'iqama.expiry',
  'medical.expiry',
  'drivingLicense.expiry',
];


/**
 * Paginated, searchable, sortable listing.
 * search       → case-insensitive match on name / employeeId / mobile / email
 * status       → exact match
 * alerts       → 'true' keeps only employees with a document expiring within
 *                thresholdDays (default EXPIRY_WARNING_DAYS), or already expired
 * thresholdDays→ override the alert window (P2-M2, customizable per viewer)
 * client       → only employees currently assigned to that client
 * team         → 'mine' (Manager only) — only employees under their coordinators
 * loginRole    → only employees whose OWN linked login has this role (e.g.
 *                'Worker' — Mobilisation's "Own Employee" picker needs real
 *                field workers, not any Own-type employee who happens to be
 *                staff for payroll purposes)
 * standby      → 'true' excludes anyone with a live `currentClient` OR a
 *                Draft/PendingReview/Approved Mobilisation already in
 *                flight for them (2026-10-03, a real user-reported gap: the
 *                "New mobilisation" Worker picker was offering employees who
 *                are already placed — selecting one would just 409 at submit
 *                time, since assertNoActivePlacement enforces the same "one
 *                active placement at a time" rule). Only passed by the New
 *                Mobilisation page; Edit always fetches unfiltered so the
 *                record's own already-placed worker stays selectable.
 *

 * Every returned item also carries `.login` (id/email/role/isActive, or
 * null) — same shape getEmployee already attaches, batched here into one
 * query rather than one per row — so a caller can distinguish login roles
 * itself without a second round-trip, independent of the loginRole filter.
 *
 * `actor` (role + userId) is optional so internal callers (e.g. a future
 * script) can still list company-wide; every HTTP call supplies it.
 */
export async function listEmployees(
  { page, limit, search, status, type, alerts, thresholdDays, client, team, createdByRole, loginRole, standby, sortBy, sortOrder },
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
  if (standby === 'true') {
    // currentClient catches an already-Approved placement; activeMobilisation
    // WorkerIds also catches a Draft/PendingReview one still awaiting approval
    // (currentClient isn't set until the Deployment is actually created) —
    // both must agree with assertNoActivePlacement's own definition of
    // "already has an active mobilisation", or the picker and the submit-time
    // guard would disagree — shared with mobilisation.service.js's own
    // listPreviousWorkers rather than a second independent copy of the query.
    const busyIds = await activeMobilisationWorkerIds();
    conditions.push({ currentClient: null, _id: { $nin: busyIds } });
  }
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
  if (loginRole) {
    const employeeIds = await User.find({ role: loginRole, employee: { $ne: null } }).distinct('employee');
    conditions.push({ _id: { $in: employeeIds } });
  }
  // 2026-10-13 (the user's Section Access redesign): everyone who may view the
  // register sees all of it, Coordinators included. They used to be narrowed to
  // their own team + standby workforce + labourers. Other modules' per-employee
  // checks (assertEmployeeVisibleToActor) are unchanged. A Manager may still
  // narrow to their coordinators' teams with team=mine.
  if (actor?.role === 'Manager' && team === 'mine') {
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

  // Same '.login' shape getEmployee already attaches (minimal, non-sensitive
  // fields — never the hash) — batched in one query rather than one per row,
  // so a caller can tell an office-staff Own employee apart from a real
  // Worker-login one without a second round-trip per row (see Mobilisation's
  // "Own Employee" picker, the reason this got added).
  const logins = await User.find({ employee: { $in: items.map((e) => e._id) } })
    .select('employee email role isActive')
    .lean();
  const loginByEmployeeId = new Map(logins.map((l) => [l.employee.toString(), l]));
  const withLogin = items.map((e) => {
    const login = loginByEmployeeId.get(e._id.toString());
    return redactFinancial(
      {
        ...e,
        login: login ? { id: login._id.toString(), email: login.email, role: login.role, isActive: login.isActive } : null,
      },
      actor
    );
  });

  return { items: withLogin, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
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
  // P2-M1: surface whether this employee has a login so the profile can show
  // account status (and hide "create login" once one exists) without a second
  // round-trip. Minimal, non-sensitive fields only — never the hash.
  const login = await User.findOne({ employee: id }).select('email role isActive').lean();
  employee.login = login
    ? { id: login._id.toString(), email: login.email, role: login.role, isActive: login.isActive }
    : null;
  return redactFinancial(employee, actor);
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
      'A login can only be created for an Own-type (internal staff) employee the self-service portal is not available to Outsourced or Subcontracted workers.'
    );
  }

  const existing = await User.findOne({ employee: employeeId }).lean();
  if (existing) throw new ApiError(409, 'This employee already has a login.');

  const loginEmail = email ?? employee.email;
  if (!loginEmail) {
    throw new ApiError(
      400,
      'This employee has no email on file add one, or provide an email for the login.'
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
  await revokeAllSessions(login._id);

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
  login.passwordChangedAt = new Date();
  // The real revocation signal for an already-issued access token — see
  // user.model.js's tokenVersion doc comment (F8, 2026-09-15).
  login.tokenVersion = (login.tokenVersion ?? 0) + 1;
  await login.save();
  await revokeAllSessions(login._id);

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
  // Salary is write-once for anyone without `employeeFinancial`: they may type
  // it when adding (an Outsourced employee needs one), but the response below
  // never shows it back. Coordinator is deliberately NOT auto-assigned here
  // (Milestone 5): a newly created employee always starts on standby
  // (coordinator: null) and only gets one once a real Mobilisation places
  // them. 2026-10-13: the old "a Coordinator can never create an Own record"
  // override is gone (the user's decision) - a Coordinator may add any type.
  const payload = { ...data, createdBy: actor.userId };
  await assertValidManager(payload.manager);
  await assertValidApprovalWorkflow(payload.approvalWorkflow);
  await assertValidSubcontractor(payload.subcontractor);
  const employee = await Employee.create(payload);
  await logAudit({
    user: actor.userId,
    action: 'employee.create',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { employeeId: employee.employeeId, fullName: employee.fullName, type: employee.type, designation: employee.designation },
    ip: actor.ip,
  });
  return redactFinancial(employee.toObject(), actor);
}

export async function updateEmployee(id, rawData, actor) {
  // Pay figures are changed only by someone who may see them; for everyone
  // else they are silently ignored so an edit form without those boxes works.
  const data = actor.canSeeFinancial ? rawData : Object.fromEntries(Object.entries(rawData).filter(([k]) => !FINANCIAL_FIELDS.includes(k)));
  if ('manager' in data) await assertValidManager(data.manager);
  if ('approvalWorkflow' in data) await assertValidApprovalWorkflow(data.approvalWorkflow);
  if ('subcontractor' in data) await assertValidSubcontractor(data.subcontractor);
  // Fetch + assign + save, NOT findByIdAndUpdate (fixed 2026-09-14, a real
  // QA-audit-found gap): Mongoose's update validators (`runValidators`)
  // don't reliably see the FULL merged document inside a conditional
  // `required: function(){...}` validator (requiredForWorkforce etc. above
  // — `this` inside an update validator isn't the same as it is during a
  // normal `.save()`). A PATCH that changed only `{ type: 'Subcontracted' }`
  // — nothing else — passed validation and saved, even though the schema
  // now requires `subcontractor`/`nationality`/`mobile` for that type and
  // none of them were present on the document. `.save()`'s validation runs
  // against the real, complete, merged document, which these conditional
  // validators need to work correctly.
  const employee = await Employee.findById(id);
  if (!employee) throw new ApiError(404, 'Employee not found.');
  const before = employee.toObject();
  Object.assign(employee, data);
  await employee.save();
  const after = employee.toObject();
  await logAudit({
    user: actor.userId,
    action: 'employee.update',
    targetType: 'Employee',
    targetId: employee._id,
    meta: {
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      fields: Object.keys(data),
      changes: changedValues(before, after, Object.keys(data)),
    },
    ip: actor.ip,
  });
  return redactFinancial(after, actor);
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
    await revokeAllSessions(login._id);
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
      type: employee.type,
      designation: employee.designation,
      loginRemoved: Boolean(login),
    },
    ip: actor.ip,
  });
}

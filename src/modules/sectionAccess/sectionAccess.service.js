/**
 * SectionAccess service — see the model's doc comment for the two-tier
 * (Read/Write) mechanism and for why login-role grants no longer exist here:
 * Approval Roles are the only grant type. `getSectionAccess`/
 * `canAccessSection` never throw "not configured" — a section nobody has
 * granted yet is simply Admin-only (see `defaultFor`).
 */
import SectionAccess, { SECTION_KEYS } from './sectionAccess.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { isMemberOfAnyRole } from '../approvals/approvals.service.js';
import { STAFF_ROLES } from '../../middleware/rbac.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

const SECTION_LABELS = {
  payroll: 'Payroll',
  expenses: 'Expenses',
  employeeCreate: 'Employees — view & add',
  companySettings: 'Company Settings',
  mobilisationsViewer: 'Mobilisations — full visibility',
  mobilisationsSelfMobilise: 'Mobilisations — self-mobilise',
  invoices: 'Invoices',
  eosb: 'EOSB / Settlements',
  financialRequests: 'Financial Requests',
  auditLog: 'Security Log',
  timesheetProcessor: 'Timesheet Processor',
  nfc: 'NFC Customers',
  clientsManage: 'Clients',
  deploymentsHours: 'Deployments — monthly hours & OT',
  deploymentsHoursDecide: 'Deployments — approve monthly hours',
  deploymentsRelease: 'Deployments — view & release',
  subcontractorsManage: 'Subcontractors',
  attendanceManage: 'Attendance',
  documentsManage: 'Documents',
  assetsManage: 'Assets',
  quotationsManage: 'Quotations',
  ramadanManage: 'Ramadan Periods',
  team: 'Team — staff logins',
  approvalHierarchy: 'Approval Hierarchy',
  leaveRequests: 'Leave requests',
  timesheetRequests: 'Timesheet requests',
  exitDocuments: 'Exit & Documents',
};

const SECTION_DESCRIPTIONS = {
  payroll: 'Read: view monthly runs and payslips. Write: create a run, edit a line, finalize, or delete.',
  expenses: 'Read: view the expense ledger. Write: record, edit, or delete an expense.',
  employeeCreate: 'Read: view the employee list and profiles. Write: create a new employee record — Admin only until you grant someone else this specifically.',
  companySettings: "Read/Write: viewing and editing the company's legal/contact/bank identity and logo — printed on every generated document.",
  mobilisationsViewer: 'Read-only access to every mobilisation once submitted (not while still a Draft), including commercial fields. No write action is tied to this key.',
  mobilisationsSelfMobilise: 'Write-only: can create a mobilisation directly as its own primary coordinator. Coordinators are granted this via the Coordinator approval role by default. Viewing a mobilisation is governed separately (coordinator, or the Mobilisations — full visibility key above).',
  invoices: 'Read: view invoices. Write: create an invoice or record a payment. Deleting one stays Admin/Manager only regardless.',
  eosb: 'Read: view End of Service settlements. Write: compute/create or delete one.',
  financialRequests: 'Read/Write: deciding a salary advance or reimbursement request. Viewing the queue and submitting a request stay open to any staff role, unchanged — this key only governs the decide action.',
  auditLog: 'Read-only: the auth & CRUD audit trail — who did what, and when. There is no write action.',
  timesheetProcessor: 'Read/Write: bulk-importing attendance-device exports (a stateless tool — no separate viewing exists beyond running it).',
  nfc: 'Read: view companies, cards, and batches. Write: create, edit, assign, or delete them.',
  clientsManage: 'Read: view the client list. Write: create/edit a client, and decide one a Coordinator submitted. Deleting stays Admin/Manager only regardless.',
  deploymentsHours: 'Write-only: entering or correcting a month\'s actual client-timesheet hours and OT amount. Office Secretary always has this, regardless of this setting. Viewing the register is governed by "Deployments — view & release" below.',
  deploymentsHoursDecide: 'Write-only: approving or rejecting a month\'s entered hours (e.g. Marketing Manager). Separate from "Deployments — monthly hours & OT" above — whoever enters hours is never automatically who approves them. Admin only until granted.',
  deploymentsRelease: 'Read: view the deployments register. Write: release a worker (ends the deployment and frees them for a new mobilisation).',
  subcontractorsManage: 'Read: view the subcontractor list. Write: create, edit, or delete one.',
  attendanceManage: 'Read: view/export attendance records. Write: bulk-mark or adjust a record.',
  documentsManage: 'Read: view/download documents. Write: upload, version, or delete one.',
  assetsManage: 'Read: view the asset register. Write: create, edit, assign, or return an asset. Deleting stays Admin/HR only regardless.',
  quotationsManage: 'Read: view/PDF a quotation. Write: create, edit, or duplicate one. Deleting stays Admin/Manager only regardless.',
  ramadanManage: 'Read: view the Ramadan calendar. Write: create, edit, or delete a period.',
  team: 'Read-only: viewing the staff login list. Editing a login, resetting its password, or deleting it stays Admin only — too sensitive to delegate broadly; there is no write tier for this key.',
  approvalHierarchy: 'Read: view approval roles/workflows (many pages already depend on this being readable — narrowing it can break those). Write: create or edit an approval role or workflow.',
  leaveRequests: 'Read/Write: viewing, submitting, and deciding leave requests. Optional — matches the existing wide-open default until narrowed.',
  timesheetRequests: 'Read/Write: viewing, submitting, deciding, and bulk-approving timesheets. Optional — matches the existing wide-open default until narrowed.',
  exitDocuments: 'Read/Write: viewing, submitting, and deciding exit re-entry visa and certificate requests. Optional — matches the existing wide-open default until narrowed.',
};

function defaultFor(sectionKey) {
  return { sectionKey, readApprovalRoles: [], writeApprovalRoles: [] };
}

export async function getSectionAccess(sectionKey) {
  const doc = await SectionAccess.findOne({ sectionKey }).lean();
  return doc ?? defaultFor(sectionKey);
}

/** Every governed section's current settings, populated for the admin UI —
 *  always returns one row per SECTION_KEYS entry, defaulted ones included. */
export async function listSectionAccess() {
  const docs = await SectionAccess.find({})
    .populate('readApprovalRoles', 'name')
    .populate('writeApprovalRoles', 'name')
    .lean();
  const bySectionKey = new Map(docs.map((d) => [d.sectionKey, d]));
  return SECTION_KEYS.map((key) => ({
    ...(bySectionKey.get(key) ?? defaultFor(key)),
    sectionKey: key,
    label: SECTION_LABELS[key],
    description: SECTION_DESCRIPTIONS[key],
  }));
}

/**
 * Worker/Staff/Office Secretary are excluded outright by this first line,
 * regardless of configuration — the same floor requireStaff enforces
 * everywhere else (Executive is separately allow-listed right after,
 * matching requireStaffOrExecutive's own shape); this mechanism only ever
 * ADDS access on top of it, never bypasses it. Office Secretary in
 * particular stays unreachable here even if an Admin puts her in an
 * Approval Role that's granted a section — this role check runs first and
 * already returns false for her before any Approval Role membership is
 * even looked up, so she still only ever reaches a specific record through
 * a workflow step, never a blanket section grant. Admin always passes
 * beyond this floor (so an Admin can never configure themselves out of a
 * section they built).
 *
 * `level` picks the tier: `'write'` (default) checks only the write grant;
 * `'read'` checks the write grant too (write always implies read — a write
 * grantee never needs to be listed in both places) OR the read grant.
 * Shared by requireSectionAccess (the route gate) and the "mine" endpoint
 * (a button's "should I even show this" check) so the floor only lives in
 * one place.
 */
export async function canAccessSection(sectionKey, actor, level = 'write') {
  if (!STAFF_ROLES.includes(actor.role) && actor.role !== 'Executive') return false;
  if (actor.role === 'Admin') return true;
  const settings = await getSectionAccess(sectionKey);

  const hasWrite = settings.writeApprovalRoles.length > 0 && (await isMemberOfAnyRole(actor.userId, settings.writeApprovalRoles));
  if (hasWrite) return true;
  if (level !== 'read') return false;

  return settings.readApprovalRoles.length > 0 && (await isMemberOfAnyRole(actor.userId, settings.readApprovalRoles));
}

/** Every section this actor can at least read, and the (smaller) subset
 *  they can write to — for `user.sectionAccess` (read, drives nav
 *  visibility) and `user.sectionAccessWrite` (write, drives action
 *  buttons) in the login/refresh response. One DB read per section
 *  regardless of tier count — Admin short-circuits without touching the
 *  database at all, same as canAccessSection does per-call. */
export async function getMySectionAccess(actor) {
  if (!STAFF_ROLES.includes(actor.role) && actor.role !== 'Executive') return { read: [], write: [] };
  if (actor.role === 'Admin') return { read: [...SECTION_KEYS], write: [...SECTION_KEYS] };

  const read = [];
  const write = [];
  for (const key of SECTION_KEYS) {
    const settings = await getSectionAccess(key);
    const hasWrite = settings.writeApprovalRoles.length > 0 && (await isMemberOfAnyRole(actor.userId, settings.writeApprovalRoles));
    if (hasWrite) {
      write.push(key);
      read.push(key);
      continue;
    }
    const hasRead = settings.readApprovalRoles.length > 0 && (await isMemberOfAnyRole(actor.userId, settings.readApprovalRoles));
    if (hasRead) read.push(key);
  }
  return { read, write };
}

async function assertValidApprovalRoles(roleIds) {
  if (!roleIds?.length) return;
  const count = await ApprovalRole.countDocuments({ _id: { $in: roleIds }, isActive: true });
  if (count !== new Set(roleIds.map(String)).size) {
    throw new ApiError(400, 'One or more selected approval roles are invalid or inactive.');
  }
}

/** Admin-only (enforced by the route) — deciding who else can open a
 *  section is not itself delegable to whoever that grant creates. */
export async function updateSectionAccess(sectionKey, { readApprovalRoles, writeApprovalRoles }, actor) {
  if (!SECTION_KEYS.includes(sectionKey)) throw new ApiError(404, 'Unknown section.');
  await assertValidApprovalRoles(readApprovalRoles);
  await assertValidApprovalRoles(writeApprovalRoles);

  const settings = await SectionAccess.findOneAndUpdate(
    { sectionKey },
    { sectionKey, readApprovalRoles, writeApprovalRoles },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .populate('readApprovalRoles', 'name')
    .populate('writeApprovalRoles', 'name')
    .lean();

  await logAudit({
    user: actor.userId,
    action: 'sectionAccess.update',
    targetType: 'SectionAccess',
    targetId: settings._id,
    meta: {
      sectionKey,
      readApprovalRoleCount: readApprovalRoles?.length ?? 0,
      writeApprovalRoleCount: writeApprovalRoles?.length ?? 0,
    },
    ip: actor.ip,
  });
  return { ...settings, label: SECTION_LABELS[sectionKey], description: SECTION_DESCRIPTIONS[sectionKey] };
}

/**
 * SectionAccess service — see the model's doc comment for the mechanism.
 * `getSectionAccess`/`canAccessSection` never throw "not configured": a
 * section nobody has touched yet falls back to DEFAULT_ALLOWED_ROLES, the
 * same "found-or-created default" posture CompanySettings uses.
 */
import SectionAccess, { SECTION_KEYS } from './sectionAccess.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { isMemberOfAnyRole } from '../approvals/approvals.service.js';
import { STAFF_ROLES } from '../../middleware/rbac.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/** The floor before an Admin ever opens the new settings screen — preserves
 *  each section's real pre-existing operational owner (Accounts already
 *  touched both Payroll and Expenses) while Manager/HR no longer get in by
 *  default now that this is admin-configurable per section. `employeeCreate`
 *  defaults to nobody but Admin — "until then only admin can add employees,"
 *  the user's own words when asking for this. */
const DEFAULT_ALLOWED_ROLES = {
  payroll: ['Accounts'],
  expenses: ['Accounts'],
  employeeCreate: [],
  companySettings: ['Manager'],
  mobilisationsViewer: [],
  mobilisationsSelfMobilise: ['Coordinator'],
  invoices: ['Manager', 'Accounts'],
  eosb: ['Manager', 'HR', 'Accounts'],
  // Wider than the other whole-module defaults on purpose: DECIDE (the only
  // action this key governs — see financialRequests.routes.js) sits in
  // front of the shared approvalEngine's own per-step authority check,
  // which can legitimately authorize ANY staff role (e.g. a Coordinator
  // who is a real ApprovalRole member on a configured workflow step,
  // exactly like the company's real Mobilisation hierarchy already does).
  // A narrower floor here would silently block a workflow-authorized
  // decider before the engine ever runs — so this matches the full
  // original requireStaffOrExecutive floor exactly (Coordinator included),
  // preserving zero regression; an Admin can still narrow it deliberately.
  financialRequests: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
  auditLog: [],
  timesheetProcessor: [],
  nfc: [],
  clientsManage: ['Manager', 'Coordinator'],
  // Office Secretary is a hardcoded exception INSIDE addMonthlyHours/
  // updateMonthlyHours (deployment.service.js), same pattern as
  // mobilisation.service.js's createMobilisation — not expressible here
  // since Office Secretary is deliberately excluded from GRANTABLE_ROLES.
  deploymentsHours: [],
  deploymentsRelease: ['Coordinator', 'Manager'],
  subcontractorsManage: ['Manager'],
  attendanceManage: ['Manager', 'HR'],
  documentsManage: ['Manager', 'HR'],
  assetsManage: ['Manager', 'HR'],
  quotationsManage: ['Manager', 'Accounts'],
  ramadanManage: ['Manager', 'HR'],
  team: ['Manager', 'HR'],
  approvalHierarchy: [],
  // M7 (optional zero-regression floor migration): these three routers were
  // already uniformly gated by requireStaffOrExecutive for EVERY action
  // (list/submit/decide, no per-route carve-out needed, unlike
  // financialRequests above) — so the default here matches that floor's
  // full reach exactly, changing nothing until an Admin narrows it.
  leaveRequests: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
  timesheetRequests: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
  exitDocuments: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
};

const SECTION_LABELS = {
  payroll: 'Payroll',
  expenses: 'Expenses',
  employeeCreate: 'Adding employees',
  companySettings: 'Company Settings',
  mobilisationsViewer: 'Mobilisations — full visibility',
  mobilisationsSelfMobilise: 'Mobilisations — self-mobilise',
  invoices: 'Invoices',
  eosb: 'EOSB / Settlements',
  financialRequests: 'Financial Requests',
  auditLog: 'Security Log',
  timesheetProcessor: 'Timesheet Processor',
  nfc: 'NFC Customers',
  clientsManage: 'Clients — create/edit/decide',
  deploymentsHours: 'Deployments — enter monthly client hours & OT',
  deploymentsRelease: 'Deployments — release a worker',
  subcontractorsManage: 'Subcontractors — create/edit/delete',
  attendanceManage: 'Attendance — bulk mark/adjust',
  documentsManage: 'Documents — upload/version/delete',
  assetsManage: 'Assets — create/edit/assign',
  quotationsManage: 'Quotations — create/edit',
  ramadanManage: 'Ramadan Periods — create/edit',
  team: 'Team — view staff logins',
  approvalHierarchy: 'Approval Hierarchy — edit roles & workflows',
  leaveRequests: 'Leave requests — review queue',
  timesheetRequests: 'Timesheet requests — review queue',
  exitDocuments: 'Exit & Documents — review queue',
};

const SECTION_DESCRIPTIONS = {
  payroll: 'Monthly runs, payslips, and finalizing a period.',
  expenses: 'Recording and managing the company expense ledger.',
  employeeCreate: 'Creating a new employee record — Admin only until you grant someone else this specifically.',
  companySettings: "Editing the company's legal/contact/bank identity and logo — printed on every generated document.",
  mobilisationsViewer:
    'Read-only access to every mobilisation once submitted (not while still a Draft), including commercial fields.',
  mobilisationsSelfMobilise:
    'Can create a mobilisation directly as its own primary coordinator. Coordinator logins are granted this by default, but it can be changed here.',
  invoices: 'Viewing and creating invoices, and recording payments against them. Deleting one stays Admin/Manager only.',
  eosb: 'Computing and viewing End of Service settlements.',
  financialRequests: 'Deciding a salary advance or reimbursement request. Viewing the queue and submitting a request stay open to any staff role, unchanged.',
  auditLog: 'The auth & CRUD audit trail — who did what, and when.',
  timesheetProcessor: 'Bulk-importing attendance-device exports.',
  nfc: 'The NFC business-card program — companies, cards, and batches.',
  clientsManage: 'Creating/editing a client, and deciding one a Coordinator submitted. Everyone can still read the list; deleting stays Admin/Manager only.',
  deploymentsHours: "Entering or correcting a month's actual client-timesheet hours and OT amount. Office Secretary always has this, regardless of this setting. Everyone can still read the register.",
  deploymentsRelease: 'Releasing a worker off a deployment (ends it and frees them for a new mobilisation). Everyone can still read the register.',
  subcontractorsManage: 'Creating, editing, or deleting a subcontractor. Everyone can still read the list.',
  attendanceManage: 'Bulk-marking or adjusting attendance records. Everyone can still read/export the register.',
  documentsManage: 'Uploading, versioning, or deleting a document. Everyone can still read/download.',
  assetsManage: 'Creating, editing, assigning or returning an asset. Everyone can still read the register; deleting stays Admin/HR only.',
  quotationsManage: 'Creating, editing, or duplicating a quotation. Everyone can still read/PDF; deleting stays Admin/Manager only.',
  ramadanManage: 'Creating, editing, or deleting a Ramadan overtime period. Everyone can still read the list.',
  team: 'Viewing the staff login list. Editing a login, resetting its password, or deleting it stays Admin only — too sensitive to delegate broadly.',
  approvalHierarchy: 'Creating or editing an approval role or workflow. Everyone can still read the list — many pages depend on it.',
  leaveRequests: 'Viewing, submitting, and deciding leave requests. Optional — matches the existing wide-open default until narrowed.',
  timesheetRequests: 'Viewing, submitting, deciding, and bulk-approving timesheets. Optional — matches the existing wide-open default until narrowed.',
  exitDocuments: 'Viewing, submitting, and deciding exit re-entry visa and certificate requests. Optional — matches the existing wide-open default until narrowed.',
};

function defaultFor(sectionKey) {
  return { sectionKey, allowedRoles: DEFAULT_ALLOWED_ROLES[sectionKey] ?? [], allowedApprovalRoles: [] };
}

export async function getSectionAccess(sectionKey) {
  const doc = await SectionAccess.findOne({ sectionKey }).lean();
  return doc ?? defaultFor(sectionKey);
}

/** Every governed section's current settings, populated for the admin UI —
 *  always returns one row per SECTION_KEYS entry, defaulted ones included. */
export async function listSectionAccess() {
  const docs = await SectionAccess.find({}).populate('allowedApprovalRoles', 'name').lean();
  const bySectionKey = new Map(docs.map((d) => [d.sectionKey, d]));
  return SECTION_KEYS.map((key) => ({
    ...(bySectionKey.get(key) ?? defaultFor(key)),
    sectionKey: key,
    label: SECTION_LABELS[key],
    description: SECTION_DESCRIPTIONS[key],
  }));
}

/**
 * Worker/Staff (the ESS self-service personas) are excluded outright,
 * regardless of configuration — the same floor requireStaff/
 * requireStaffOrExecutive enforce everywhere else; this mechanism only ever
 * ADDS access on top of it, never bypasses it. Admin always passes beyond
 * that floor (so an Admin can never configure themselves out of a section
 * they built). Beyond both: a literal role match in `allowedRoles`, or real
 * ApprovalRole membership in `allowedApprovalRoles` — same membership check
 * the Configurable Approval Hierarchy engine uses. Shared by
 * requireSectionAccess (the route gate) and the "mine" endpoint (a button's
 * "should I even show this" check) so the floor only lives in one place.
 */
export async function canAccessSection(sectionKey, actor) {
  if (!STAFF_ROLES.includes(actor.role) && actor.role !== 'Executive') return false;
  if (actor.role === 'Admin') return true;
  const settings = await getSectionAccess(sectionKey);
  if (settings.allowedRoles.includes(actor.role)) return true;
  if (settings.allowedApprovalRoles.length) {
    return isMemberOfAnyRole(actor.userId, settings.allowedApprovalRoles);
  }
  return false;
}

export async function getMySectionAccess(actor) {
  const allowed = [];
  for (const key of SECTION_KEYS) {
    if (await canAccessSection(key, actor)) {
      allowed.push(key);
    }
  }
  return allowed;
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
export async function updateSectionAccess(sectionKey, { allowedRoles, allowedApprovalRoles }, actor) {
  if (!SECTION_KEYS.includes(sectionKey)) throw new ApiError(404, 'Unknown section.');
  await assertValidApprovalRoles(allowedApprovalRoles);

  const settings = await SectionAccess.findOneAndUpdate(
    { sectionKey },
    { sectionKey, allowedRoles, allowedApprovalRoles },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .populate('allowedApprovalRoles', 'name')
    .lean();

  await logAudit({
    user: actor.userId,
    action: 'sectionAccess.update',
    targetType: 'SectionAccess',
    targetId: settings._id,
    meta: { sectionKey, allowedRoles, approvalRoleCount: allowedApprovalRoles?.length ?? 0 },
    ip: actor.ip,
  });
  return { ...settings, label: SECTION_LABELS[sectionKey], description: SECTION_DESCRIPTIONS[sectionKey] };
}

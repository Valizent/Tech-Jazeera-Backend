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
  deploymentsEdit: 'Deployments — edit details',
  subcontractorsManage: 'Subcontractors',
  attendanceRecords: 'Attendance — records',
  attendanceSignInOut: 'Attendance — sign in/out',
  attendanceOfficeLocation: 'Attendance — office location',
  documentsManage: 'Documents',
  assetsManage: 'Assets',
  quotationsManage: 'Quotations',
  ramadanManage: 'Ramadan Periods',
  team: 'Team — staff logins',
  approvalHierarchy: 'Approval Hierarchy',
  leaveRequests: 'Leave requests',
  timesheetRequests: 'Timesheet requests',
  exitDocuments: 'Exit & Documents',
  holidays: 'Holidays',
  dashboardProfit: 'Dashboard — company profit figure',
  reconciliation: 'Data Reconciliation',
  dailyUpdatesOwn: 'Daily Updates — my own tasks & log',
  dailyUpdatesTeam: 'Daily Updates — every coordinator (oversight & assigning)',
  requirementsOwn: 'Requirements — my own board',
  requirementsTeam: 'Requirements — every coordinator (oversight & assigning)',
  requirementStages: 'Requirements — board stages',
};

/** What each section IS FOR, in plain English — not what Read/Write
 *  mechanically do (that's the same two generic lines under every card's
 *  Read/Write checklist already, see SectionCard/TierChecklist on the
 *  client). Replaced the old Read/Write-mechanics phrasing entirely per the
 *  user's own instruction 2026-09-13 (a couple of section-specific caveats
 *  that used to live here — e.g. "Office Secretary always has this
 *  regardless of this setting", "deleting stays Admin/Manager only
 *  regardless" — are a real, deliberate trade-off of that: still true, just
 *  no longer written down at this specific spot; see each route file's own
 *  doc comment for the underlying rule). */
const SECTION_DESCRIPTIONS = {
  payroll: 'Grants access to run monthly payroll and view payslips. It exists to ensure workers are paid accurately based on approved hours and deductions.',
  expenses: 'Grants access to the company\'s internal expense ledger. It is here to track and record spending that is not billed to a client.',
  employeeCreate: 'Grants access to the employee directory. It exists so HR or management can add new workers, view profiles, and manage sensitive records.',
  companySettings: 'Grants access to edit the company\'s legal, contact, and bank details. It is here so only authorized personnel can change the details printed on official documents.',
  mobilisationsViewer: 'Grants full visibility into submitted mobilisations (including commercial rates). It exists to let management oversee active deals and margins without allowing them to create new ones.',
  mobilisationsSelfMobilise: 'Grants the ability to create a new mobilisation. It is here for coordinators to officially place a worker with a client.',
  invoices: 'Grants access to generate and view client invoices. It exists so finance can bill clients for work done and record received payments.',
  eosb: 'Grants access to calculate End of Service settlements. It is here to ensure departing workers receive their correct final payouts according to labor laws.',
  financialRequests: 'Grants access to decide salary advances and expense reimbursements. It exists so authorized managers can approve or reject financial asks from workers.',
  auditLog: 'Grants access to the system security log. It is here for strict oversight, recording every login and data change made by staff.',
  timesheetProcessor: 'Grants access to bulk-import external attendance data. It exists to automate pulling time-clock records into the system for payroll processing.',
  nfc: 'Grants access to manage the NFC business-card program. It is here to assign, track, and update physical NFC cards handed out to staff.',
  clientsManage: 'Grants access to the client directory. It exists to manage the companies your workers are placed with and store their contact details.',
  deploymentsHours: 'Grants access to enter monthly client-timesheet hours. It is here so coordinators can record exactly how much a worker worked before payroll.',
  deploymentsHoursDecide: 'Grants access to review and approve entered deployment hours. It exists as a financial safeguard before hours are finalized and sent to Payroll.',
  deploymentsRelease: 'Grants access to the deployments register and standby list. It is here to track which worker is placed where, and to end active placements.',
  deploymentsEdit: 'Grants access to correct a deployment\'s core details (like site, or hours). It exists to fix mistakes after a deployment is generated from a mobilisation.',
  subcontractorsManage: 'Grants access to the subcontractor directory. It is here to manage the outside companies that mobilisations are sometimes routed through.',
  attendanceRecords: 'Grants access to view and correct the day-by-day attendance grid. It exists to ensure everyone\'s daily hours are accurate before timesheets are generated.',
  attendanceSignInOut: 'Grants access to the staff self-service sign-in/out kiosk. It is here to allow staff to punch their own daily attendance and oversee others.',
  attendanceOfficeLocation: 'Grants access to set the office geofence. It exists to verify that staff are physically at the office when they mark their attendance.',
  documentsManage: 'Grants access to the company and employee document store. It is here to safely upload, track, and preview important files and their versions.',
  assetsManage: 'Grants access to the company asset register. It exists to track valuable equipment (like laptops or tools) issued to employees.',
  quotationsManage: 'Grants access to create pricing quotes for clients. It is here to establish commercial terms before any invoice is generated.',
  ramadanManage: 'Grants access to configure the Ramadan work-hour calendar. It exists to accurately calculate adjusted overtime limits during the holy month.',
  team: 'Grants access to the list of staff logins and roles. It is here so admins can oversee who has an account and what system role they hold.',
  approvalHierarchy: 'Grants access to build multi-step approval workflows. It exists to define exactly which managers must sign off on different types of requests.',
  leaveRequests: 'Grants access to manage worker leave requests. It is here to track vacations or sick days from initial submission through final approval.',
  timesheetRequests: 'Grants access to manage weekly timesheets. It exists so workers can submit their hours and managers can formally approve them.',
  exitDocuments: 'Grants access to exit visas and certificates. It is here to manage the paperwork needed when an employee officially leaves the company.',
  holidays: 'Grants access to the company holiday calendar. It exists to define public holidays so they are automatically accounted for in payroll and attendance.',
  dashboardProfit: 'Grants access to the dashboard\'s true monthly profit figure. It is here so executives can see the company margin without needing raw access to every invoice and payslip.',
  reconciliation: 'Grants access to the data integrity report. It exists to flag mismatched ledger totals, double-booked workers, or missing deployments.',
  dailyUpdatesOwn: 'Grants access to a coordinator\'s personal work log. It is here so they can track their own to-do list and report daily tasks.',
  dailyUpdatesTeam: 'Grants access to oversee every coordinator\'s daily log. It exists so management can assign tasks globally and monitor team productivity.',
  requirementsOwn: 'Grants access to a coordinator\'s personal client-requirements board. It is here so they can track deals that are in progress but not yet mobilised.',
  requirementsTeam: 'Grants access to oversee all client requirements. It exists so management can monitor the entire sales pipeline, assign coordinators, and receive stage notifications.',
  requirementStages: 'Grants access to configure the columns on the requirements board. It is here to customize the sales pipeline stages (Read is already open to everyone).',
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
 * Worker/Staff are excluded outright by this first line, regardless of
 * configuration — the same floor requireStaff enforces everywhere else
 * (Executive is separately allow-listed right after, matching
 * requireStaffOrExecutive's own shape); this mechanism only ever ADDS
 * access on top of it, never bypasses it. Office Secretary passes this
 * floor like any other staff role since 2026-09-13 (see rbac.js's own doc
 * comment on STAFF_ROLES) — a real Approval Role grant now genuinely works
 * for her, same as for Coordinator/HR/Manager/Accounts; she's just as
 * unreachable as anyone else on a section she hasn't actually been granted.
 * Admin always passes beyond this floor (so an Admin can never configure
 * themselves out of a section they built).
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

/**
 * Every section this actor can at least read, and the (smaller) subset
 * they can write to — for `user.sectionAccess` (read, drives nav
 * visibility) and `user.sectionAccessWrite` (write, drives action
 * buttons) in the login/refresh response — called on every login AND every
 * token refresh, so its cost is paid constantly.
 *
 * Batched (fixed 2026-09-15, a real QA-audit-found perf issue): the naive
 * per-key loop this replaced ran up to 2 queries PER SECTION_KEY (one
 * SectionAccess read, up to one ApprovalRole membership check) — measured
 * at 45 queries / ~140ms for a company this size, on the hottest path in
 * the app. Now exactly 2 queries total, independent of how many section
 * keys exist: every SectionAccess document at once, then a single
 * ApprovalRole query for which of the roles referenced ANYWHERE across all
 * of them this actor is an ACTIVE member of — everything else below is an
 * in-memory Set lookup. Still queries fresh on every call (nothing is
 * cached beyond this one request) — an Admin revoking a grant mid-session
 * still takes effect on that user's very next request, unchanged.
 */
export async function getMySectionAccess(actor) {
  if (!STAFF_ROLES.includes(actor.role) && actor.role !== 'Executive') return { read: [], write: [] };
  if (actor.role === 'Admin') return { read: [...SECTION_KEYS], write: [...SECTION_KEYS] };

  const docs = await SectionAccess.find({}).lean();
  const bySectionKey = new Map(docs.map((d) => [d.sectionKey, d]));

  const allRoleIds = new Set();
  for (const doc of docs) {
    for (const id of doc.readApprovalRoles) allRoleIds.add(id.toString());
    for (const id of doc.writeApprovalRoles) allRoleIds.add(id.toString());
  }

  const myRoles = allRoleIds.size
    ? await ApprovalRole.find({ _id: { $in: [...allRoleIds] }, members: actor.userId, isActive: true })
        .select('_id')
        .lean()
    : [];
  const myRoleIds = new Set(myRoles.map((r) => r._id.toString()));

  const read = [];
  const write = [];
  for (const key of SECTION_KEYS) {
    const settings = bySectionKey.get(key) ?? defaultFor(key);
    const hasWrite = settings.writeApprovalRoles.some((id) => myRoleIds.has(id.toString()));
    if (hasWrite) {
      write.push(key);
      read.push(key);
      continue;
    }
    const hasRead = settings.readApprovalRoles.some((id) => myRoleIds.has(id.toString()));
    if (hasRead) read.push(key);
  }
  return { read, write };
}

/**
 * The four booleans a module governed by an OWN/TEAM key pair needs — Read
 * and Write on the actor's own-workspace key, and on the every-coordinator
 * oversight key. One shared place (Daily Updates and Requirements both use
 * it) so the two modules can't drift apart on how a grant is read; a single
 * getMySectionAccess call, exactly 2 queries regardless of the keys asked for.
 */
export async function resolveOwnTeamAccess(actor, ownKey, teamKey) {
  const { read, write } = await getMySectionAccess({ userId: actor.userId, role: actor.role });
  return {
    ownRead: read.includes(ownKey),
    ownWrite: write.includes(ownKey),
    teamRead: read.includes(teamKey),
    teamWrite: write.includes(teamKey),
  };
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

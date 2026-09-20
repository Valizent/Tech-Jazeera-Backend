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
  payroll: "The company's monthly payroll runs and worker payslips.",
  expenses: 'The company\'s internal expense ledger — spending not billed to a client.',
  employeeCreate: "The employee directory: every worker's profile, records, and documents, plus adding a new one.",
  companySettings: "The company's own legal identity, contact and bank details, logo, and signatory — printed on every generated document.",
  mobilisationsViewer: 'Full visibility into every mobilisation once submitted, commercial rates and margins included.',
  mobilisationsSelfMobilise: 'Creating a new mobilisation directly as its own primary coordinator.',
  invoices: 'Client invoices generated from approved quotations, and the payments recorded against them.',
  eosb: 'End of Service settlement calculations for an employee who is exiting the company.',
  financialRequests: "Deciding a worker's salary advance or expense reimbursement request.",
  auditLog: 'The company\'s security log — a record of every login and data change, for oversight.',
  timesheetProcessor: 'Bulk-importing attendance from an external time-clock device export.',
  nfc: 'The NFC business-card program — companies, cards, and batches.',
  clientsManage: 'The client directory — companies your workers are placed with.',
  deploymentsHours: "Entering a month's client-timesheet hours and overtime for an active deployment.",
  deploymentsHoursDecide: "Reviewing, and approving or rejecting, a month's entered deployment hours before they reach Payroll.",
  deploymentsRelease: 'The deployments register — which worker is placed where — and ending an active placement.',
  deploymentsEdit: 'Correcting a deployment\'s own recorded details — site, worker name, contracted hours, and notes — after it was created from an approved mobilisation.',
  subcontractorsManage: 'The subcontractor directory — outside companies a mobilisation is sometimes routed through.',
  attendanceRecords: 'The day-by-day attendance grid for every worker, and correcting a day.',
  attendanceSignInOut: "Staff self-service sign-in/out — your own daily attendance punch, plus oversight of everyone else's.",
  attendanceOfficeLocation: "The office location and geofence a Worker's self-marked attendance is checked against.",
  documentsManage: 'The company and employee document store — uploads, versions, and previews.',
  assetsManage: 'The company asset register — equipment issued to employees.',
  quotationsManage: 'Pricing sent to a client before an invoice exists.',
  ramadanManage: 'The Ramadan work-hour calendar used to calculate overtime during Ramadan.',
  team: 'The list of staff logins and their roles.',
  approvalHierarchy: "The company's approval roles and the multi-step workflows built from them.",
  leaveRequests: "A worker's leave requests, from submission through approval.",
  timesheetRequests: 'Weekly timesheets submitted for approval.',
  exitDocuments: 'Exit re-entry visa and certificate requests.',
  holidays: 'The company holiday calendar.',
  dashboardProfit: "The dashboard's real monthly profit figure (revenue minus payroll cost minus expenses) — without granting the underlying Invoices/Payroll/Expenses sections themselves.",
  reconciliation: 'A standing integrity report: ledger totals that no longer add up, an Approved mobilisation with no deployment, a placement double-booked.',
  dailyUpdatesOwn: "A coordinator's own daily work log and to-do list — including any task a manager assigns to them. Read is seeing them; Write is adding entries and ticking tasks off.",
  dailyUpdatesTeam: "Every coordinator's daily log and tasks. Read is seeing them all; Write is also assigning a task to any coordinator and editing, ticking off or deleting anyone's entries.",
  requirementsOwn: "The requirements a coordinator is working on — client asks that have come in but aren't mobilised yet. Read is seeing your own cards; Write is adding requirements, editing and moving your own cards, and writing updates on them.",
  requirementsTeam: "Every coordinator's requirements. Read is seeing them all; Write is also assigning coordinators to a requirement and editing, moving or deleting anyone's. Members are also notified when a card reaches a stage marked \"notify\".",
  requirementStages: 'The columns of the requirements board — adding, renaming, reordering and removing stages. Only Write matters here; every board user already sees the stages.',
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

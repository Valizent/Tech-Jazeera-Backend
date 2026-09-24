/**
 * Dashboard service — one aggregation across every module for the management
 * overview. It adds no data of its own; it reads employees, clients,
 * deployments, quotations, documents and the audit log and rolls them up.
 *
 * Every independent query is fired in parallel (Promise.all) rather than
 * awaited one at a time — but "parallel" is not "free": a full Admin load is
 * still a real ~30+ separate database operations (reproduced and fixed down
 * from 36 on 2026-09-22, a real QA-audit finding — P3; see getMySectionAccess
 * below and getProfitOverview's own doc comment for the two biggest cuts).
 * Corrected 2026-09-22 — this comment previously claimed "one fast round
 * trip," which undersold that real count and was itself a finding in that
 * same audit.
 *
 * HONESTY NOTE (updated P2-M8): Phase 1 had no cost data, so this module
 * originally reported only approved-quotation revenue and a payroll
 * run-rate estimate, never a fabricated profit number. Now that Invoices
 * (P2-M6), finalized Payroll (P2-M5) and Expenses (P2-M7) all exist, a real
 * profit figure — actual billed revenue minus actual payroll cost minus
 * actual expenses, for a real calendar month — is finally honest to show;
 * see getProfitOverview() below and finance.profit.
 */
import mongoose from 'mongoose';
import Employee, { WORKFORCE_TYPES } from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import Deployment from '../deployments/deployment.model.js';
import Quotation from '../quotations/quotation.model.js';
import Document from '../documents/document.model.js';
import AuditLog from '../audit/audit.model.js';
import Attendance from '../attendance/attendance.model.js';
import PayrollRun from '../payroll/payrollRun.model.js';
import Invoice from '../invoices/invoice.model.js';
import Expense from '../expenses/expense.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import ReimbursementClaim from '../financialRequests/reimbursement.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import { toUtcDay } from '../attendance/attendance.service.js';
import { annotateCanDecide, roleIdsNeededAcross } from '../approvals/approvalEngine.service.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { canAccessSection, getMySectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { countStaleRequirements } from '../requirements/requirement.service.js';
import { countOpenTasks } from '../dailyUpdates/dailyUpdate.service.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import ExitReentry from '../exitDocuments/exitReentry.model.js';
import { getStandbyWorkforce } from '../deployments/deployment.service.js';
import User from '../auth/user.model.js';
import { monthBounds } from '../mobilisationTargets/mobilisationTarget.service.js';
import ApiError from '../../utils/ApiError.js';

export const EXPIRY_WARNING_DAYS = 30;
const TREND_MONTHS = 6;

/** "YYYY-MM" → { year, month (1-12), start, end } in UTC. Falls back to the
 *  current calendar month for anything missing/malformed — the query schema
 *  already rejects a malformed string before this runs, so this is really
 *  just the "no month given" default path. */
function resolveMonth(monthStr) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1; // 1-12
  if (monthStr) {
    const [y, m] = monthStr.split('-').map(Number);
    year = y;
    month = m;
  }
  return {
    year,
    month,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

/**
 * Real profit for one calendar month — the P2-M8 replacement for the old
 * "profit needs cost data" placeholder, now that Invoices (P2-M6), finalized
 * Payroll (P2-M5), and Expenses (P2-M7) all exist.
 *
 * Methodology, deliberately consistent across all three legs — each is
 * "what was recorded as happening in this month", not a mix of accrual and
 * cash-basis figures that wouldn't add up to anything real:
 *  - revenue: sum of Invoice.grandTotal for invoices ISSUED in the month
 *    (Invoice.date). Not the old approvedRevenue (any Approved quotation,
 *    whether ever invoiced or not) — this is the real billed figure.
 *  - payrollCost: the Finalized PayrollRun's totalNet for that exact
 *    (periodYear, periodMonth) — 0 if no run was ever finalized for it. A
 *    Draft run never counts; an un-finalized month simply has no payroll
 *    cost yet, same as PHASE2-PLAN.md's "Finalized payroll feeds the
 *    dashboard's real cost figure."
 *  - expenses: sum of Expense.amount recorded in the month (Expense.date).
 */
/**
 * The selected month's real P&L plus a trailing TREND_MONTHS-month history
 * (oldest → newest, selected month last) for the dashboard's bar breakdown.
 *
 * FIX (2026-09-22, a real QA-audit finding — P3): this used to call a
 * per-month `computeMonthProfit(year, month)` six times, each running its
 * own Invoice aggregate + PayrollRun lookup + Expense aggregate — 18
 * database operations for one dashboard load, the single largest chunk of
 * the audit's reproduced 36-operation/2.16s Admin dashboard trace. Same
 * three collections, same math, but each is now ONE query covering the
 * whole 6-month span at once, grouped by month — 3 operations total, not 18.
 */
async function getProfitOverview(monthStr) {
  const selected = resolveMonth(monthStr);
  const months = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    let y = selected.year;
    let m = selected.month - i;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    months.push({ y, m, key: monthKey(y, m) });
  }
  const rangeStart = resolveMonth(months[0].key).start;
  const rangeEnd = resolveMonth(months[months.length - 1].key).end;

  const [invoiceRows, expenseRows, payrollRuns] = await Promise.all([
    Invoice.aggregate([
      { $match: { date: { $gte: rangeStart, $lte: rangeEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, total: { $sum: '$grandTotal' } } },
    ]),
    Expense.aggregate([
      { $match: { date: { $gte: rangeStart, $lte: rangeEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, total: { $sum: '$amount' } } },
    ]),
    // A small, bounded $or (one clause per trend month) — not a date-range
    // match, since periodYear/periodMonth are plain numbers, not a Date.
    PayrollRun.find({ $or: months.map(({ y, m }) => ({ periodYear: y, periodMonth: m })), status: 'Finalized' })
      .select('periodYear periodMonth totalNet')
      .lean(),
  ]);
  const revenueByMonth = new Map(invoiceRows.map((r) => [r._id, r.total]));
  const expensesByMonth = new Map(expenseRows.map((r) => [r._id, r.total]));
  const payrollByMonth = new Map(payrollRuns.map((r) => [monthKey(r.periodYear, r.periodMonth), r.totalNet]));

  const trend = months.map(({ key }) => {
    const revenue = revenueByMonth.get(key) ?? 0;
    const payrollCost = payrollByMonth.get(key) ?? 0;
    const expenses = expensesByMonth.get(key) ?? 0;
    return { month: key, revenue, payrollCost, expenses, net: revenue - payrollCost - expenses };
  });
  return { ...trend[trend.length - 1], trend };
}

/** Employee identity documents whose expiry we surface on the dashboard —
 *  exported so the P3-F expiry-alert job (notifications/expiryAlert.job.js)
 *  checks exactly the same set, not a second hand-maintained list. */
export const IDENTITY_DOCS = [
  ['passport', 'Passport'],
  ['visa', 'Visa'],
  ['iqama', 'Iqama'],
  ['medical', 'Medical'],
  ['drivingLicense', 'Driving License'],
];

const daysUntil = (date) => Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000);

/**
 * Live estimated revenue from mobilisations active at any point this calendar month —
 * the sum of each active mobilisation's own `profitPerMonth` estimate (the same
 * commercial figure Mobilisation/Deployment already treat as sensitive), not a fresh
 * calculation of its own. Called only once the caller's gate (own work for a
 * Coordinator, `mobilisationsViewer` read for anyone else — see getDashboard) is open.
 */
async function computeActiveMobilisationRevenue(actor, isCoordinator) {
  const startOfThisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const deploymentFilter = {
    startDate: { $lte: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999) },
    $or: [{ endDate: null }, { endDate: { $gte: startOfThisMonth } }],
    archived: { $ne: true },
  };
  if (isCoordinator) {
    const myMobIds = await Mobilisation.find({ 'coordinators.user': actor.userId }).distinct('_id');
    deploymentFilter.mobilisation = { $in: myMobIds };
  }
  const activeDeployments = await Deployment.find(deploymentFilter).select('mobilisation').lean();
  const mobIds = activeDeployments.map((d) => d.mobilisation).filter(Boolean);
  if (mobIds.length === 0) return 0;
  const activeMobs = await Mobilisation.find({ _id: { $in: mobIds } }).select('profitPerMonth').lean();
  return activeMobs.reduce((sum, mob) => sum + (mob.profitPerMonth || 0), 0);
}

/**
 * "Pending on me" across every approval-hierarchy-integrated request type —
 * the dashboard action list a decider (Manager/HR/Accounts/Coordinator/Admin)
 * actually needs, instead of a company-wide draft count that isn't theirs to
 * act on. Reuses annotateCanDecide (the same real authorization check the
 * review-queue pages use) per module rather than re-deriving the workflow/
 * legacy-role logic a third time — one extra ApprovalRole-membership query
 * per module, cheap at this data volume.
 *
 * Two Coordinator Workflow figures ride along (milestone 4), not approvals but
 * the same idea — work that's waiting on this viewer: requirements stale past
 * their stage's limit, and open to-dos. Each is counted by its own module under
 * that module's own Section Access (own-only sees their own, team sees all — the
 * same scope as the page the row links to), so the dashboard can't disagree with it.
 */
// `sectionKey` (added 2026-09-15, a real QA-audit-found gap — D1): the
// REAL decide route for Leave/Timesheet/SalaryAdvance/Reimbursement also
// requires Section Access write on this key — see leaveRequest.routes.js's
// canWriteLeaveRequests, timesheet.routes.js's canWrite,
// advance.service.js's own already-fixed `listAdvances` (2026-09-14, the
// exact same class of gap, just never carried over to this dashboard
// widget). `annotateCanDecide` alone only knows about ApprovalRole/
// legacy-role membership, so its hint could say "yes" for a role match
// (e.g. Manager) even after an Admin narrows the real Section Access grant
// to exclude them — the dashboard kept showing "Waiting on you" for an
// action that would actually 403. `null` for Mobilisation is intentional,
// not an oversight: its `/decide` route has no Section Access gate at all
// (deliberately left out of the Section Access rollout — see
// docs/RBAC-notes.md), so annotateCanDecide's own check is already the
// complete, accurate signal for it.
const PENDING_ACTION_MODULES = [
  { label: 'Leave requests', url: '/leave', Model: LeaveRequest, pendingStatus: 'PendingReview', legacyAllowedRoles: ['Admin', 'Manager', 'HR', 'Coordinator'], sectionKey: 'leaveRequests' },
  { label: 'Timesheets', url: '/timesheets', Model: Timesheet, pendingStatus: 'Submitted', legacyAllowedRoles: ['Admin', 'Manager', 'HR'], sectionKey: 'timesheetRequests' },
  { label: 'Salary advances', url: '/financial-requests', Model: SalaryAdvance, pendingStatus: 'Pending', legacyAllowedRoles: ['Admin', 'Manager', 'HR'], sectionKey: 'financialRequests' },
  { label: 'Reimbursements', url: '/financial-requests', Model: ReimbursementClaim, pendingStatus: 'Pending', legacyAllowedRoles: ['Admin', 'Manager', 'HR'], sectionKey: 'financialRequests' },
  { label: 'Mobilisations', url: '/mobilisations', Model: Mobilisation, pendingStatus: 'PendingReview', legacyAllowedRoles: ['Admin'], sectionKey: null },
];

// FIX (2026-09-22, a real QA-audit finding — P3, two parts):
//  1. `mySectionAccess` is getMySectionAccess's own already-batched result (2
//     queries total, covering every section key), passed in by getDashboard
//     rather than each of these five modules calling
//     canAccessSection(sectionKey, ...) itself — that used to mean up to 5
//     more SectionAccess reads here (Salary advances and Reimbursements even
//     shared the same 'financialRequests' key, so a viewer with both pending
//     could pay for it twice), on top of the 13 the main dashboard batch
//     already ran.
//  2. "Batch approval-role membership checks": every module used to call
//     annotateCanDecide separately, each running its OWN ApprovalRole query
//     — up to 5 more. Every module's items are now fetched first (still 5
//     queries — different collections, can't be merged), then ONE
//     ApprovalRole query covers the union of every module's needed role ids
//     (roleIdsNeededAcross, from approvalEngine.service.js), passed into
//     annotateCanDecide so it skips its own query entirely.
async function getMyPendingActions(actor, mySectionAccess) {
  if (!actor?.userId) return [];
  const [staleRequirements, openTasks, itemsByModule] = await Promise.all([
    countStaleRequirements(actor),
    countOpenTasks(actor),
    Promise.all(
      PENDING_ACTION_MODULES.map(({ Model, pendingStatus }) =>
        Model.find({ status: pendingStatus }).select('workflow currentStep steps status').lean()
      )
    ),
  ]);

  const allRoleIdsNeeded = new Set();
  PENDING_ACTION_MODULES.forEach(({ pendingStatus }, i) => {
    for (const id of roleIdsNeededAcross(itemsByModule[i], pendingStatus)) allRoleIdsNeeded.add(id);
  });
  let memberRoleIds = new Set();
  if (allRoleIdsNeeded.size > 0) {
    const roles = await ApprovalRole.find({ _id: { $in: [...allRoleIdsNeeded] }, members: actor.userId, isActive: true })
      .select('_id')
      .lean();
    memberRoleIds = new Set(roles.map((r) => r._id.toString()));
  }

  const perModule = await Promise.all(
    PENDING_ACTION_MODULES.map(async ({ label, url, pendingStatus, legacyAllowedRoles, sectionKey }, i) => {
      const items = itemsByModule[i];
      if (items.length === 0) return { label, url, count: 0 };
      const annotated = await annotateCanDecide(items, actor, { pendingStatus, legacyAllowedRoles, memberRoleIds });
      const hasSectionWrite = sectionKey ? mySectionAccess.write.includes(sectionKey) : true;
      const count = hasSectionWrite ? annotated.filter((i2) => i2.canDecideCurrentStep).length : 0;
      return { label, url, count };
    })
  );
  return [
    ...perModule,
    { label: 'Stale requirements', url: '/requirements', count: staleRequirements },
    { label: 'Open tasks', url: '/daily-updates?tab=tasks', count: openTasks },
  ].filter((m) => m.count > 0);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.thresholdDays] override the 30-day alert window (P2-M2,
 *   customizable per viewer — mirrors the same param on the employee list)
 * @param {string} [opts.month] "YYYY-MM" — the period the real-profit section
 *   (P2-M8) shows; defaults to the current calendar month.
 * @param {{role: string, userId: string}} [opts.actor] two independent axes:
 *
 *   1. VISIBILITY — added 2026-09-13, the user's own instruction ("the
 *      dashboard should reflect whatever [Section Access] read access they
 *      have"), replacing a hardcoded `isManager`-based rule that had quietly
 *      drifted out of sync with real grants (a Manager still saw Pipeline/
 *      Quotations here even after losing `quotationsManage`/`invoices` read
 *      via the Section Access login-role-removal migration) and never
 *      applied to Executive at all (who saw full company financials on the
 *      dashboard completely unconditionally, contradicting Executive's own
 *      deny-by-default design elsewhere). Every widget below now checks the
 *      SAME `canAccessSection(key, actor, 'read')` real grant its own module
 *      page is gated by — Admin always passes, same as everywhere else.
 *      `expiringDocuments` is a list, not a derived figure, so its two
 *      sources (Employee identity docs vs. generic Documents) are gated
 *      independently instead of all-or-nothing. `profit` used to require
 *      read on all three of Invoices/Payroll/Expenses at once (a profit
 *      figure built from only some of its real inputs would be an actual
 *      number that means something else entirely) — replaced 2026-09-15
 *      (the user's own ask, a Coordinator/Manager/HR cost-and-profit view)
 *      with its own dedicated `dashboardProfit` key: still the exact same
 *      server-computed figure (nothing about the math changed), but an
 *      Admin can now grant a role visibility into the AGGREGATE number
 *      without handing them read access to every individual invoice,
 *      payroll run, and expense line — the same "a derived figure gets its
 *      own narrower authorization" precedent Mobilisation/Deployment's own
 *      `profit` fields already follow.
 *   2. SCOPING — unchanged, and orthogonal to (1): when actor.role is
 *      'Coordinator', whatever they CAN read is further narrowed to their
 *      own team (deployments, workforce, the clients their team is placed
 *      at, expiring documents) — a data-scoping rule tied to the real
 *      Employee.coordinator hierarchy, not an access-grant question.
 *      Quotations specifically still has no honest per-team figure to
 *      compute at all regardless of any grant (Quotation only links to
 *      Client, never to an Employee/Coordinator) — same "never fabricate a
 *      figure the data doesn't support" rule `profit` follows.
 */
export async function getDashboard({ thresholdDays, month, actor } = {}) {
  const days = thresholdDays ?? EXPIRY_WARNING_DAYS;
  const threshold = new Date(Date.now() + days * 86_400_000);
  const identityExpiryOr = IDENTITY_DOCS.map(([key]) => ({
    [`${key}.expiry`]: { $ne: null, $lte: threshold },
  }));

  // A Coordinator's entire dashboard is scoped to their own team. Computed
  // once, ahead of the parallel batch below, so every filter that needs it
  // shares the same scope. Unrelated to the read-access checks below — see
  // this function's own doc comment (SCOPING vs. VISIBILITY).
  const isCoordinator = actor?.role === 'Coordinator';
  // "Pending quotations" is personal (their own Drafts) for a Manager
  // (the generic login a BDM-titled person holds) instead of the
  // company-wide count — they have no real per-item approval step over a
  // quotation they didn't author. Unrelated to whether they can see
  // quotations at all (canReadQuotations, below) — this only picks WHICH
  // quotations, once that gate is already open.
  const isManager = actor?.role === 'Manager';
  const teamIds = isCoordinator
    ? await Employee.find({ coordinator: actor.userId, type: { $in: WORKFORCE_TYPES } }).distinct('_id')
    : null;

  // FIX (2026-09-22, a real QA-audit finding — P3): every canReadX flag below
  // used to be its own `canAccessSection(key, actor, 'read')` call — each one
  // its own `SectionAccess.findOne` — 13 separate reads on every dashboard
  // load (reproduced: 9 of them for a Manager with no grants at all, before
  // any actual dashboard data was even touched). getMySectionAccess(actor) is
  // the SAME already-batched primitive `user.sectionAccess` itself is built
  // from on login (2 queries total, covering every section key that exists,
  // not just these 13) — resolved once here and reused for every read check
  // below AND passed into getMyPendingActions, instead of asking the
  // database the same "which sections can this actor read/write" question
  // repeatedly in one request.
  const mySectionAccess = actor ? await getMySectionAccess(actor) : { read: [], write: [] };
  const canRead = (key) => mySectionAccess.read.includes(key);
  const canReadEmployees = canRead('employeeCreate');
  const canReadDeployments = canRead('deploymentsRelease');
  const canReadClients = canRead('clientsManage');
  const canReadQuotations = canRead('quotationsManage');
  const canReadPayroll = canRead('payroll');
  const canSeeProfit = canRead('dashboardProfit');
  const canReadAuditLog = canRead('auditLog');
  const canReadAttendance = canRead('attendanceRecords');
  const canReadDocuments = canRead('documentsManage');
  // activeSubcontractors/attendanceSummary/pendingLeave/pendingExit below
  // used to gate on a hardcoded `actor.role === 'Manager'|'Admin'|'HR'`
  // check — the exact anti-pattern the 2026-09-13 "dashboard driven by real
  // Section Access reads" rewrite removed everywhere else on this page.
  // Each now reuses the SAME grant that already governs its own underlying
  // module, same as every other field here (e.g. expiringDocuments reuses
  // canReadEmployees/canReadDocuments) — attendanceSummary reuses
  // `attendanceRecords` (canReadAttendance, above) directly.
  const canReadSubcontractors = canRead('subcontractorsManage');
  const canReadLeave = canRead('leaveRequests');
  const canReadExitDocuments = canRead('exitDocuments');
  // mobilisationsByStatus and activeMobilisationRevenue's company-wide
  // totals used to be computed and returned to EVERY viewer unconditionally
  // — only the client chose not to render them outside Manager/Admin.
  // Reuses mobilisationsViewer ("full visibility into every mobilisation...
  // commercial rates and margins included"), the existing key for exactly
  // this sensitivity. A Coordinator's own scoped totals stay ungated —
  // their own work, same posture as their own MobilisationTargetCard.
  const canReadMobilisationCommercials = canRead('mobilisationsViewer');

  const employeeExpiryFilter = { status: { $ne: 'Exited' }, $or: identityExpiryOr };
  if (teamIds) employeeExpiryFilter._id = { $in: teamIds };

  const documentExpiryFilter = { expiryDate: { $ne: null, $lte: threshold } };
  if (teamIds) Object.assign(documentExpiryFilter, { ownerType: 'Employee', owner: { $in: teamIds } });

  const deploymentFilter = { status: 'Active' };
  if (teamIds) deploymentFilter.worker = { $in: teamIds };

  // "Active Workers"/"Workforce by status" mean the supplied workforce —
  // both Outsourced (our own, supplied to clients) and Subcontracted (sourced
  // from an outside subcontractor) count here; only Own-type internal staff
  // are excluded. Payroll's own aggregate below stays Outsourced-only.
  const employeeStatusFilter = { type: { $in: WORKFORCE_TYPES }, ...(teamIds ? { _id: { $in: teamIds } } : {}) };

  const markedTodayFilter = { date: toUtcDay(new Date()) };
  if (teamIds) markedTodayFilter.employee = { $in: teamIds };

  const [
    deployedActive,
    empStatusAgg,
    payrollAgg,
    activeClients,
    quoteAgg,
    expiringEmployees,
    expiringDocs,
    recentActivity,
    pendingClientApprovals,
    markedToday,
    profitOverview,
    personalPendingQuotations,
    myPendingActions,
    mobilisationsAgg,
    activeSubcontractorsCount,
    attendanceAgg,
    pendingLeave,
    pendingExit,
    activeMobilisationRevenue
  ] = await Promise.all([
    canReadDeployments ? Deployment.countDocuments(deploymentFilter) : Promise.resolve(0),
    canReadEmployees
      ? Employee.aggregate([{ $match: employeeStatusFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }])
      : Promise.resolve([]),
    // type: 'Outsourced' — this figure is the supplied workforce's pay, not
    // internal staff salaries (an Own-type employee's salary, if ever set,
    // must never silently flow into this).
    canReadPayroll
      ? Employee.aggregate([
          { $match: { status: { $ne: 'Exited' }, type: 'Outsourced' } },
          { $group: { _id: null, total: { $sum: '$salary' } } },
        ])
      : Promise.resolve([]),
    // FIX (2026-09-22, real user report): this used to narrow a Coordinator
    // to only the distinct clients THEIR OWN team currently has an active
    // deployment at — treating Client like a team-owned resource the way
    // Employee/Document/Deployment/Attendance genuinely are. It isn't: a
    // client (like a Subcontractor, whose own count right below has never
    // been scoped) is a shared, company-wide resource — any coordinator can
    // mobilise any worker to any client through any subcontractor,
    // regardless of who originally added it or who's currently placed
    // there. Confirmed against the app's own real team-scoped list (the
    // 13/15 September QA audits' own "Coordinator team-scoping closed on
    // Attendance/Documents/Assets/EOSB/Deployment/Timesheets" — Client was
    // never on it) — this was the one inconsistent case. Now always the
    // real company-wide count for every role, same as
    // activeSubcontractorsCount below. approvalStatus: 'Approved' — a
    // client still Pending isn't really "active" in the business sense yet.
    canReadClients ? Client.countDocuments({ status: 'Active', approvalStatus: 'Approved' }) : Promise.resolve(0),
    // Skipped entirely for a Coordinator regardless of any grant — see the
    // doc comment above (Quotation has no data-model link to a team at all).
    !canReadQuotations || isCoordinator
      ? Promise.resolve([])
      : Quotation.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$grandTotal' } } }]),
    canReadEmployees
      ? Employee.find(employeeExpiryFilter)
          .select('fullName employeeId passport visa iqama medical drivingLicense')
          .lean()
      : Promise.resolve([]),
    canReadDocuments
      ? Document.find(documentExpiryFilter).populate('owner', 'fullName companyName').limit(50).lean()
      : Promise.resolve([]),
    canReadAuditLog
      ? AuditLog.find({}).sort({ createdAt: -1 }).limit(8).populate('user', 'name').lean()
      : Promise.resolve([]),
    // Company-wide, unrelated to canReadClients scoping nuance above — a
    // Coordinator never sees this regardless (they'd only ever see their own
    // submissions' status on the client itself, not a company-wide count).
    !canReadClients || isCoordinator ? Promise.resolve(null) : Client.countDocuments({ approvalStatus: 'Pending' }),
    // "Marked today" — scoped to the Coordinator's own team via
    // markedTodayFilter when applicable, same as every other team-scoped
    // query above.
    canReadAttendance ? Attendance.countDocuments(markedTodayFilter) : Promise.resolve(0),
    // P2-M8 real profit — gated by its own 'dashboardProfit' key (see
    // canSeeProfit above and this function's own doc comment).
    canSeeProfit ? getProfitOverview(month) : Promise.resolve(null),
    // A Manager's "pending quotations" is personal (their own Drafts) — see
    // this function's own doc comment. Only computed once the quotations
    // gate itself is open.
    canReadQuotations && isManager
      ? Quotation.countDocuments({ status: 'Draft', createdBy: actor.userId })
      : Promise.resolve(null),
    // "Pending on me" across every workflow-integrated request type — see
    // getMyPendingActions above. Computed for every viewer (Admin included);
    // empty array where nothing is actionable. Unrelated to the read-access
    // gates above — it's already self-gated by real per-item decide
    // authority (ApprovalRole membership on that record's current step),
    // which is a stricter, more specific check than any section-level grant.
    getMyPendingActions(actor, mySectionAccess),
    // Mobilisations by status — a Coordinator's own is never gated (their own work);
    // the company-wide breakdown needs mobilisationsViewer read (see the doc comment
    // on the canAccessSection batch above).
    isCoordinator || canReadMobilisationCommercials
      ? Mobilisation.aggregate([
          ...(isCoordinator ? [{ $match: { 'coordinators.user': new mongoose.Types.ObjectId(actor.userId) } }] : []),
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
    // Active subcontractors — gated on subcontractorsManage read, the same grant that
    // already governs the subcontractor directory itself.
    canReadSubcontractors ? Subcontractor.countDocuments({ status: 'Active' }) : Promise.resolve(0),
    // Attendance summary — canReadAttendance (attendanceRecords), already computed above
    // for markedToday; not a second, narrower role check.
    canReadAttendance ? Attendance.find({ date: toUtcDay(new Date()) }).select('employee').lean() : Promise.resolve([]),
    // Pending leaves — gated on leaveRequests read, the same grant that governs the
    // Leave module itself.
    canReadLeave ? LeaveRequest.countDocuments({ status: 'PendingReview' }) : Promise.resolve(0),
    // Pending exits — gated on exitDocuments read, the same grant that governs the
    // Exit Documents module itself.
    canReadExitDocuments ? ExitReentry.countDocuments({ status: 'Pending' }) : Promise.resolve(0),
    // Active mobilisation revenue — same gate as mobilisationsByStatus above. Moved into
    // this parallel batch (2026-09-22 fix): it used to sit in the return object below,
    // running sequentially AFTER this whole batch already resolved, instead of
    // alongside everything else — see this file's own top doc comment on why every
    // independent query belongs in one Promise.all.
    isCoordinator || canReadMobilisationCommercials
      ? computeActiveMobilisationRevenue(actor, isCoordinator)
      : Promise.resolve(null)
  ]);

  // Workforce by status
  const workforceByStatus = { Active: 0, 'On Leave': 0, Exited: 0 };
  for (const row of empStatusAgg) workforceByStatus[row._id] = row.count;
  const totalWorkers = Object.values(workforceByStatus).reduce((a, b) => a + b, 0);

  // Quotations by status + finance
  const quotationsByStatus = { Draft: 0, Approved: 0, Rejected: 0 };
  let approvedRevenue = 0;
  let pendingRevenue = 0;
  for (const row of quoteAgg) {
    quotationsByStatus[row._id] = row.count;
    if (row._id === 'Approved') approvedRevenue = row.total;
    if (row._id === 'Draft') pendingRevenue = row.total;
  }

  // Merge expiring employee identity docs + uploaded documents, soonest first
  const expiringDocuments = [];
  for (const e of expiringEmployees) {
    for (const [key, label] of IDENTITY_DOCS) {
      const expiry = e[key]?.expiry;
      if (expiry && new Date(expiry) <= threshold) {
        expiringDocuments.push({
          source: 'Employee',
          ownerId: e._id,
          ownerName: e.fullName,
          ref: e.employeeId,
          label,
          expiry,
          daysLeft: daysUntil(expiry),
        });
      }
    }
  }
  for (const d of expiringDocs) {
    expiringDocuments.push({
      source: 'Document',
      ownerId: d.owner?._id ?? null,
      ownerName: d.owner?.fullName ?? d.owner?.companyName ?? 'Unknown',
      ref: d.category,
      label: d.title,
      expiry: d.expiryDate,
      daysLeft: daysUntil(d.expiryDate),
    });
  }
  expiringDocuments.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

  return {
    stats: {
      deployedActive: canReadDeployments ? deployedActive : null,
      activeWorkers: canReadEmployees ? workforceByStatus.Active : null,
      onLeave: canReadEmployees ? workforceByStatus['On Leave'] : null,
      totalWorkers: canReadEmployees ? totalWorkers : null,
      activeClients: canReadClients ? activeClients : null,
      pendingQuotations: !canReadQuotations
        ? null
        : isManager
          ? personalPendingQuotations
          : teamIds
            ? null
            : quotationsByStatus.Draft,
      // Always the real count of whatever's actually in expiringDocuments
      // below (itself built from independently-gated sources) — naturally 0
      // when neither contributing source is readable, no extra gate needed.
      expiringSoon: expiringDocuments.length,
      pendingClientApprovals,
      markedToday: canReadAttendance ? markedToday : null,
    },
    finance: {
      approvedRevenue: canReadQuotations && !isCoordinator ? approvedRevenue : null,
      pendingRevenue: canReadQuotations && !isCoordinator ? pendingRevenue : null,
      monthlyPayroll: canReadPayroll ? (payrollAgg[0]?.total ?? 0) : null,
      profit: profitOverview,
      // Revenue from mobilisations active this month — a Coordinator's own, or the
      // company total once granted mobilisationsViewer read (see canAccessSection batch
      // above and computeActiveMobilisationRevenue). Already null from that gated query
      // when not entitled; computed in the parallel batch above, not sequentially here.
      activeMobilisationRevenue
    },
    workforceByStatus: canReadEmployees ? workforceByStatus : null,
    quotationsByStatus: canReadQuotations && !isCoordinator ? quotationsByStatus : null,
    expiringDocuments: expiringDocuments.slice(0, 10),
    recentActivity: canReadAuditLog ? recentActivity : null,
    // "Pending on me" — see getMyPendingActions. Always an array (never null),
    // same "hidden entirely at zero" pattern the client already applies to
    // pendingClientApprovals.
    myPendingActions,
    // Gated the same way the query itself was above (own for a Coordinator,
    // mobilisationsViewer read otherwise) — mobilisationsAgg is always a real array from
    // Promise.all even when the query was skipped, so the gate has to be checked here
    // explicitly rather than inferred from truthiness.
    mobilisationsByStatus:
      isCoordinator || canReadMobilisationCommercials
        ? Object.fromEntries(mobilisationsAgg.map((r) => [r._id, r.count]))
        : null,
    // FIX (2026-09-22): these four used to gate on a hardcoded actor.role check — see the
    // matching doc comment on the canAccessSection batch above for why each now reuses the
    // grant that already governs its own underlying module instead.
    activeSubcontractors: canReadSubcontractors ? activeSubcontractorsCount : null,
    attendanceSummary: canReadAttendance && attendanceAgg ? await (async () => {
      const empIds = attendanceAgg.map(a => a.employee);
      const emps = await Employee.find({ _id: { $in: empIds } }).select('type designation currentClient').lean();

      let total = 0;
      const excludedDesignations = ['MM', 'FM', 'GM', 'COO', 'Admin', 'HR'];

      for (const e of emps) {
        if (e.type === 'Own' && !excludedDesignations.includes(e.designation)) {
          total++;
        } else if (e.type === 'Outsourced' && !e.currentClient) {
          total++;
        }
      }
      return { total };
    })() : null,
    pendingLeave: canReadLeave ? pendingLeave : null,
    pendingExit: canReadExitDocuments ? pendingExit : null
  };
}

/**
 * Standby workforce, with an idle-cost estimate layered on top — gated on the same
 * `payroll` read grant `getDashboard`'s own `monthlyPayroll` figure uses (2026-09-22
 * fix — this used to hardcode Admin/Manager/HR directly).
 *
 * FIX (2026-09-22, real user report — a screenshot of this widget showing "No workers
 * on standby" right next to the real Standby List page showing two real workers free):
 * this used to run its own, independent definition of "on standby" — every
 * `Employee.type: 'Outsourced'` with no currently-Active Deployment. That population is
 * always empty in real use: 'Outsourced' is a legacy type the live Mobilisation flow
 * has never actually written (an "Own Employee" mobilisation only ever picks a
 * `type:'Own'` Employee with a Worker login — see MobilisationForm's own picker filter
 * — and a SupplierEmployee/Freelancer mobilisation has no Employee record at all), so
 * this widget could never show a real result regardless of how many workers were
 * actually free. Fixed to build on `getStandbyWorkforce` — the SAME real population the
 * Standby List page already correctly computes — instead of a second, independent
 * definition that can drift from (and, here, silently never matched) the real one.
 *
 * The idle-cost estimate only applies to `ownEmployees`: they're the one population this
 * company actually pays a salary to regardless of deployment status (see
 * employee.model.js's own `requiredForOwnPayroll`/`type` doc comments), so an idle one
 * is a real, honest cost. A SupplierEmployee/Freelancer's wage is the subcontractor's
 * business (or a per-placement Freelancer fee) — this company owes them nothing while
 * they're not placed, so `moneyLost` is deliberately `null` for that half, never a
 * fabricated figure — same "never invent a number the data doesn't support" rule this
 * app follows everywhere else (GOSI, commission formulas, etc.).
 */
export async function getStandbyAnalysis(actor) {
  if (!(await canAccessSection('payroll', actor, 'read'))) return [];

  const { ownEmployees, subcontractedWorkers } = await getStandbyWorkforce();
  if (ownEmployees.length === 0 && subcontractedWorkers.length === 0) return [];

  const now = Date.now();
  const result = [];

  if (ownEmployees.length > 0) {
    const ids = ownEmployees.map((e) => e._id);
    const [salaryRows, latestDeployments] = await Promise.all([
      Employee.find({ _id: { $in: ids } }).select('salary joiningDate').lean(),
      // The most recent ENDED deployment per worker — a worker never yet placed has
      // none, and falls back to their joiningDate below (same as the widget's own
      // pre-fix logic, just no longer scoped to the dead 'Outsourced' type).
      Deployment.aggregate([
        { $match: { worker: { $in: ids }, endDate: { $ne: null } } },
        { $sort: { endDate: -1 } },
        { $group: { _id: '$worker', endDate: { $first: '$endDate' } } },
      ]),
    ]);
    const extraById = new Map(salaryRows.map((e) => [e._id.toString(), e]));
    const lastEndById = new Map(latestDeployments.map((d) => [d._id.toString(), d.endDate]));

    for (const w of ownEmployees) {
      const extra = extraById.get(w._id.toString());
      const referenceDate = lastEndById.get(w._id.toString()) ?? extra?.joiningDate;
      const daysOnStandby = referenceDate
        ? Math.max(0, Math.ceil((now - new Date(referenceDate).getTime()) / 86_400_000))
        : 0;
      // Salary is optional for an 'Own'-type Employee (see employee.model.js) — 0 is
      // the honest floor when none was ever entered, never an invented estimate.
      const dailyCost = (extra?.salary || 0) / 30;
      result.push({
        _id: String(w._id),
        fullName: w.fullName,
        employeeId: w.employeeId,
        designation: w.designation,
        daysOnStandby,
        moneyLost: Math.round(daysOnStandby * dailyCost),
      });
    }
  }

  for (const w of subcontractedWorkers) {
    const daysOnStandby = w.lastEndDate
      ? Math.max(0, Math.ceil((now - new Date(w.lastEndDate).getTime()) / 86_400_000))
      : 0;
    result.push({
      _id: w.iqamaNumber,
      fullName: w.workerName,
      employeeId: w.iqamaNumber,
      workerType: w.workerType,
      subcontractorName: w.subcontractorName ?? null,
      designation: null,
      daysOnStandby,
      moneyLost: null,
    });
  }

  return result.sort((a, b) => b.daysOnStandby - a.daysOnStandby);
}

export async function getCoordinatorDrillDown(actor, coordinatorId) {
  // FIX (2026-09-22): this destructured { DailyUpdate } and { Task } off dailyUpdate.model.js,
  // which has neither — one collection, a single DEFAULT export, with `kind: 'Log' | 'Task'`
  // telling the two apart (see dailyUpdate.model.js's own doc comment). Both names came back
  // undefined, so this 500'd every time — reproduced via GET /dashboard/coordinator-drill-down/:id.
  // Real fields: `coordinator` (who it belongs to, not `assignee`) and `status`/`completedAt`
  // (a Task only) — the same shape dailyUpdate.service.js already reads throughout.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const { default: DailyUpdate } = await import('../dailyUpdates/dailyUpdate.model.js');

  const logs = await DailyUpdate.find({ kind: 'Log', coordinator: coordinatorId, date: { $gte: thirtyDaysAgo } })
    .sort({ date: -1 })
    .limit(10)
    .lean();

  const openTasks = await DailyUpdate.countDocuments({ kind: 'Task', coordinator: coordinatorId, status: 'Open' });
  const completedTasks = await DailyUpdate.countDocuments({ kind: 'Task', coordinator: coordinatorId, status: 'Done' });

  // Mobilisation profit for this coordinator. FIX (2026-09-22): this used to match
  // status: { $in: ['Deployed', 'Approved'] } — 'Deployed' has never been a real
  // Mobilisation status (see MOBILISATION_STATUSES: Draft/PendingReview/Approved/
  // Rejected/Completed), so that half of the $in silently matched nothing and this
  // figure quietly excluded every Completed mobilisation. Now the same
  // ['Approved', 'Completed'] definition sumProgress (mobilisationTarget.service.js)
  // and getCoordinatorLeaderboard (below) both use — one real definition of
  // "counts toward profit," not three independently-typed ones.
  const mobilisations = await Mobilisation.aggregate([
    { $match: { 'coordinators.user': new mongoose.Types.ObjectId(coordinatorId), status: { $in: ['Approved', 'Completed'] }, archived: { $ne: true } } },
    { $group: { _id: null, totalProfit: { $sum: { $ifNull: ['$profitPerMonth', 0] } } } }
  ]);

  const totalProfit = mobilisations[0]?.totalProfit ?? 0;

  return {
    recentLogs: logs,
    tasks: { open: openTasks, completed: completedTasks },
    totalMonthlyProfit: totalProfit
  };
}

/**
 * Coordinator Mobilisation Leaderboard (2026-09-22, a real user ask — "where is
 * the coordinator mobilisation count/leaderboard for MM/GM/FM/COO etc?"). Every
 * real Coordinator (the same roster mobilisation.service.js's own
 * listCoordinatorCandidates uses for the "invite a joint coordinator" picker) with
 * their mobilisation count + estimated profit for one calendar month — a full
 * roster, not just coordinators who happen to have a Mobilisation Target set (the
 * only per-coordinator view that existed before this, buried inside "Manage
 * Targets" → Progress, and gated behind mobilisationTargets write specifically).
 *
 * Gate: mobilisationsViewer read — the SAME grant the existing "Global mobilisation
 * pipeline" dashboard widget and company-wide mobilisationsByStatus/
 * activeMobilisationRevenue figures already require (see getDashboard's own doc
 * comment) — so MM/GM/FM/COO/Admin see this without needing target-management
 * rights, the user's own explicit choice between the two options put to them.
 *
 * "Counts" = Approved/Completed mobilisations whose mobilisationDate falls in the
 * selected month — the exact same definition sumProgress (mobilisationTarget.
 * service.js) uses for a coordinator's own Target progress, sharing monthBounds so
 * the two can never quietly disagree on a boundary date. No single ranking column
 * — count and profit are both returned; the client sorts by whichever the viewer
 * picks (the user's own choice — "both, no single ranking").
 */
export async function getCoordinatorLeaderboard(actor, monthStr) {
  if (!(await canAccessSection('mobilisationsViewer', actor, 'read'))) {
    throw new ApiError(403, 'You do not have permission to view the coordinator leaderboard.');
  }

  const month = monthStr || new Date().toISOString().slice(0, 7);
  const { start, end } = monthBounds(month);

  const [coordinators, statsRows] = await Promise.all([
    User.find({ role: 'Coordinator' }).select('name').sort({ name: 1 }).lean(),
    Mobilisation.aggregate([
      {
        $match: {
          status: { $in: ['Approved', 'Completed'] },
          mobilisationDate: { $gte: start, $lt: end },
          archived: { $ne: true },
        },
      },
      { $unwind: '$coordinators' },
      {
        $group: {
          _id: '$coordinators.user',
          count: { $sum: 1 },
          profit: { $sum: { $ifNull: ['$profitPerMonth', 0] } },
        },
      },
    ]),
  ]);

  const statsById = new Map(statsRows.map((r) => [r._id.toString(), r]));

  return {
    month,
    rows: coordinators.map((c) => {
      const stats = statsById.get(c._id.toString());
      return {
        _id: c._id,
        name: c.name,
        count: stats?.count ?? 0,
        profit: stats?.profit ?? 0,
      };
    }),
  };
}

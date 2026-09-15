/**
 * Dashboard service — one aggregation across every module for the management
 * overview. It adds no data of its own; it reads employees, clients,
 * deployments, quotations, documents and the audit log and rolls them up.
 *
 * All the independent queries run in parallel (Promise.all) so the whole
 * dashboard is one fast round-trip.
 *
 * HONESTY NOTE (updated P2-M8): Phase 1 had no cost data, so this module
 * originally reported only approved-quotation revenue and a payroll
 * run-rate estimate, never a fabricated profit number. Now that Invoices
 * (P2-M6), finalized Payroll (P2-M5) and Expenses (P2-M7) all exist, a real
 * profit figure — actual billed revenue minus actual payroll cost minus
 * actual expenses, for a real calendar month — is finally honest to show;
 * see computeMonthProfit()/getProfitOverview() below and finance.profit.
 */
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
import { annotateCanDecide } from '../approvals/approvalEngine.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

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
async function computeMonthProfit(year, month) {
  const { start, end } = resolveMonth(monthKey(year, month));
  const [invoiceAgg, payrollRun, expenseAgg] = await Promise.all([
    Invoice.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]),
    PayrollRun.findOne({ periodYear: year, periodMonth: month, status: 'Finalized' }).select('totalNet').lean(),
    Expense.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  const revenue = invoiceAgg[0]?.total ?? 0;
  const payrollCost = payrollRun?.totalNet ?? 0;
  const expenses = expenseAgg[0]?.total ?? 0;
  return { month: monthKey(year, month), revenue, payrollCost, expenses, net: revenue - payrollCost - expenses };
}

/** The selected month's real P&L plus a trailing TREND_MONTHS-month history
 *  (oldest → newest, selected month last) for the dashboard's bar breakdown. */
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
    months.push({ y, m });
  }
  const trend = await Promise.all(months.map(({ y, m }) => computeMonthProfit(y, m)));
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
 * "Pending on me" across every approval-hierarchy-integrated request type —
 * the dashboard action list a decider (Manager/HR/Accounts/Coordinator/Admin)
 * actually needs, instead of a company-wide draft count that isn't theirs to
 * act on. Reuses annotateCanDecide (the same real authorization check the
 * review-queue pages use) per module rather than re-deriving the workflow/
 * legacy-role logic a third time — one extra ApprovalRole-membership query
 * per module, cheap at this data volume.
 */
// `sectionKey` (added 2026-09-15, a real QA-audit-found gap — D1): the
// REAL decide route for Leave/Timesheet/SalaryAdvance/Reimbursement also
// requires Section Access write on this key — see leave.routes.js's
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

async function getMyPendingActions(actor) {
  if (!actor?.userId) return [];
  const perModule = await Promise.all(
    PENDING_ACTION_MODULES.map(async ({ label, url, Model, pendingStatus, legacyAllowedRoles, sectionKey }) => {
      const items = await Model.find({ status: pendingStatus }).select('workflow currentStep steps status').lean();
      if (items.length === 0) return { label, url, count: 0 };
      const annotated = await annotateCanDecide(items, actor, { pendingStatus, legacyAllowedRoles });
      const hasSectionWrite = sectionKey ? await canAccessSection(sectionKey, actor, 'write') : true;
      const count = hasSectionWrite ? annotated.filter((i) => i.canDecideCurrentStep).length : 0;
      return { label, url, count };
    })
  );
  return perModule.filter((m) => m.count > 0);
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
 *      page is gated by — Admin always passes, same as everywhere else. A
 *      widget built from MULTIPLE sections (`profit` = Invoices + Payroll +
 *      Expenses) requires read on ALL of them, not any one — a profit figure
 *      built from only some of its real inputs would be an actual number
 *      that means something else entirely, worse than just not showing it
 *      (the user's own explicit call). `expiringDocuments` is a list, not a
 *      derived figure, so its two sources (Employee identity docs vs.
 *      generic Documents) are gated independently instead of all-or-nothing.
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

  const [
    canReadEmployees,
    canReadDeployments,
    canReadClients,
    canReadQuotations,
    canReadPayroll,
    canReadInvoices,
    canReadExpenses,
    canReadAuditLog,
    canReadAttendance,
    canReadDocuments,
  ] = actor
    ? await Promise.all(
        ['employeeCreate', 'deploymentsRelease', 'clientsManage', 'quotationsManage', 'payroll', 'invoices', 'expenses', 'auditLog', 'attendanceRecords', 'documentsManage'].map(
          (key) => canAccessSection(key, actor, 'read')
        )
      )
    : Array(10).fill(false);
  // Profit is built from all three of these — see this function's own doc
  // comment on why a partial figure is worse than none at all.
  const canSeeProfit = canReadInvoices && canReadPayroll && canReadExpenses;

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
    // A Coordinator's "clients" are the distinct clients their team is
    // currently placed at — not every client in the system. approvalStatus:
    // 'Approved' on the company-wide count — a client still Pending isn't
    // really "active" in the business sense yet (it also can't have any
    // deployments, so the Coordinator branch is already implicitly correct).
    !canReadClients
      ? Promise.resolve(0)
      : teamIds
        ? Deployment.find({ status: 'Active', worker: { $in: teamIds } }).distinct('client').then((ids) => ids.length)
        : Client.countDocuments({ status: 'Active', approvalStatus: 'Approved' }),
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
    // P2-M8 real profit — requires read on all three contributing sections
    // (see canSeeProfit above).
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
    getMyPendingActions(actor),
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
      // P2-M8 — real profit for the selected month (revenue from actually
      // issued invoices, cost from a finalized payroll run and recorded
      // expenses) plus a trailing 6-month trend. null unless the viewer can
      // read Invoices, Payroll, AND Expenses — see canSeeProfit above.
      profit: profitOverview,
    },
    workforceByStatus: canReadEmployees ? workforceByStatus : null,
    quotationsByStatus: canReadQuotations && !isCoordinator ? quotationsByStatus : null,
    expiringDocuments: expiringDocuments.slice(0, 10),
    recentActivity: canReadAuditLog ? recentActivity : null,
    // "Pending on me" — see getMyPendingActions. Always an array (never null),
    // same "hidden entirely at zero" pattern the client already applies to
    // pendingClientApprovals.
    myPendingActions,
  };
}

/**
 * Dashboard insights (2026-10-11): the second layer of the dashboard — the
 * "what should I look at today" blocks that sit under the headline figures
 * getDashboard() already returns. Served by its own endpoint
 * (GET /api/dashboard/insights) so the main dashboard call stays as light as
 * it was and these load beside it.
 *
 * Same rules as dashboard.service.js:
 *  - every block is `null` unless the viewer holds the Section Access Read of
 *    the module the figures come from (resolved once, batched, through
 *    getMySectionAccess) — the page never decides visibility by role;
 *  - a Coordinator's HR/attendance blocks are narrowed to their own team;
 *  - nothing here writes, and nothing invents a number the data does not hold.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import Attendance from '../attendance/attendance.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import AnnualVacationRequest from '../annualVacation/annualVacation.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import ReimbursementClaim from '../financialRequests/reimbursement.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import Expense from '../expenses/expense.model.js';
import AuditLog from '../audit/audit.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { toUtcDay } from '../attendance/attendance.service.js';
import { getMySectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { runReconciliation } from '../reconciliation/reconciliation.service.js';
import { listStaleRequirements } from '../requirements/requirement.service.js';
import { listMyOpenTasks } from '../dailyUpdates/dailyUpdate.service.js';
import {
  getReceivablesOverview,
  getReadyToInvoice,
  getStandbyWorkforce,
  listMissingTimesheets,
} from '../deployments/deployment.service.js';
import { getSubcontractorsPaymentSummary } from '../deployments/subcontractorInvoice.service.js';
import { IDENTITY_DOCS } from './dashboard.service.js';

const DAY = 86_400_000;
export const STUCK_AFTER_DAYS = 3;
export const IDLE_STANDBY_DAYS = 14;
const LIST_LIMIT = 5;

const daysSince = (date) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / DAY));
const daysUntil = (date) => Math.ceil((new Date(date).getTime() - Date.now()) / DAY);

/**
 * Every request type the approval engine can route, with the Read that lets a viewer
 * see the module's queue. `legacyRoles` is who may decide it when no workflow governs
 * the request (the same lists dashboard.service.js's PENDING_ACTION_MODULES carries).
 */
const APPROVAL_MODULES = [
  { label: 'Leave requests', url: '/leave', Model: LeaveRequest, pendingStatus: 'PendingReview', readKey: 'leaveRequests', legacyRoles: ['Admin', 'Manager', 'HR', 'Coordinator'] },
  { label: 'Annual vacation', url: '/annual-vacation', Model: AnnualVacationRequest, pendingStatus: 'PendingReview', readKey: 'annualVacation', legacyRoles: ['Admin', 'Manager', 'HR'] },
  { label: 'Timesheets', url: '/timesheets', Model: Timesheet, pendingStatus: 'Submitted', readKey: 'timesheetRequests', legacyRoles: ['Admin', 'Manager', 'HR'] },
  { label: 'Salary advances', url: '/financial-requests', Model: SalaryAdvance, pendingStatus: 'Pending', readKey: 'financialRequests', legacyRoles: ['Admin', 'Manager', 'HR'] },
  { label: 'Reimbursements', url: '/financial-requests', Model: ReimbursementClaim, pendingStatus: 'Pending', readKey: 'financialRequests', legacyRoles: ['Admin', 'Manager', 'HR'] },
  { label: 'Mobilisations', url: '/mobilisations', Model: Mobilisation, pendingStatus: 'PendingReview', readKey: 'mobilisationsViewer', legacyRoles: ['Admin'], sinceField: 'updatedAt' },
];

/** When did this request last move: its latest decided step, or if none yet, when it was
 *  filed. A Mobilisation is created as a draft and submitted later, so its last update
 *  (`updatedAt`) stands in for "submitted"; every other type is filed on creation. */
function waitingSince(item, sinceField = 'createdAt') {
  const trail = item.approvalTrail ?? [];
  const last = trail.length ? trail[trail.length - 1].decidedAt : null;
  return last ?? item[sinceField] ?? item.createdAt;
}

/** Role names (workflow step) or the legacy role list holding a request right now. */
function whoHolds(item, legacyRoles, roleNameById) {
  if (item.workflow) {
    const step = item.steps?.[item.currentStep];
    const names = (step?.roles ?? []).map((id) => roleNameById.get(String(id._id ?? id))).filter(Boolean);
    return names.length ? names : [step?.label ?? 'Approvers'];
  }
  return legacyRoles;
}

async function roleNames(roleIds) {
  if (roleIds.size === 0) return new Map();
  const roles = await ApprovalRole.find({ _id: { $in: [...roleIds] } }).select('name').lean();
  return new Map(roles.map((r) => [String(r._id), r.name]));
}

/**
 * Requests that have been waiting on an approver for more than STUCK_AFTER_DAYS, per
 * module, with the role (or roles) they are waiting on. Oversight view: needs the
 * module's own Read, and a Coordinator never gets it (their own submissions have the
 * `myAwaiting` list instead).
 */
async function stuckApprovals(actor, access) {
  const modules = APPROVAL_MODULES.filter((m) => access.read.includes(m.readKey));
  if (actor.role === 'Coordinator' || modules.length === 0) return null;

  const itemsByModule = await Promise.all(
    modules.map(({ Model, pendingStatus }) =>
      Model.find({ status: pendingStatus, ...(Model.schema.path('archived') ? { archived: { $ne: true } } : {}) })
        .select('workflow steps currentStep approvalTrail createdAt updatedAt')
        .lean()
    )
  );
  const roleIds = new Set();
  for (const items of itemsByModule) {
    for (const item of items) {
      if (item.workflow) for (const id of item.steps?.[item.currentStep]?.roles ?? []) roleIds.add(String(id._id ?? id));
    }
  }
  const nameById = await roleNames(roleIds);

  const rows = [];
  modules.forEach((m, i) => {
    const stuck = itemsByModule[i]
      .map((item) => ({ item, days: daysSince(waitingSince(item, m.sinceField)) }))
      .filter((x) => x.days > STUCK_AFTER_DAYS);
    if (stuck.length === 0) return;
    const waitingOn = new Set();
    for (const { item } of stuck) for (const name of whoHolds(item, m.legacyRoles, nameById)) waitingOn.add(name);
    rows.push({
      label: m.label,
      url: m.url,
      count: stuck.length,
      oldestDays: Math.max(...stuck.map((x) => x.days)),
      waitingOn: [...waitingOn].slice(0, 4),
    });
  });
  return rows.sort((a, b) => b.oldestDays - a.oldestDays);
}

/** System health strip (Admin-level oversight). Each figure is gated by its own key. */
async function systemHealth(access) {
  const canAudit = access.read.includes('auditLog');
  const canTeam = access.read.includes('team');
  const canReconcile = access.read.includes('reconciliation');
  if (!canAudit && !canTeam && !canReconcile) return null;

  const [failedLogins24h, grantsChanged7d, neverLoggedIn, reconciliationFindings] = await Promise.all([
    canAudit ? AuditLog.countDocuments({ action: 'auth.login.failed', createdAt: { $gte: new Date(Date.now() - DAY) } }) : null,
    canAudit ? AuditLog.countDocuments({ action: 'sectionAccess.update', createdAt: { $gte: new Date(Date.now() - 7 * DAY) } }) : null,
    canTeam
      ? (async () => {
          const everLoggedIn = await AuditLog.distinct('user', { action: 'auth.login.success', user: { $ne: null } });
          return User.countDocuments({ isActive: true, _id: { $nin: everLoggedIn } });
        })()
      : null,
    canReconcile ? runReconciliation().then((r) => r.total) : null,
  ]);
  return { failedLogins24h, grantsChanged7d, neverLoggedIn, reconciliationFindings };
}

/** Identity documents by type and how soon they lapse: already expired / ≤30 / 31–60 / 61–90 days. */
async function expiringByType(teamIds) {
  const horizon = new Date(Date.now() + 90 * DAY);
  const filter = {
    status: { $ne: 'Exited' },
    $or: IDENTITY_DOCS.map(([key]) => ({ [`${key}.expiry`]: { $ne: null, $lte: horizon } })),
  };
  if (teamIds) filter._id = { $in: teamIds };
  const employees = await Employee.find(filter).select(IDENTITY_DOCS.map(([key]) => key).join(' ')).lean();

  return IDENTITY_DOCS.map(([key, label]) => {
    const row = { type: key, label, expired: 0, d30: 0, d60: 0, d90: 0 };
    for (const e of employees) {
      const expiry = e[key]?.expiry;
      if (!expiry) continue;
      const left = daysUntil(expiry);
      if (left > 90) continue;
      if (left < 0) row.expired += 1;
      else if (left <= 30) row.d30 += 1;
      else if (left <= 60) row.d60 += 1;
      else row.d90 += 1;
    }
    return row;
  }).filter((r) => r.expired + r.d30 + r.d60 + r.d90 > 0);
}

/** Contracts ending in the next 30 days — the people who become eligible for annual vacation. */
async function contractsEnding(teamIds) {
  const filter = { status: { $ne: 'Exited' }, contractEndDate: { $ne: null, $gte: toUtcDay(new Date()), $lte: new Date(Date.now() + 30 * DAY) } };
  if (teamIds) filter._id = { $in: teamIds };
  const employees = await Employee.find(filter).select('fullName employeeId contractEndDate').sort({ contractEndDate: 1 }).lean();
  return {
    count: employees.length,
    items: employees.slice(0, LIST_LIMIT).map((e) => ({ _id: e._id, name: e.fullName, employeeId: e.employeeId, endDate: e.contractEndDate, daysLeft: daysUntil(e.contractEndDate) })),
  };
}

/** Who is on approved leave today, and who comes back within the next 7 days. */
async function leavePicture(teamIds) {
  const today = toUtcDay(new Date());
  const weekEnd = new Date(today.getTime() + 7 * DAY);
  const filter = { status: 'Approved', startDate: { $lte: weekEnd }, endDate: { $gte: today } };
  if (teamIds) filter.employee = { $in: teamIds };
  const requests = await LeaveRequest.find(filter).select('employee startDate endDate').populate('employee', 'fullName employeeId').lean();

  const onLeave = [];
  const returning = [];
  for (const r of requests) {
    if (!r.employee) continue;
    const person = { _id: r.employee._id, name: r.employee.fullName, employeeId: r.employee.employeeId };
    if (new Date(r.startDate) <= today) onLeave.push({ ...person, until: r.endDate });
    if (new Date(r.endDate) < weekEnd) returning.push({ ...person, returnsOn: new Date(new Date(r.endDate).getTime() + DAY) });
  }
  returning.sort((a, b) => new Date(a.returnsOn) - new Date(b.returnsOn));
  return { onLeaveCount: onLeave.length, onLeave: onLeave.slice(0, LIST_LIMIT), returningCount: returning.length, returning: returning.slice(0, LIST_LIMIT) };
}

/** Everyone who has marked attendance today (checked in), most recent first. */
async function signedInToday(teamIds) {
  const filter = { date: toUtcDay(new Date()), checkInTime: { $ne: null } };
  if (teamIds) filter.employee = { $in: teamIds };
  const [count, recent] = await Promise.all([
    Attendance.countDocuments(filter),
    Attendance.find(filter).select('employee checkInTime').sort({ checkInTime: -1 }).limit(8).populate('employee', 'fullName').lean(),
  ]);
  return { count, recent: recent.filter((a) => a.employee).map((a) => ({ name: a.employee.fullName, at: a.checkInTime })) };
}

/** Own employees on standby longer than IDLE_STANDBY_DAYS — no pay figure here, only who and how long. */
async function idleStandby() {
  const { ownEmployees, subcontractedWorkers } = await getStandbyWorkforce();
  const ids = ownEmployees.map((e) => e._id);
  const [joined, lastEnded] = await Promise.all([
    Employee.find({ _id: { $in: ids } }).select('joiningDate').lean(),
    Deployment.aggregate([
      { $match: { worker: { $in: ids }, endDate: { $ne: null } } },
      { $group: { _id: '$worker', endDate: { $max: '$endDate' } } },
    ]),
  ]);
  const joinedBy = new Map(joined.map((e) => [String(e._id), e.joiningDate]));
  const endedBy = new Map(lastEnded.map((d) => [String(d._id), d.endDate]));

  const idle = [];
  for (const e of ownEmployees) {
    const since = endedBy.get(String(e._id)) ?? joinedBy.get(String(e._id));
    if (since) idle.push({ name: e.fullName, ref: e.employeeId, days: daysSince(since) });
  }
  for (const w of subcontractedWorkers) {
    if (w.lastEndDate) idle.push({ name: w.workerName, ref: w.iqamaNumber, days: daysSince(w.lastEndDate) });
  }
  const over = idle.filter((w) => w.days > IDLE_STANDBY_DAYS).sort((a, b) => b.days - a.days);
  return { count: over.length, items: over.slice(0, LIST_LIMIT) };
}

/** This calendar month's spending against last month's. */
async function expensesMonthOverMonth() {
  const now = new Date();
  const thisStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [row] = await Expense.aggregate([
    { $match: { date: { $gte: lastStart } } },
    {
      $group: {
        _id: null,
        thisMonth: { $sum: { $cond: [{ $gte: ['$date', thisStart] }, '$amount', 0] } },
        lastMonth: { $sum: { $cond: [{ $lt: ['$date', thisStart] }, '$amount', 0] } },
      },
    },
  ]);
  const round = (n) => Math.round((n ?? 0) * 100) / 100;
  return { thisMonth: round(row?.thisMonth), lastMonth: round(row?.lastMonth) };
}

/** The Accounts snapshot: receivables, what falls due, ready to invoice, subcontractors, expenses. */
async function billingSnapshot(actor, access) {
  const canExpenses = access.read.includes('expenses');
  const canBilling = access.read.includes('mobilisationsViewer') || access.read.includes('deploymentsInvoicing');
  if (!canBilling && !canExpenses) return null;

  const [receivables, readyRows, subRows, expenses] = await Promise.all([
    canBilling ? getReceivablesOverview(actor) : null,
    canBilling ? getReadyToInvoice(actor) : null,
    access.read.includes('mobilisationsViewer') ? getSubcontractorsPaymentSummary(actor) : null,
    canExpenses ? expensesMonthOverMonth() : null,
  ]);
  const money = (n) => Math.round(n * 100) / 100;
  return {
    receivables,
    readyToInvoice: readyRows
      ? { count: readyRows.length, amount: money(readyRows.reduce((sum, r) => sum + (r.revenue ?? 0), 0)) }
      : null,
    subcontractorOwed: subRows
      ? { count: subRows.length, amount: money(subRows.reduce((sum, r) => sum + r.totalOutstanding, 0)) }
      : null,
    expenses,
  };
}

/** The viewer's own pending mobilisations and who is holding each. */
async function myAwaiting(actor) {
  const items = await Mobilisation.find({
    status: 'PendingReview',
    archived: { $ne: true },
    'coordinators.user': new mongoose.Types.ObjectId(actor.userId),
  })
    .select('serialNumber workerName clientName workflow steps currentStep approvalTrail createdAt updatedAt')
    .sort({ updatedAt: 1 })
    .lean();
  if (items.length === 0) return null;

  const roleIds = new Set();
  for (const item of items) {
    if (item.workflow) for (const id of item.steps?.[item.currentStep]?.roles ?? []) roleIds.add(String(id._id ?? id));
  }
  const nameById = await roleNames(roleIds);
  return items.slice(0, LIST_LIMIT).map((m) => ({
    _id: m._id,
    serialNumber: m.serialNumber,
    workerName: m.workerName,
    clientName: m.clientName,
    days: daysSince(waitingSince(m, 'updatedAt')),
    waitingOn: whoHolds(m, ['Admin'], nameById),
  }));
}

/** Requests this viewer decided in the last 7 days, across every approval module. */
async function decidedThisWeek(actor) {
  const since = new Date(Date.now() - 7 * DAY);
  const userId = new mongoose.Types.ObjectId(actor.userId);
  const decided = { $or: [{ decidedBy: userId, decidedAt: { $gte: since } }, { approvalTrail: { $elemMatch: { approvedBy: userId, decidedAt: { $gte: since } } } }] };
  const counts = await Promise.all(APPROVAL_MODULES.map(({ Model }) => Model.countDocuments(decided)));
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * @param {{role: string, userId: string}} actor
 */
export async function getDashboardInsights(actor) {
  const access = await getMySectionAccess(actor);
  const isCoordinator = actor.role === 'Coordinator';
  const can = (key) => access.read.includes(key);

  const teamIds = isCoordinator ? await Employee.find({ coordinator: actor.userId }).distinct('_id') : null;
  const canEmployees = can('employeeCreate');
  const canLeave = can('leaveRequests');
  const canAttendance = can('attendanceRecords');

  const [
    health,
    stuck,
    expiring,
    contracts,
    leave,
    signedIn,
    idle,
    billing,
    staleRequirements,
    missingTimesheets,
    awaiting,
    tasks,
    decided,
  ] = await Promise.all([
    systemHealth(access),
    stuckApprovals(actor, access),
    canEmployees ? expiringByType(teamIds) : null,
    canEmployees ? contractsEnding(teamIds) : null,
    canLeave ? leavePicture(teamIds) : null,
    canAttendance ? signedInToday(teamIds) : null,
    can('deploymentsRelease') && !isCoordinator ? idleStandby() : null,
    billingSnapshot(actor, access),
    listStaleRequirements(actor, LIST_LIMIT),
    listMissingTimesheets(actor),
    myAwaiting(actor),
    listMyOpenTasks(actor, LIST_LIMIT),
    decidedThisWeek(actor),
  ]);

  return {
    systemHealth: health,
    stuckApprovals: stuck,
    expiringByType: expiring,
    contractsEnding: contracts,
    leavePicture: leave,
    signedInToday: signedIn,
    idleStandby: idle,
    billing,
    myWork: {
      staleRequirements,
      missingTimesheets: { count: missingTimesheets.length, items: missingTimesheets.slice(0, LIST_LIMIT) },
      awaitingReview: awaiting,
      tasks,
    },
    decidedThisWeek: decided,
  };
}

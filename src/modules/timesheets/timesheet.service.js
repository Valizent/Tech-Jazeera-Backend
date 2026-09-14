/**
 * Timesheet service — aggregates a week of real Attendance data and runs it
 * through submit/approve/reject. See timesheet.model.js for why this
 * doesn't duplicate hour-entry.
 *
 * KNOWN LIMITATION (documented, not silently glossed over): approving a
 * timesheet does not yet lock its underlying Attendance days against
 * further edits. Payroll's approvedHoursForMonth (payroll.service.js) does
 * now read Approved Timesheets for its overtime figure (P3-E), so a
 * post-approval Attendance edit CAN silently drift from what was already
 * paid — see docs/P2-M3b-notes.md for the reasoning and what adding the
 * lock would touch.
 */
import AttendanceModel from '../attendance/attendance.model.js';
import Employee from '../employees/employee.model.js';
import Timesheet from './timesheet.model.js';
import { resolveWeeklyCap } from '../ramadan/ramadanPeriod.service.js';
import { notifyEmployeeUser } from '../notifications/notification.service.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The ORIGINAL decide-route role gate for a Timesheet — preserved exactly
 *  as the authorization used whenever no ApprovalWorkflow governs a request
 *  (see approvalEngine.service.js's legacy path). */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR'];

/** Shared by submitTimesheet (notifySubmission) and decideTimesheet
 *  (buildStepNotification) so the text can't drift between them. */
function buildTimesheetStepNotification() {
  return {
    type: 'RequestStatus',
    title: 'A timesheet needs your approval',
    url: '/timesheets',
  };
}

// Labor Law Article 98: 8 hours/day, 48 hours/week — the fixed statutory
// normal week used whenever a timesheet's week doesn't overlap a configured
// Ramadan period (see ../ramadan/ramadanPeriod.model.js for why the
// Ramadan cap itself IS configurable but this baseline isn't).
const NORMAL_WEEKLY_HOURS = 48;

/** The Saturday..Friday (KSA week) bounds containing `date` — mirrors the
 *  client's attendance.dates.js weekRange() exactly, in UTC Date form. */
function weekBoundsFor(date) {
  const d = new Date(date);
  const sinceSaturday = (d.getUTCDay() + 1) % 7;
  const start = new Date(d.getTime() - sinceSaturday * 86_400_000);
  const periodStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 6 * 86_400_000);
  return { periodStart, periodEnd };
}

/**
 * Sum a week's Attendance into a Timesheet's totals.
 *   - Present with a real self-punched hoursWorked → that figure.
 *   - Present with no clock times (a staff bulk-mark) → the employee's own
 *     expectedDailyHours, if one is set on file — never an invented default.
 *   - Absent/Off contribute 0 hours; Leave/Sick are tracked separately, not
 *     summed as worked hours.
 *   - overtimeHours (P3-E): whatever totalHours exceeds this week's
 *     threshold — NORMAL_WEEKLY_HOURS (48), or the configured Ramadan
 *     weeklyHours cap if [periodStart, periodEnd] overlaps a RamadanPeriod.
 */
async function computeTotals(employee, periodStart, periodEnd) {
  const records = await AttendanceModel.find({
    employee: employee._id,
    date: { $gte: periodStart, $lte: periodEnd },
  }).lean();

  let totalHours = 0;
  let daysPresent = 0;
  let daysAbsent = 0;
  let daysLeaveOrSick = 0;
  let daysOff = 0;

  for (const r of records) {
    if (r.status === 'Present') {
      daysPresent += 1;
      totalHours += r.hoursWorked ?? employee.expectedDailyHours ?? 0;
    } else if (r.status === 'Absent') {
      daysAbsent += 1;
    } else if (r.status === 'Leave' || r.status === 'Sick') {
      daysLeaveOrSick += 1;
    } else if (r.status === 'Off') {
      daysOff += 1;
    }
  }

  const ramadanWeeklyCap = await resolveWeeklyCap(periodStart, periodEnd);
  const weeklyThreshold = ramadanWeeklyCap ?? NORMAL_WEEKLY_HOURS;
  const overtimeHours = money(Math.max(0, totalHours - weeklyThreshold));

  return {
    totalHours: money(totalHours),
    daysPresent,
    daysAbsent,
    daysLeaveOrSick,
    daysOff,
    recordedDays: records.length,
    overtimeHours,
  };
}

export async function submitTimesheet(employeeId, data, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  const { periodStart, periodEnd } = weekBoundsFor(data.periodStart);
  if (periodStart > new Date()) {
    throw new ApiError(400, 'You cannot submit a timesheet for a week that has not started.');
  }

  const totals = await computeTotals(employee, periodStart, periodEnd);
  const existing = await Timesheet.findOne({ employee: employeeId, periodStart });

  // Every timesheet needs a real decision (no auto-approval concept here) —
  // re-resolved on every (re)submission, including a resubmission after
  // Rejection, so a workflow change since the last attempt always applies.
  let workflowFields = { workflow: null, workflowName: null, steps: undefined, currentStep: 0 };
  const workflow = await resolveApprovalWorkflow(employee, 'Timesheet');
  if (workflow) {
    workflowFields = { workflow: workflow._id, workflowName: workflow.name, steps: workflow.steps, currentStep: 0 };
  }

  let timesheet;
  if (existing) {
    if (existing.status !== 'Rejected') {
      throw new ApiError(409, `This week's timesheet is already ${existing.status.toLowerCase()}.`);
    }
    Object.assign(existing, totals, workflowFields, {
      status: 'Submitted',
      notes: data.notes,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      approvalTrail: undefined,
    });
    timesheet = await existing.save();
  } else {
    timesheet = await Timesheet.create({
      employee: employeeId,
      periodStart,
      periodEnd,
      ...totals,
      notes: data.notes,
      ...workflowFields,
    });
  }

  await logAudit({
    user: actor.userId,
    action: 'timesheet.submit',
    targetType: 'Timesheet',
    targetId: timesheet._id,
    meta: { employeeId: employee.employeeId, periodStart: periodStart.toISOString().slice(0, 10), totalHours: totals.totalHours },
    ip: actor.ip,
  });
  const plain = timesheet.toObject();
  await notifySubmission(plain, buildTimesheetStepNotification, LEGACY_DECIDE_ROLES);
  return plain;
}

export async function listOwnTimesheets(employeeId, { page, limit }) {
  const filter = { employee: employeeId };
  const [items, total] = await Promise.all([
    Timesheet.find(filter).sort({ periodStart: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Timesheet.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function listTimesheets({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;
  const [rawItems, total] = await Promise.all([
    Timesheet.find(filter)
      .sort({ periodStart: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    Timesheet.countDocuments(filter),
  ]);
  const items = actor
    ? await annotateCanDecide(rawItems, actor, { pendingStatus: 'Submitted', legacyAllowedRoles: LEGACY_DECIDE_ROLES })
    : rawItems;
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

function buildTimesheetFinalNotification(doc) {
  return {
    type: 'RequestStatus',
    title: `Timesheet ${doc.status.toLowerCase()}`,
    body: `Week of ${new Date(doc.periodStart).toISOString().slice(0, 10)}${doc.decisionNote ? ` — ${doc.decisionNote}` : ''}`,
    url: (role) => (role === 'Worker' ? '/me/attendance' : '/timesheets'),
  };
}

export async function decideTimesheet(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: Timesheet,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'Submitted',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    notFoundMessage: 'Timesheet not found.',
    auditAction: 'timesheet',
    buildFinalNotification: buildTimesheetFinalNotification,
    buildStepNotification: buildTimesheetStepNotification,
  });
}

/**
 * Approve many Submitted timesheets at once (the plan's "bulk approve a
 * week"). Unlike a single decide, this is a FULL-APPROVAL action — a
 * timesheet mid-way through a multi-step workflow is skipped rather than
 * silently advanced by one step, since "approve these N" shouldn't turn
 * into partial progress an approver didn't ask for. Any row a caller isn't
 * actually authorized to decide (wrong role for that step, already decided
 * by someone else) is also skipped, not allowed to fail the whole batch.
 */
export async function bulkApproveTimesheets(ids, actor) {
  const timesheets = await Timesheet.find({ _id: { $in: ids } })
    .select('status workflow currentStep steps')
    .lean();
  const byId = new Map(timesheets.map((t) => [t._id.toString(), t]));

  let approved = 0;
  let skipped = 0;

  for (const id of ids) {
    const ts = byId.get(id);
    const isMidChain = ts?.workflow && ts.currentStep < (ts.steps?.length ?? 0) - 1;
    if (!ts || ts.status !== 'Submitted' || isMidChain) {
      skipped += 1;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await decideApprovalStep({
        Model: Timesheet,
        id,
        decision: 'Approved',
        actor,
        pendingStatus: 'Submitted',
        legacyAllowedRoles: LEGACY_DECIDE_ROLES,
        notFoundMessage: 'Timesheet not found.',
        auditAction: 'timesheet',
        buildFinalNotification: buildTimesheetFinalNotification,
      });
      approved += 1;
    } catch {
      skipped += 1;
    }
  }

  await logAudit({
    user: actor.userId,
    action: 'timesheet.bulkApprove',
    meta: { requested: ids.length, approved, skipped },
    ip: actor.ip,
  });
  return { requested: ids.length, approved, skipped };
}

/**
 * Payroll service — build a Draft run from real employee/timesheet data,
 * edit lines, finalize, and resolve a payslip.
 */
import Employee from '../employees/employee.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import { deductionsForEmployeeMonth } from '../deployments/deployment.service.js';
import PayrollRun from './payrollRun.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Saudi Labor Law's standard convention for turning a monthly wage into a
// daily one — a 30-day month (same convention the EOSB calculator already
// uses for leave encashment) — and, one level further, an hourly one (a
// 30-day month × an 8-hour normal day).
const DAILY_WAGE_DIVISOR = 30;
const HOURLY_WAGE_DIVISOR = 240;
// Labor Law Article 107: overtime is paid at the normal hourly wage + 50%.
const OVERTIME_RATE = 1.5;

/**
 * Walk a Sick LeaveRequest's frozen `payBreakdown` (tier segments, in
 * order) back into actual calendar dates starting at the request's real
 * `startDate` — the ONLY way to know which specific days a tier's "5 days
 * at 75%" refers to, since the breakdown itself only records counts.
 */
function expandSickPayBreakdown(startDate, payBreakdown) {
  const dates = [];
  let cursor = new Date(startDate);
  for (const tier of payBreakdown) {
    for (let i = 0; i < tier.days; i++) {
      dates.push({ date: new Date(cursor), payPercent: tier.payPercent });
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
  }
  return dates;
}

/**
 * How much of this employee's pay to dock this month for Sick leave whose
 * tiers say less than 100% — reads each request's FROZEN payBreakdown
 * (never recomputed from the current LeaveType, so an already-decided
 * request's pay can't silently change if the company edits its sick-pay
 * tiers later — same discipline as everywhere else `eligibility` is used).
 * A request spanning a month boundary only has its days IN this month
 * counted; the rest belongs to whichever month those calendar days fall in.
 */
async function sickLeaveDeductionForMonth(employeeId, basicSalary, monthStart, monthEnd) {
  const requests = await LeaveRequest.find({
    employee: employeeId,
    status: { $in: ['AutoApproved', 'Approved'] },
    'eligibility.payBreakdown': { $exists: true, $ne: [] },
    startDate: { $lte: monthEnd },
    endDate: { $gte: monthStart },
  })
    .select('startDate eligibility.payBreakdown')
    .lean();

  const dailyWage = basicSalary / DAILY_WAGE_DIVISOR;
  let deduction = 0;
  let reducedPayDays = 0;
  let unpaidDays = 0;

  for (const request of requests) {
    for (const { date, payPercent } of expandSickPayBreakdown(request.startDate, request.eligibility.payBreakdown)) {
      if (date < monthStart || date > monthEnd || payPercent >= 100) continue; // outside this month, or fully paid
      deduction += dailyWage * ((100 - payPercent) / 100);
      if (payPercent === 0) unpaidDays += 1;
      else reducedPayDays += 1;
    }
  }

  const parts = [];
  if (reducedPayDays > 0) parts.push(`${reducedPayDays} day(s) reduced-pay`);
  if (unpaidDays > 0) parts.push(`${unpaidDays} day(s) unpaid`);
  return { deduction: money(deduction), note: parts.length ? `Sick leave: ${parts.join(', ')}` : '' };
}

/** Sum of Approved-timesheet hours (and overtime hours, P3-E) for one
 *  employee, counting a week toward the calendar month its Saturday
 *  (periodStart) falls in — a documented approximation, not a day-by-day
 *  split of weeks that cross month ends. */
async function approvedHoursForMonth(employeeId, monthStart, monthEnd) {
  const timesheets = await Timesheet.find({
    employee: employeeId,
    status: 'Approved',
    periodStart: { $gte: monthStart, $lte: monthEnd },
  }).lean();
  return {
    approvedHours: money(timesheets.reduce((sum, t) => sum + t.totalHours, 0)),
    overtimeHours: money(timesheets.reduce((sum, t) => sum + (t.overtimeHours ?? 0), 0)),
  };
}

function buildLineTotals({ basicSalary, housingAllowance, transportAllowance, otherAllowances, overtimePay, sickLeaveDeduction, gosiDeduction, otherDeductions }) {
  const grossPay = money(basicSalary + housingAllowance + transportAllowance + otherAllowances + overtimePay);
  const totalDeductions = money(sickLeaveDeduction + gosiDeduction + otherDeductions.reduce((sum, d) => sum + d.amount, 0));
  const netPay = money(grossPay - totalDeductions);
  return { grossPay, totalDeductions, netPay };
}

function recomputeRunTotals(run) {
  run.totalGross = money(run.lines.reduce((sum, l) => sum + l.grossPay, 0));
  run.totalDeductions = money(run.lines.reduce((sum, l) => sum + l.totalDeductions, 0));
  run.totalNet = money(run.lines.reduce((sum, l) => sum + l.netPay, 0));
}

/**
 * Build a Draft PayrollRun for (year, month). Eligible employees mirror the
 * dashboard's existing "Monthly Payroll" figure exactly (type: 'Outsourced',
 * not Exited, a salary on file) — reusing that established business rule
 * rather than inventing a second one.
 */
export async function createPayrollRun({ periodYear, periodMonth }, actor) {
  const existing = await PayrollRun.findOne({ periodYear, periodMonth }).lean();
  if (existing) {
    throw new ApiError(409, `A payroll run for ${periodMonth}/${periodYear} already exists.`);
  }

  const employees = await Employee.find({
    type: 'Outsourced',
    status: { $ne: 'Exited' },
    salary: { $gt: 0 },
  }).lean();
  if (employees.length === 0) {
    throw new ApiError(400, 'No employees are eligible for payroll (Outsourced type, active, with a salary on file).');
  }

  const monthStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const monthEnd = new Date(Date.UTC(periodYear, periodMonth, 0));

  const monthStr = `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
  const lines = [];
  for (const employee of employees) {
    const basicSalary = employee.basicSalary ?? employee.salary;
    const housingAllowance = employee.housingAllowance ?? 0;
    const transportAllowance = employee.transportAllowance ?? 0;
    const otherAllowances = 0;
    const gosiDeduction = 0;
    // Any Approved client-timesheet deduction this employee's Deployment(s)
    // carried for this exact month (e.g. a client-imposed absence penalty —
    // see deployment.model.js's own doc comment on deductionAmount) — the
    // one place this run's otherDeductions starts non-empty rather than as
    // a blank ad-hoc list. Snapshot-at-creation like every other figure in
    // this loop: a deduction entered or approved AFTER this run already
    // exists is not retroactively pulled in (see deductionsForEmployeeMonth's
    // own doc comment) — same limitation overtimeHours/sickLeaveDeduction
    // already have.
    const otherDeductions = await deductionsForEmployeeMonth(employee._id, monthStr);

    const { approvedHours, overtimeHours } = await approvedHoursForMonth(employee._id, monthStart, monthEnd);
    // Overtime pay is based on THIS employee's own basic salary, not a
    // company-wide rate — the hourly wage a 50%-uplift is computed against
    // is theirs alone (Article 107).
    const overtimePay = money(overtimeHours * (basicSalary / HOURLY_WAGE_DIVISOR) * OVERTIME_RATE);
    const { deduction: sickLeaveDeduction, note: sickLeaveNote } = await sickLeaveDeductionForMonth(
      employee._id,
      basicSalary,
      monthStart,
      monthEnd
    );

    const totals = buildLineTotals({
      basicSalary,
      housingAllowance,
      transportAllowance,
      otherAllowances,
      overtimePay,
      sickLeaveDeduction,
      gosiDeduction,
      otherDeductions,
    });

    lines.push({
      employee: employee._id,
      employeeName: employee.fullName,
      employeeCode: employee.employeeId,
      basicSalary: money(basicSalary),
      housingAllowance: money(housingAllowance),
      transportAllowance: money(transportAllowance),
      otherAllowances,
      overtimePay,
      approvedHours,
      overtimeHours,
      sickLeaveDeduction,
      sickLeaveNote,
      gosiDeduction,
      otherDeductions,
      ...totals,
    });
  }

  const run = new PayrollRun({ periodYear, periodMonth, lines, createdBy: actor.userId });
  recomputeRunTotals(run);
  await run.save();

  await logAudit({
    user: actor.userId,
    action: 'payroll.create',
    targetType: 'PayrollRun',
    targetId: run._id,
    meta: { periodYear, periodMonth, lines: lines.length, totalNet: run.totalNet },
    ip: actor.ip,
  });
  return run.toObject();
}

export async function listPayrollRuns({ page, limit, status }) {
  const filter = {};
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    PayrollRun.find(filter)
      .select('-lines')
      .sort({ periodYear: -1, periodMonth: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PayrollRun.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getPayrollRun(id) {
  const run = await PayrollRun.findById(id).lean();
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  return run;
}

export async function updatePayrollLine(runId, lineId, data, actor) {
  const run = await PayrollRun.findById(runId);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (run.status !== 'Draft') throw new ApiError(400, 'Only a draft payroll run can be edited.');

  const line = run.lines.id(lineId);
  if (!line) throw new ApiError(404, 'Payroll line not found.');

  line.otherAllowances = data.otherAllowances;
  line.gosiDeduction = data.gosiDeduction;
  line.otherDeductions = data.otherDeductions;
  Object.assign(
    line,
    buildLineTotals({
      basicSalary: line.basicSalary,
      housingAllowance: line.housingAllowance,
      transportAllowance: line.transportAllowance,
      otherAllowances: line.otherAllowances,
      overtimePay: line.overtimePay, // auto-computed at creation, not editable here
      sickLeaveDeduction: line.sickLeaveDeduction, // auto-computed at creation, not editable here
      gosiDeduction: line.gosiDeduction,
      otherDeductions: line.otherDeductions,
    })
  );
  recomputeRunTotals(run);
  await run.save();

  await logAudit({
    user: actor.userId,
    action: 'payroll.line.update',
    targetType: 'PayrollRun',
    targetId: run._id,
    meta: { employeeCode: line.employeeCode, netPay: line.netPay },
    ip: actor.ip,
  });
  return run.toObject();
}

export async function finalizePayrollRun(id, actor) {
  const run = await PayrollRun.findById(id);
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (run.status !== 'Draft') throw new ApiError(400, 'This payroll run is already finalized.');

  run.status = 'Finalized';
  run.finalizedBy = actor.userId;
  run.finalizedAt = new Date();
  await run.save();

  await logAudit({
    user: actor.userId,
    action: 'payroll.finalize',
    targetType: 'PayrollRun',
    targetId: run._id,
    meta: { periodYear: run.periodYear, periodMonth: run.periodMonth, totalNet: run.totalNet },
    ip: actor.ip,
  });
  return run.toObject();
}

export async function deletePayrollRun(id, actor) {
  const run = await PayrollRun.findById(id).lean();
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  if (run.status !== 'Draft') throw new ApiError(400, 'A finalized payroll run cannot be deleted.');

  await PayrollRun.deleteOne({ _id: id });
  await logAudit({
    user: actor.userId,
    action: 'payroll.delete',
    targetType: 'PayrollRun',
    targetId: run._id,
    meta: { periodYear: run.periodYear, periodMonth: run.periodMonth },
    ip: actor.ip,
  });
}

/** One employee's own payslip line, from a Finalized run only. */
export async function resolveMyPayslip(employeeId, runId) {
  const run = await PayrollRun.findById(runId).lean();
  if (!run || run.status !== 'Finalized') throw new ApiError(404, 'Payslip not found.');
  const line = run.lines.find((l) => l.employee.toString() === employeeId);
  if (!line) throw new ApiError(404, 'Payslip not found.');
  return { run, line };
}

/** Every Finalized run this employee has a line in — their payslip history. */
export async function listMyPayslips(employeeId) {
  const runs = await PayrollRun.find({ status: 'Finalized', 'lines.employee': employeeId })
    .sort({ periodYear: -1, periodMonth: -1 })
    .lean();
  return runs.map((run) => {
    const line = run.lines.find((l) => l.employee.toString() === employeeId);
    return {
      runId: run._id,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      finalizedAt: run.finalizedAt,
      netPay: line.netPay,
      grossPay: line.grossPay,
    };
  });
}

/** Any employee's line, for staff — used by the staff PDF endpoint. */
export async function resolvePayslip(runId, lineId) {
  const run = await PayrollRun.findById(runId).lean();
  if (!run) throw new ApiError(404, 'Payroll run not found.');
  const line = run.lines.find((l) => l._id.toString() === lineId);
  if (!line) throw new ApiError(404, 'Payroll line not found.');
  return { run, line };
}

/**
 * Payroll service — build a Draft run from real employee/timesheet data,
 * edit lines, finalize, and resolve a payslip.
 */
import Employee from '../employees/employee.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import { addRepayment, computeOutstanding } from '../financialRequests/advance.service.js';
import { deductionsForEmployeesMonth } from '../deployments/deployment.service.js';
import PayrollRun from './payrollRun.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import logger from '../../config/logger.js';

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
 *
 * FIX (2026-09-22, a real QA-audit finding — P4): this and the two
 * functions below it used to each run their own per-employee query,
 * sequentially, once per employee in createPayrollRun's loop — reproduced
 * at 494ms/10 employees and 4.7s/100 employees, all from that. Each is now
 * a `requestsByEmployee`/`timesheetsByEmployee`/`deductionsByEmployee` MAP,
 * built by ONE query per collection covering every eligible employee at
 * once (`sickLeaveRequestsForMonth`/`approvedTimesheetsForMonth` below),
 * with this function's own math unchanged — it just reads its rows out of
 * the pre-fetched map instead of awaiting its own find().
 */
function sickLeaveDeductionForMonth(requests, basicSalary, monthStart, monthEnd) {
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

/** Every eligible employee's sick LeaveRequests relevant to this month, in
 *  ONE query — grouped by employee id (string) for sickLeaveDeductionForMonth
 *  above to read per-employee; see its own doc comment. */
async function sickLeaveRequestsForMonth(employeeIds, monthStart, monthEnd) {
  const requests = await LeaveRequest.find({
    employee: { $in: employeeIds },
    status: { $in: ['AutoApproved', 'Approved'] },
    'eligibility.payBreakdown': { $exists: true, $ne: [] },
    startDate: { $lte: monthEnd },
    endDate: { $gte: monthStart },
  })
    .select('employee startDate eligibility.payBreakdown')
    .lean();
  const byEmployee = new Map(employeeIds.map((id) => [String(id), []]));
  for (const request of requests) byEmployee.get(String(request.employee))?.push(request);
  return byEmployee;
}

/** Sum of Approved-timesheet hours (and overtime hours, P3-E) for one
 *  employee, counting a week toward the calendar month its Saturday
 *  (periodStart) falls in — a documented approximation, not a day-by-day
 *  split of weeks that cross month ends. See sickLeaveDeductionForMonth's
 *  own doc comment above for why this takes pre-fetched rows, not an id. */
function approvedHoursForMonth(timesheets) {
  return {
    approvedHours: money(timesheets.reduce((sum, t) => sum + t.totalHours, 0)),
    overtimeHours: money(timesheets.reduce((sum, t) => sum + (t.overtimeHours ?? 0), 0)),
  };
}

/** Every eligible employee's Approved timesheets in this month's window, in
 *  ONE query — grouped by employee id (string) for approvedHoursForMonth
 *  above to read per-employee. */
async function approvedTimesheetsForMonth(employeeIds, monthStart, monthEnd) {
  const timesheets = await Timesheet.find({
    employee: { $in: employeeIds },
    status: 'Approved',
    periodStart: { $gte: monthStart, $lte: monthEnd },
  })
    .select('employee totalHours overtimeHours')
    .lean();
  const byEmployee = new Map(employeeIds.map((id) => [String(id), []]));
  for (const t of timesheets) byEmployee.get(String(t.employee))?.push(t);
  return byEmployee;
}

function buildLineTotals({
  basicSalary,
  housingAllowance,
  transportAllowance,
  otherAllowances,
  overtimePay,
  sickLeaveDeduction,
  gosiDeduction,
  otherDeductions,
  advanceRepaymentAmount,
}) {
  const grossPay = money(basicSalary + housingAllowance + transportAllowance + otherAllowances + overtimePay);
  const totalDeductions = money(
    sickLeaveDeduction + gosiDeduction + advanceRepaymentAmount + otherDeductions.reduce((sum, d) => sum + d.amount, 0)
  );
  const netPay = money(grossPay - totalDeductions);
  return { grossPay, totalDeductions, netPay };
}

/** Every eligible employee's Approved, still-outstanding SalaryAdvance, in
 *  ONE query — grouped by employee id, same batching discipline as the
 *  timesheet/sick-leave/client-deduction lookups above (2026-09-22's own
 *  fix). An employee can only ever have one active advance at a time
 *  (advance.service.js's submitAdvance enforces that), so this is a
 *  straight id → advance map, not id → array. */
async function outstandingAdvancesForEmployees(employeeIds) {
  const advances = await SalaryAdvance.find({ employee: { $in: employeeIds }, status: 'Approved' })
    .select('employee amount repaymentMonths repayments')
    .lean();
  const byEmployee = new Map();
  for (const advance of advances) {
    const outstanding = computeOutstanding(advance);
    if (outstanding <= 0) continue;
    byEmployee.set(String(advance.employee), { advance, outstanding });
  }
  return byEmployee;
}

/** The suggested monthly installment — amount ÷ repaymentMonths, never more
 *  than what's actually still owed (a worker who over-pays by hand, or
 *  whose advance is close to fully repaid, should never see a suggestion
 *  larger than the real remaining balance). */
function suggestedInstallment(advance, outstanding) {
  return Math.min(outstanding, money(advance.amount / advance.repaymentMonths));
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
  const employeeIds = employees.map((e) => e._id);
  // FIX (2026-09-22, a real QA-audit finding — P4): these three used to be
  // awaited ONE EMPLOYEE AT A TIME inside the loop below — three sequential
  // reads per employee, blocking the next employee from starting until all
  // three finished. Now three queries total, covering every eligible
  // employee at once, run in parallel ahead of the loop — the loop itself
  // is now pure synchronous math over already-fetched data. See each
  // function's own doc comment for the exact reproduced numbers.
  const [deductionsByEmployee, timesheetsByEmployee, sickRequestsByEmployee, advancesByEmployee] = await Promise.all([
    deductionsForEmployeesMonth(employeeIds, monthStr),
    approvedTimesheetsForMonth(employeeIds, monthStart, monthEnd),
    sickLeaveRequestsForMonth(employeeIds, monthStart, monthEnd),
    outstandingAdvancesForEmployees(employeeIds),
  ]);

  const lines = [];
  for (const employee of employees) {
    const basicSalary = employee.basicSalary ?? employee.salary;
    const housingAllowance = employee.housingAllowance ?? 0;
    const transportAllowance = employee.transportAllowance ?? 0;
    const otherAllowances = 0;
    const gosiDeduction = 0;
    const employeeKey = String(employee._id);
    // Any Approved client-timesheet deduction this employee's Deployment(s)
    // carried for this exact month (e.g. a client-imposed absence penalty —
    // see deployment.model.js's own doc comment on deductionAmount) — the
    // one place this run's otherDeductions starts non-empty rather than as
    // a blank ad-hoc list. Snapshot-at-creation like every other figure in
    // this loop: a deduction entered or approved AFTER this run already
    // exists is not retroactively pulled in (see deductionsForEmployeeMonth's
    // own doc comment) — same limitation overtimeHours/sickLeaveDeduction
    // already have.
    const otherDeductions = deductionsByEmployee.get(employeeKey) ?? [];

    const { approvedHours, overtimeHours } = approvedHoursForMonth(timesheetsByEmployee.get(employeeKey) ?? []);
    // Overtime pay is based on THIS employee's own basic salary, not a
    // company-wide rate — the hourly wage a 50%-uplift is computed against
    // is theirs alone (Article 107).
    const overtimePay = money(overtimeHours * (basicSalary / HOURLY_WAGE_DIVISOR) * OVERTIME_RATE);
    const { deduction: sickLeaveDeduction, note: sickLeaveNote } = sickLeaveDeductionForMonth(
      sickRequestsByEmployee.get(employeeKey) ?? [],
      basicSalary,
      monthStart,
      monthEnd
    );

    const outstandingAdvance = advancesByEmployee.get(employeeKey);
    let advanceRepayment = { advance: null, amount: 0, suggestedAmount: 0 };
    if (outstandingAdvance) {
      const suggested = suggestedInstallment(outstandingAdvance.advance, outstandingAdvance.outstanding);
      advanceRepayment = { advance: outstandingAdvance.advance._id, amount: suggested, suggestedAmount: suggested };
    }

    const totals = buildLineTotals({
      basicSalary,
      housingAllowance,
      transportAllowance,
      otherAllowances,
      overtimePay,
      sickLeaveDeduction,
      gosiDeduction,
      otherDeductions,
      advanceRepaymentAmount: advanceRepayment.amount,
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
      advanceRepayment,
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
  // Clamped to [0, suggestedAmount] — never raised above what was actually
  // checked against the advance's real outstanding balance at run-creation
  // time (see this file's own top doc comment on advanceRepayment); Accounts
  // can only reduce it (e.g. skip this month) or leave it as suggested.
  if (line.advanceRepayment?.advance) {
    line.advanceRepayment.amount = Math.min(
      Math.max(0, data.advanceRepaymentAmount ?? line.advanceRepayment.amount),
      line.advanceRepayment.suggestedAmount
    );
  }
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
      advanceRepaymentAmount: line.advanceRepayment?.amount ?? 0,
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

  // Real money left this employee's net pay for this — record it against
  // the advance's own repayment ledger now, the same action Accounts used
  // to have to remember to do by hand separately. Best-effort per line, not
  // transactional with the save above (same no-cross-collection-
  // transactions posture as every other module here — see
  // reimbursement.service.js's markReimbursementPaid for the identical
  // reasoning): finalizing payroll must never be blocked by one advance's
  // own edge case (e.g. it was independently repaid elsewhere in the
  // meantime), so a failure here is logged, not thrown.
  for (const line of run.lines) {
    if (!line.advanceRepayment?.advance || line.advanceRepayment.amount <= 0) continue;
    try {
      await addRepayment(
        line.advanceRepayment.advance,
        {
          amount: line.advanceRepayment.amount,
          date: run.finalizedAt,
          note: `Auto-deducted from ${run.periodMonth}/${run.periodYear} payroll.`,
        },
        actor
      );
    } catch (err) {
      logger.warn(
        `[payroll.finalize] could not auto-record advance repayment for ${line.employeeCode} (advance ${line.advanceRepayment.advance}): ${err.message}`
      );
    }
  }

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

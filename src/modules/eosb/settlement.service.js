/**
 * EOSB settlement service — the Article 84/85 calculation and the persisted
 * settlement record. SECURITY / CORRECTNESS: exactly like quotation totals,
 * every figure is computed HERE from the employee's real record, never
 * accepted from the client.
 *
 * Scope note (see docs/P3-A-notes.md for the full reasoning): only the exit
 * reasons the PRD actually specifies (plus 'SponsorshipTransfer', added
 * 2026-09-12 for Deployment's demobilise feature — see settlement.model.js)
 * are modeled. Article 80 (termination for an employee's serious
 * misconduct, which can forfeit the award entirely) is a distinct,
 * contentious legal category this app does not attempt to adjudicate — not
 * offered as an exit reason here.
 */
import Employee from '../employees/employee.model.js';
import LeaveType from '../leave/leaveType.model.js';
import { evaluateEligibility, monthsOfService } from '../leave/leave.service.js';
import Settlement from './settlement.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/** Round to 2 decimal places (money). */
const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Saudi Labor Law's standard convention for turning a monthly wage into a
// daily one (leave encashment, deduction calculations) — a 30-day month,
// not the employee's actual calendar days worked.
const DAILY_WAGE_DIVISOR = 30;

/**
 * Labor Law Articles 84–85 — End of Service Award.
 *   Article 84: half a month's wage per year for the first 5 years of
 *               service, a full month's wage per year after that.
 *   Article 85: if the WORKER resigns (not employer-initiated, not
 *               end-of-contract), the award is reduced by service length:
 *               <2yr: forfeited · 2–5yr: 1/3 · 5–10yr: 2/3 · 10yr+: full.
 *
 * Tenure precision matches the existing Leave eligibility engine
 * (whole completed months, via monthsOfService) rather than a new, finer
 * day-based standard — see docs/P3-A-notes.md.
 */
export function computeEosb({ joiningDate, exitDate, monthlyWage, exitReason }) {
  if (!(exitDate > joiningDate)) {
    throw new ApiError(400, 'Exit date must be after the joining date.');
  }
  const totalMonths = monthsOfService(joiningDate, exitDate);
  const serviceYears = totalMonths / 12;

  const firstBracketYears = Math.min(serviceYears, 5);
  const remainingYears = Math.max(0, serviceYears - 5);
  const eosbGross = money(firstBracketYears * 0.5 * monthlyWage + remainingYears * monthlyWage);

  let reductionFactor = 1;
  if (exitReason === 'Resignation') {
    if (serviceYears < 2) reductionFactor = 0;
    else if (serviceYears < 5) reductionFactor = 1 / 3;
    else if (serviceYears < 10) reductionFactor = 2 / 3;
    else reductionFactor = 1;
  }
  const eosbNet = money(eosbGross * reductionFactor);

  return { serviceYears: Math.round(serviceYears * 100) / 100, eosbGross, reductionFactor, eosbNet };
}

/** Vacation Pay Settlement — unused balance summed across every Annual leave
 *  type, evaluated as of the exit date (not today). */
async function unusedLeaveDaysAsOf(employee, exitDate) {
  const annualTypes = await LeaveType.find({ recurrence: 'Annual', isActive: true }).lean();
  let total = 0;
  for (const type of annualTypes) {
    const result = await evaluateEligibility(employee, type, 0, exitDate);
    total += result.remainingDays ?? 0;
  }
  return total;
}

export async function createSettlement(data, actor) {
  const employee = await Employee.findById(data.employee).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (!employee.joiningDate) throw new ApiError(400, 'This employee has no joining date on file.');
  if (!employee.salary) throw new ApiError(400, 'This employee has no salary on file.');

  // An employee exits this company exactly once — a second settlement for
  // the same person is always a mistake (a duplicate submit, or someone
  // forgetting one already exists), never a legitimate second award. Block
  // it instead of silently creating a duplicate; deleteSettlement is the
  // documented way to remove a wrong one before recomputing.
  const existing = await Settlement.findOne({ employee: employee._id }).lean();
  if (existing) {
    throw new ApiError(
      409,
      `${employee.fullName} already has a settlement on file (computed ${new Date(existing.createdAt).toLocaleDateString()}). Delete it first if this one needs to be recomputed.`
    );
  }

  const { serviceYears, eosbGross, reductionFactor, eosbNet } = computeEosb({
    joiningDate: employee.joiningDate,
    exitDate: data.exitDate,
    monthlyWage: employee.salary,
    exitReason: data.exitReason,
  });

  const unusedLeaveDays = await unusedLeaveDaysAsOf(employee, data.exitDate);
  const leaveEncashment = money(unusedLeaveDays * (employee.salary / DAILY_WAGE_DIVISOR));
  const totalSettlement = money(eosbNet + leaveEncashment);

  const settlement = await Settlement.create({
    employee: employee._id,
    employeeName: employee.fullName,
    employeeCode: employee.employeeId,
    joiningDate: employee.joiningDate,
    exitDate: data.exitDate,
    exitReason: data.exitReason,
    monthlyWage: employee.salary,
    serviceYears,
    eosbGross,
    reductionFactor,
    eosbNet,
    unusedLeaveDays,
    leaveEncashment,
    totalSettlement,
    notes: data.notes,
    computedBy: actor.userId,
  });

  await logAudit({
    user: actor.userId,
    action: 'eosb.settlement.create',
    targetType: 'Settlement',
    targetId: settlement._id,
    meta: { employeeCode: employee.employeeId, exitReason: data.exitReason, totalSettlement },
    ip: actor.ip,
  });
  return settlement.toObject();
}

export async function listSettlements({ page, limit, employee }) {
  const filter = {};
  if (employee) filter.employee = employee;

  const [items, total] = await Promise.all([
    Settlement.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Settlement.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getSettlement(id) {
  const settlement = await Settlement.findById(id).lean();
  if (!settlement) throw new ApiError(404, 'Settlement not found.');
  return settlement;
}

export async function deleteSettlement(id, actor) {
  const settlement = await Settlement.findByIdAndDelete(id).lean();
  if (!settlement) throw new ApiError(404, 'Settlement not found.');
  await logAudit({
    user: actor.userId,
    action: 'eosb.settlement.delete',
    targetType: 'Settlement',
    targetId: settlement._id,
    meta: { employeeCode: settlement.employeeCode },
    ip: actor.ip,
  });
}

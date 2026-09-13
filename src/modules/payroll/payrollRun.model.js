/**
 * PayrollRun — one calendar month's payroll for the supplied workforce
 * (P2-M5, the next Phase 2 backbone step after P2-M3b's timesheet
 * approval). One document per (year, month); `lines` holds one entry per
 * eligible employee, computed server-side and editable (Draft only) before
 * being locked in with `finalize`.
 *
 * Schema choices, justified:
 *  - Every money figure on a line is COMPUTED here, never trusted from the
 *    client — same discipline as quotation totals and the EOSB calculator.
 *  - `basicSalary`/`housingAllowance`/`transportAllowance` are SNAPSHOTS of
 *    the employee's pay at run-creation time (Employee.basicSalary etc., or
 *    the whole `salary` as Basic if no breakdown is configured — see
 *    employee.model.js). A later salary change must never silently rewrite
 *    a past month's payslip.
 *  - `gosiDeduction` is entered by HR/Accounts, never computed: GOSI rates
 *    differ by nationality/coverage and change over time, and this app has
 *    no verified source for the correct current rate — same "don't invent
 *    a legally exact figure" rule as the EOSB exit-reason scoping and the
 *    unconfirmed statutory leave day-caps. Defaults to 0, not a guessed %.
 *  - `approvedHours` is INFORMATIONAL — summed from Approved Timesheets
 *    (P2-M3b) overlapping this month. It does NOT include overtime hours
 *    and does not by itself feed netPay.
 *  - `overtimeHours`/`overtimePay` (P3-E) are the real cost figure:
 *    overtimeHours is summed from the SAME Approved timesheets'
 *    `overtimeHours` (already computed per-week against the 48-hour normal
 *    week or a configured Ramadan cap — see timesheets/timesheet.service.js);
 *    overtimePay = overtimeHours × hourly wage × 1.5 (Labor Law Article 107),
 *    and IS folded into grossPay — see payroll.service.js's buildLineTotals.
 *  - `sickLeaveDeduction` is the other real, auto-computed cost figure: for
 *    any Approved 'Sick'-type LeaveRequest overlapping this month, days
 *    paid at less than 100% (per the LeaveType's configurable tiers —
 *    Labor Law Article 117's 30-days-full/60-at-75%/rest-unpaid by
 *    default) are docked at that day's own basic-salary daily rate — see
 *    payroll.service.js's sickLeaveDeductionForMonth(). Folded into
 *    totalDeductions, not grossPay — it reduces pay, unlike overtime.
 */
import mongoose from 'mongoose';

export const PAYROLL_STATUSES = ['Draft', 'Finalized'];

/** One ad-hoc deduction line. `otherDeductions` starts non-empty for a
 *  line whenever the employee had an Approved client-timesheet deduction on
 *  a Deployment for this exact month (a client-imposed absence penalty,
 *  most commonly — see deployment.model.js's `deductionAmount` doc comment
 *  and payroll.service.js's createPayrollRun) — everything past that is
 *  freely added/edited by hand (e.g. a recorded loan-repayment note) while
 *  the run is still Draft. _id disabled — a value object, replaced
 *  wholesale on edit. */
const deductionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 100 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const payrollLineSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String, required: true },
  employeeCode: { type: String, required: true },

  basicSalary: { type: Number, required: true, min: 0 },
  housingAllowance: { type: Number, default: 0, min: 0 },
  transportAllowance: { type: Number, default: 0, min: 0 },
  otherAllowances: { type: Number, default: 0, min: 0 },
  overtimePay: { type: Number, default: 0, min: 0 },
  grossPay: { type: Number, required: true, min: 0 },

  approvedHours: { type: Number, default: 0, min: 0 },
  overtimeHours: { type: Number, default: 0, min: 0 },

  sickLeaveDeduction: { type: Number, default: 0, min: 0 },
  // Human-readable, e.g. "Sick leave: 2 day(s) reduced-pay, 1 day(s)
  // unpaid" — empty string when there's nothing to dock.
  sickLeaveNote: { type: String, default: '' },

  gosiDeduction: { type: Number, default: 0, min: 0 },
  otherDeductions: { type: [deductionSchema], default: [] },
  totalDeductions: { type: Number, default: 0, min: 0 },

  netPay: { type: Number, required: true },
});

const payrollRunSchema = new mongoose.Schema(
  {
    periodYear: { type: Number, required: true, min: 2020, max: 2100 },
    periodMonth: { type: Number, required: true, min: 1, max: 12 },
    status: { type: String, enum: PAYROLL_STATUSES, default: 'Draft' },
    lines: { type: [payrollLineSchema], default: [] },

    totalGross: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One run per calendar month — re-running is "edit the existing Draft", not create a second.
payrollRunSchema.index({ periodYear: 1, periodMonth: 1 }, { unique: true });

export default mongoose.model('PayrollRun', payrollRunSchema);

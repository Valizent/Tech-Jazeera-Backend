/**
 * Settlement — a computed, persisted End-of-Service record for one employee
 * exit (P3-A). Deliberately NOT editable after creation: a financial/legal
 * figure like this should be corrected by deleting and recomputing, not
 * silently edited in place — same discipline as the app's other money
 * documents (a Quotation is edited before it's finalized business logic;
 * a Settlement only exists once the exit already happened).
 *
 * Every input that could change later (employee name, salary, joining date)
 * is SNAPSHOTTED here, exactly like Quotation's clientName — a settlement
 * must keep reading the same number even if the employee record is edited
 * or the employee is later deleted.
 */
import mongoose from 'mongoose';

// 'SponsorshipTransfer' added 2026-09-12 alongside Deployment's demobilise
// feature (a worker whose Iqama sponsorship transfers/"Tanazel"s to another
// employer) — safe to add with zero formula changes, since
// settlement.service.js's computeEosb only special-cases 'Resignation' for
// its reduction tiers; every other reason (this one included) already gets
// the full, unreduced award. A real Tanazel's legal EOSB treatment should
// ultimately be confirmed with the company's own HR/legal advisor — this
// reason stays fully editable on the settlement form regardless, so HR can
// override it before computing if that guidance differs.
export const EXIT_REASONS = ['Resignation', 'TerminationByEmployer', 'EndOfContract', 'SponsorshipTransfer'];

const settlementSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: { type: String, required: true },
    employeeCode: { type: String, required: true },

    joiningDate: { type: Date, required: true },
    exitDate: { type: Date, required: true },
    exitReason: { type: String, enum: EXIT_REASONS, required: true },
    monthlyWage: { type: Number, required: true, min: 0 },

    // Decimal years of continuous service as of exitDate (e.g. 4.92).
    serviceYears: { type: Number, required: true, min: 0 },

    // Labor Law Article 84: half-month/year for the first 5 years, full-month/year after.
    eosbGross: { type: Number, required: true, min: 0 },
    // Article 85's resignation tiering: 0, 1/3, 2/3, or 1. Always 1 unless exitReason is 'Resignation'.
    reductionFactor: { type: Number, required: true, min: 0, max: 1 },
    eosbNet: { type: Number, required: true, min: 0 },

    // Vacation Pay Settlement — unused Annual-leave balance encashed at exit.
    unusedLeaveDays: { type: Number, required: true, min: 0, default: 0 },
    leaveEncashment: { type: Number, required: true, min: 0, default: 0 },

    totalSettlement: { type: Number, required: true, min: 0 },

    notes: { type: String, trim: true, maxlength: 1000 },
    computedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// An employee's settlement history, newest first; the staff list, newest first.
settlementSchema.index({ employee: 1, createdAt: -1 });

export default mongoose.model('Settlement', settlementSchema);

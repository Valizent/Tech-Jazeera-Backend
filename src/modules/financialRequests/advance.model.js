/**
 * SalaryAdvance — a worker's own request for an advance against future
 * salary (PRD Module 4). Repayment is tracked here MANUALLY (a ledger of
 * recorded payments), never auto-deducted from Payroll — a deliberate,
 * still-current design choice (Payroll itself has existed since P2-M5;
 * unlike Deployment's own client-timesheet deductions, which DO flow
 * automatically into a PayrollRun's `otherDeductions`, nothing wires a
 * SalaryAdvance repayment into Payroll the same way — a staff member still
 * records each one by hand here). This model doesn't need to change shape
 * if that's ever revisited, only who calls addRepayment().
 *
 * Single-level Submit -> Approve/Reject is only the LEGACY fallback now —
 * SalaryAdvance runs through the same Configurable Approval Hierarchy
 * engine as Leave/Reimbursement/Timesheet (see approvalEngine.service.js),
 * so an Admin can configure a real multi-step workflow for it; this
 * model's `workflow`/`steps`/`currentStep`/`approvalTrail` fields are that
 * engine's standard shape. `null` workflow (the default until an Admin
 * configures one) still runs the original single-level flow unchanged.
 */
import mongoose from 'mongoose';

export const ADVANCE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Closed'];

/** One recorded repayment. _id disabled — a value object, append-only, never
 *  individually edited or removed (same convention as Document's versions). */
const repaymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 200 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false }
);

const advanceSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    amount: { type: Number, required: true, min: 1 },
    reason: { type: String, trim: true, maxlength: 500 },
    // How many months the worker proposes to repay over — informational
    // until Payroll can act on it automatically.
    repaymentMonths: { type: Number, min: 1, max: 24, default: 1 },

    status: { type: String, enum: ADVANCE_STATUSES, default: 'Pending' },
    // decidedBy/decidedAt/decisionNote mean "the FINAL decision only" once a
    // workflow governs this request (see approvals/approvalEngine.service.js)
    // — unchanged shape/meaning on the legacy (no-workflow) path.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    // Configurable Approval Hierarchy (post-Phase-3) — see
    // leaveRequest.model.js's identical fields for the full rationale.
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    workflowName: { type: String, default: null },
    steps: {
      type: [
        {
          label: String,
          roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
          _id: false,
        },
      ],
      default: undefined,
    },
    currentStep: { type: Number, default: 0 },
    approvalTrail: {
      type: [
        {
          step: Number,
          approvalRole: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole', default: null },
          viaAdminOverride: Boolean,
          approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          decision: { type: String, enum: ['Approved', 'Rejected'] },
          note: String,
          decidedAt: Date,
          _id: false,
        },
      ],
      default: undefined,
    },

    repayments: { type: [repaymentSchema], default: [] },
  },
  { timestamps: true }
);

// An employee's own request history; the staff review queue by status.
advanceSchema.index({ employee: 1, createdAt: -1 });
advanceSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('SalaryAdvance', advanceSchema);

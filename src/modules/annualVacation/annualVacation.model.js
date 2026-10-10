/**
 * AnnualVacationRequest — an employee's request for their annual vacation
 * after a contract period ends (the leave a worker takes before / between
 * contract periods to travel home).
 *
 * Runs through the same Configurable Approval Hierarchy engine as Leave,
 * Exit Re-Entry and Certificates (approvals/approvalEngine.service.js): no
 * `workflow` means the original single-level Admin/Manager/HR decision.
 * Approving it also creates the matching approved LeaveRequest
 * (`linkedLeaveRequest`) so attendance and the Leave screens show the
 * employee as on leave for those dates — see annualVacation.service.js.
 */
import mongoose from 'mongoose';

export const ANNUAL_VACATION_STATUSES = ['PendingReview', 'Approved', 'Rejected', 'Cancelled'];

const annualVacationSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    // Who filed it — the employee themself, or HR/staff on their behalf.
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    startDate: { type: Date, required: true },
    // Derived from startDate + requestedDays at submission (inclusive calendar days,
    // the same counting Leave uses) — never trusted from the client.
    endDate: { type: Date, required: true },
    requestedDays: { type: Number, required: true, min: 1, max: 90 },
    reason: { type: String, trim: true, maxlength: 1000 },

    status: { type: String, enum: ANNUAL_VACATION_STATUSES, default: 'PendingReview' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    // The approved LeaveRequest created on final approval (null until then).
    linkedLeaveRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest', default: null },

    // Configurable Approval Hierarchy — same shape as leaveRequest.model.js.
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
  },
  { timestamps: true }
);

annualVacationSchema.index({ employee: 1, createdAt: -1 });
annualVacationSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('AnnualVacationRequest', annualVacationSchema);

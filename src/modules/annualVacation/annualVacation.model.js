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
import { escalationLevelsField } from '../approvals/approvalFields.js';

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
    // The end date of the contract period this vacation follows, fixed when it is filed (2026-10-14). The first
    // day must come after it; one approved vacation per period; and when the contract was renewed since (its
    // current end date differs), approval pushes the new end date later by the days taken.
    periodEnd: { type: Date, default: null },
    contractPush: { from: Date, to: Date },
    // The notes the requester wrote (labelled "Remarks" on screen; the field keeps its original name).
    reason: { type: String, trim: true, maxlength: 1000 },

    // The contract's vacation days when the request was made (Employee.annualVacationDays). `requestedDays`
    // starts equal to it; HR may change it at the HR step, and `daysChange` keeps who changed what and why.
    contractDays: { type: Number, default: null },
    daysChange: {
      type: new mongoose.Schema(
        {
          from: Number,
          to: Number,
          note: { type: String, trim: true, maxlength: 500 },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          at: Date,
        },
        { _id: false }
      ),
      default: null,
    },

    // Documents attached while approving (air tickets and the like, any stage; `tickets` is the field's old name),
    // copied into the employee's restricted documents once the vacation is finally approved. `travelDate` and
    // `visaRequest` belong to the retired travel-documents step: kept only so requests that used it still show it.
    travelDate: { type: Date, default: null },
    tickets: {
      type: [
        {
          fileName: { type: String, required: true }, // storage id, never sent to a client
          resourceType: { type: String, required: true },
          originalName: { type: String, required: true },
          mimeType: { type: String, required: true },
          size: { type: Number, required: true },
          uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          uploadedAt: { type: Date, default: Date.now },
          // The stage it was attached at (index into `steps`) and that stage's label, for the list.
          step: { type: Number, default: null },
          stage: { type: String, default: null },
        },
      ],
      default: [],
    },
    visaRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ExitReentryRequest', default: null },

    // Roles told when this was submitted and when it is approved (copied from the workflow at submission,
    // like `steps`, so editing the workflow later does not change a request already under way).
    informRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },

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
          assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          escalation: escalationLevelsField(),
          _id: false,
        },
      ],
      default: undefined,
    },
    currentStep: { type: Number, default: 0 },
    // When the request reached its current step: the clock the escalation levels count from.
    currentStepEnteredAt: { type: Date, default: null },
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

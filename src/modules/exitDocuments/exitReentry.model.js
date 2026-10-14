/**
 * ExitReentryRequest — a worker's request for a Single or Multiple Exit
 * Re-Entry visa (PRD Module 6), the Jawazat/Muqeem permit an Iqama holder
 * needs to leave Saudi Arabia and return while still employed.
 *
 * This app tracks the REQUEST and its approval, not the government process
 * itself — there is no public API to actually issue one. Once Approved, HR
 * processes it externally (Muqeem/Jawazat) and records the outcome here via
 * `markIssued` (a reference number, for HR's own tracking) — the same
 * "we track the request, a human does the paperwork" shape as
 * CertificateRequest's ChamberOfCommerceAttestation type.
 */
import mongoose from 'mongoose';

export const VISA_TYPES = ['Single', 'Multiple'];
export const EXIT_REENTRY_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Issued'];

const exitReentrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    visaType: { type: String, enum: VISA_TYPES, required: true },
    departureDate: { type: Date, required: true },
    // For 'Single': the planned return date. For 'Multiple': the requested
    // validity end date (it permits repeated trips until then).
    expectedReturnDate: { type: Date, required: true },
    // Optional — "linked to annual leave" per the PRD. Ownership (same
    // employee) is checked at submission; it is NOT required to already be
    // Approved, since a worker often requests the visa while leave is still
    // pending review.
    linkedLeaveRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest', default: null },
    reason: { type: String, trim: true, maxlength: 500 },
    // Raised automatically from an annual vacation request (2026-10-14): the request it came from, and the
    // visa document Accounts upload when it is issued.
    annualVacation: { type: mongoose.Schema.Types.ObjectId, ref: 'AnnualVacationRequest', default: null },
    visaFile: {
      type: new mongoose.Schema(
        {
          fileName: { type: String, required: true },
          resourceType: { type: String, required: true },
          originalName: { type: String, required: true },
          mimeType: { type: String, required: true },
          size: { type: Number, required: true },
          uploadedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
    },

    status: { type: String, enum: EXIT_REENTRY_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    issuedAt: { type: Date, default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    visaReferenceNumber: { type: String, trim: true, maxlength: 100 },

    // Configurable Approval Hierarchy — null on every field below means "no
    // workflow governs this request," i.e. the original single-level flow
    // (decidedBy/At/Note set directly by whichever legacy-allowed role
    // decides it). Exact same shape as leaveRequest.model.js — see
    // approvals/approvalEngine.service.js.
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

exitReentrySchema.index({ employee: 1, createdAt: -1 });
exitReentrySchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('ExitReentryRequest', exitReentrySchema);

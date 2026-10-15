/**
 * CertificateRequest — a worker's request for an official letter (PRD
 * Module 6): a Salary Certificate or Service Certificate (this app
 * generates the PDF once approved, from the employee's own real record) or
 * a Chamber of Commerce Attestation (a physical government-adjacent
 * process this app cannot perform — tracked as a status only, no PDF; see
 * certificate.service.js).
 */
import mongoose from 'mongoose';

export const CERTIFICATE_TYPES = ['SalaryCertificate', 'ServiceCertificate', 'ChamberOfCommerceAttestation'];
/** Types this app can actually generate a document for. */
export const CERTIFICATE_TYPES_WITH_PDF = ['SalaryCertificate', 'ServiceCertificate'];
export const CERTIFICATE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Issued'];

const certificateRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: CERTIFICATE_TYPES, required: true },
    // What the worker says it's for (bank account, visa, new employer, …) —
    // shown to whoever decides, not printed on the certificate itself.
    purpose: { type: String, trim: true, maxlength: 300 },

    status: { type: String, enum: CERTIFICATE_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    // 'Issued' for a letter type = handed over (PDF downloaded/printed);
    // for the attestation type = the physical stamping is complete.
    issuedAt: { type: Date, default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Configurable Approval Hierarchy — same shape as leaveRequest.model.js /
    // exitReentry.model.js; null means the original single-level flow.
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    workflowName: { type: String, default: null },
    steps: {
      type: [
        {
          label: String,
          roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
          assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

certificateRequestSchema.index({ employee: 1, createdAt: -1 });
certificateRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('CertificateRequest', certificateRequestSchema);

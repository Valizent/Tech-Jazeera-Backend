/**
 * ReimbursementClaim — a worker's own expense claim with a receipt (PRD
 * Module 4). The receipt is a single embedded file, deliberately NOT stored
 * through the Documents module: Documents is a staff-managed compliance
 * archive (Admin/Manager/HR write-gated — passport, iqama, visa); a
 * worker-submitted receipt is a different trust category, so this module
 * owns its own minimal file record instead of punching a worker-upload hole
 * into Documents' RBAC. It reuses the same generic Cloudinary upload
 * middleware (middleware/upload.js), just not the Document model.
 *
 * Paid separately from Decided: approval says the claim is legitimate;
 * "Paid" is Accounts actually reimbursing it, which may happen days later.
 */
import mongoose from 'mongoose';
import { escalationLevelsField } from '../approvals/approvalFields.js';

export const REIMBURSEMENT_CATEGORIES = ['Travel', 'Fuel', 'Meals', 'Medical', 'Tools', 'Other'];
export const REIMBURSEMENT_STATUSES = ['Pending', 'Approved', 'Rejected', 'Paid'];

/** The stored receipt file. _id disabled — a value object, not an entity. */
const receiptSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true }, // Cloudinary public_id
    resourceType: { type: String, required: true }, // 'raw', from the upload middleware
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const reimbursementSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    category: { type: String, enum: REIMBURSEMENT_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    expenseDate: { type: Date, required: true },
    description: { type: String, trim: true, maxlength: 500 },
    receipt: { type: receiptSchema, required: true },

    status: { type: String, enum: REIMBURSEMENT_STATUSES, default: 'Pending' },
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

    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

reimbursementSchema.index({ employee: 1, createdAt: -1 });
reimbursementSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('ReimbursementClaim', reimbursementSchema);

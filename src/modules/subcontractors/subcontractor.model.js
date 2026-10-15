/**
 * Subcontractor — a company a mobilisation is sometimes routed through (see
 * mobilisations/mobilisation.model.js). Mirrors Client's shape, deliberately
 * simplified: no sites, no VAT/CR numbers — just enough
 * to identify who it is and reference them by id. A subcontractor added by anyone other than an Admin or
 * Manager waits for approval (the 'SubcontractorApproval' hierarchy) and cannot be put on a mobilisation until
 * it is approved. Other schemas reference a
 * Subcontractor by ObjectId, never embed — same "reference, don't duplicate"
 * rule as Client.
 */
import mongoose from 'mongoose';
import { companyProfileFields } from '../companyProfile/companyProfile.model.js';
import { approvalFields } from '../approvals/approvalFields.js';

export const SUBCONTRACTOR_STATUSES = ['Active', 'Inactive'];
export const SUBCONTRACTOR_APPROVAL_STATUSES = ['Approved', 'Pending', 'Rejected'];

const subcontractorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    status: { type: String, enum: SUBCONTRACTOR_STATUSES, default: 'Active' },
    creditLimitDays: { type: Number, default: 30, min: 0 },
    industry: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    crNumber: { type: String, trim: true },
    address: { type: String, trim: true },
    // Arabic name, CR expiry, National Address, Finance person, Owner and the
    // company's coordinators (2026-10-12) - shared with Client.
    ...companyProfileFields,
    notes: { type: String, trim: true, maxlength: 2000 },
    // Who added it (2026-10-12): the first missing-details reminder goes to them.
    // Null for subcontractors that predate this field.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Existing subcontractors (no field stored) read as Approved.
    approvalStatus: { type: String, enum: SUBCONTRACTOR_APPROVAL_STATUSES, default: 'Approved' },
    // Who decided a Pending submission, and how: null until a decision is made.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },
    // The approval hierarchy set up for 'SubcontractorApproval', fixed when the subcontractor is submitted.
    ...approvalFields(),
  },
  { timestamps: true }
);

subcontractorSchema.index({ name: 1 });
subcontractorSchema.index({ status: 1 });
subcontractorSchema.index({ approvalStatus: 1 });

export default mongoose.model('Subcontractor', subcontractorSchema);

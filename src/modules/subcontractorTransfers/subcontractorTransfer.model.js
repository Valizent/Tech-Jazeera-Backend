/**
 * SubcontractorTransfer - a request to move a subcontractor's employee from the
 * subcontractor our records hold him with to another (2026-10-12, milestone 5).
 *
 * Raised from a mobilisation: when a coordinator mobilises a known employee
 * through a subcontractor other than the one on record, the form asks whether
 * to move him. Yes creates one of these for the Marketing Manager. The
 * mobilisation may still be submitted, but its FINAL approval waits until the
 * request is approved. Approving updates the employee's record in the
 * outsourced register; rejecting sends the mobilisation back to its
 * coordinators with the reason.
 *
 * One live (Pending) request per mobilisation. Superseded or abandoned ones
 * become Cancelled rather than being deleted, so the history stays.
 */
import mongoose from 'mongoose';
import { approvalFields } from '../approvals/approvalFields.js';

export const TRANSFER_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

const companyRef = new mongoose.Schema(
  {
    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', required: true },
    name: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const transferSchema = new mongoose.Schema(
  {
    mobilisation: { type: mongoose.Schema.Types.ObjectId, ref: 'Mobilisation', required: true },
    mobilisationSerial: { type: String, required: true },
    workerName: { type: String, required: true, trim: true },
    iqamaNumber: { type: String, required: true, trim: true },
    from: { type: companyRef, required: true },
    to: { type: companyRef, required: true },
    status: { type: String, enum: TRANSFER_STATUSES, default: 'Pending' },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
    // The hierarchy set up for Subcontractor Transfer, fixed when the request is raised.
    ...approvalFields(),
  },
  { timestamps: true }
);

transferSchema.index({ mobilisation: 1, status: 1 });
transferSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('SubcontractorTransfer', transferSchema);

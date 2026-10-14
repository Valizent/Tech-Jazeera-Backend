/**
 * SubcontractorPayment — one bulk payment we make to a subcontractor toward our
 * OUTSTANDING invoiced months. Analogous to ClientPayment.
 */
import mongoose from 'mongoose';
import { approvalFields } from '../approvals/approvalFields.js';

export const SUBCONTRACTOR_PAYMENT_DECISION_STATUSES = ['Pending', 'Approved', 'Rejected'];

/** What the recorder chose (2026-10-13): the invoices this payment was picked
 *  to cover, in order, with what each takes. Empty on an older payment, which
 *  `allocated: false` marks as "oldest invoice first". */
const allocationSchema = new mongoose.Schema(
  {
    invoiceKey: { type: String, required: true },
    invoiceNumber: { type: String, default: null },
    amount: { type: Number, required: true, min: 0.01 },
  },
  { _id: false }
);

const subcontractorPaymentSchema = new mongoose.Schema(
  {
    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentReference: { type: String, trim: true, default: null, maxlength: 100 }, // e.g. receipt number, transfer number
    paymentDate: { type: Date, default: Date.now },
    // See clientPayment.model.js: the invoices picked for this payment, in order.
    allocated: { type: Boolean, default: false },
    allocations: { type: [allocationSchema], default: [] },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recordedAt: { type: Date, default: Date.now },
    decisionStatus: { type: String, enum: SUBCONTRACTOR_PAYMENT_DECISION_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
    // The hierarchy set up for this payment type, fixed when it is recorded.
    ...approvalFields(),
  },
  { timestamps: true }
);

subcontractorPaymentSchema.index({ subcontractor: 1, decisionStatus: 1 });

export default mongoose.model('SubcontractorPayment', subcontractorPaymentSchema);

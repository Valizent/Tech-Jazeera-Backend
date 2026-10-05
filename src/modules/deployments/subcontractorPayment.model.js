/**
 * SubcontractorPayment — one bulk payment we make to a subcontractor toward our
 * OUTSTANDING invoiced months. Analogous to ClientPayment.
 */
import mongoose from 'mongoose';

export const SUBCONTRACTOR_PAYMENT_DECISION_STATUSES = ['Pending', 'Approved', 'Rejected'];

const subcontractorPaymentSchema = new mongoose.Schema(
  {
    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentReference: { type: String, trim: true, default: null, maxlength: 100 }, // e.g. receipt number, transfer number
    paymentDate: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recordedAt: { type: Date, default: Date.now },
    decisionStatus: { type: String, enum: SUBCONTRACTOR_PAYMENT_DECISION_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true }
);

subcontractorPaymentSchema.index({ subcontractor: 1, decisionStatus: 1 });

export default mongoose.model('SubcontractorPayment', subcontractorPaymentSchema);

/**
 * ClientPayment — one bulk payment a client made toward their OUTSTANDING
 * invoiced months, across every worker placed there (2026-09-27, the user's
 * own correction: a client doesn't pay per worker, they send one combined
 * amount covering everyone). This is the entire ledger — how much of it
 * applies to which specific invoice is never stored here or anywhere else;
 * it's computed live, every time, by clientPayment.service.js's
 * computeClientAllocation (oldest outstanding invoice first, across every
 * Deployment that client has), the same "never cache a financial figure"
 * rule this app follows everywhere else. A rejected payment simply never
 * counts toward that computation — no rollback needed since nothing was
 * ever written outside this one document.
 *
 * Single-level Approve/Reject (Office Secretary records, Financial Manager
 * decides) — same split as the per-entry flow this replaces, just scoped to
 * a client instead of one worker's one month.
 */
import mongoose from 'mongoose';

export const CLIENT_PAYMENT_DECISION_STATUSES = ['Pending', 'Approved', 'Rejected'];

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

const clientPaymentSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentReference: { type: String, trim: true, default: null, maxlength: 100 }, // e.g. invoice number, cheque number
    paymentDate: { type: Date, default: Date.now },
    // true once the recorder picked invoices (then `allocations` is the order
    // they were picked in); false on a payment recorded before that existed.
    allocated: { type: Boolean, default: false },
    allocations: { type: [allocationSchema], default: [] },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recordedAt: { type: Date, default: Date.now },
    decisionStatus: { type: String, enum: CLIENT_PAYMENT_DECISION_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true }
);

clientPaymentSchema.index({ client: 1, decisionStatus: 1 });

export default mongoose.model('ClientPayment', clientPaymentSchema);

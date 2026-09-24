/**
 * Expense — a company-level cost (P2-M7), the other half of profit alongside
 * P2-M6's invoices. Feeds Dashboard v2 (P2-M8): Profit = Revenue − Payroll −
 * Expenses.
 *
 * Schema choices, justified:
 *  - `client`/`clientName` follow the same reference+snapshot pattern as
 *    Deployment/Quotation — an expense can optionally be attributed to a
 *    client (e.g. a purchase made for their project) without that link
 *    breaking if the client is later renamed or removed.
 *  - `deployment` is an optional plain reference, no snapshot — it is only
 *    ever read back joined with the deployment it points to (e.g. a fuel
 *    expense against a specific vehicle placement); unlike clientName there
 *    is no durable-history requirement forcing a separate snapshot field.
 *  - `receipt` is OPTIONAL (unlike the reimbursement claim's required one —
 *    a rent payment or utility bill does not always have a scan-able
 *    receipt) and, once set, immutable — editing an expense never touches
 *    it; get it right at entry or delete and re-add. Same embedded shape and
 *    the same generic Cloudinary upload middleware as ReimbursementClaim's
 *    receipt (middleware/upload.js) — two modules sharing infrastructure,
 *    not reaching into Documents (a different trust/compliance category).
 *  - `recordedBy` tracks who entered the expense — useful for a manually
 *    entered cost ledger the way `payments[].recordedBy` is on Invoice.
 *  - `sourceReimbursement` (optional ref) links an Expense that was
 *    AUTO-CREATED when a worker's ReimbursementClaim was marked Paid (see
 *    reimbursement.service.js's markReimbursementPaid) — closes a real gap:
 *    that money genuinely leaves the company but used to never appear in
 *    this ledger or the dashboard's profit figure. Always filed under the
 *    'Staff Reimbursement' category (never mapped onto Rent/Fuel/etc — the
 *    claim's own category is preserved in `notes` instead), so this ledger
 *    can tell "a direct company purchase" from "money paid back to a
 *    worker" apart at a glance, same distinction real bookkeeping makes.
 */
import mongoose from 'mongoose';

export const EXPENSE_CATEGORIES = ['Rent', 'Fuel', 'Salaries-external', 'Purchases', 'Utilities', 'Staff Reimbursement', 'Other'];

/** The stored receipt file. _id disabled — a value object, not an entity.
 *  Identical shape to ReimbursementClaim's receipt (middleware/upload.js). */
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

const expenseSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    vendor: { type: String, required: true, trim: true, maxlength: 150 },
    amount: { type: Number, required: true, min: 0.01 },

    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    clientName: { type: String, default: null }, // snapshot, set only when client is given
    deployment: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment', default: null },

    notes: { type: String, trim: true, maxlength: 1000 },
    receipt: { type: receiptSchema, default: null },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sourceReimbursement: { type: mongoose.Schema.Types.ObjectId, ref: 'ReimbursementClaim', default: null },
  },
  { timestamps: true }
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ category: 1, date: -1 });
expenseSchema.index({ client: 1 });

export default mongoose.model('Expense', expenseSchema);

/**
 * Invoice — created from an Approved Quotation (P2-M6), closing the revenue
 * loop: Quotation (offer) → Invoice (billed) → Payments (collected).
 *
 * Schema choices, justified:
 *  - `lineItems` are COPIED from the source Quotation at creation time, not
 *    referenced — an invoice must keep reading exactly what was billed even
 *    if the quotation is later edited (a Quotation is editable; a Draft
 *    Invoice is not — this app has no "Draft invoice" state at all, since
 *    an invoice only exists once actually issued).
 *  - `quotation`/`quotationNumber` is a reference + snapshot, same pattern
 *    as `client`/`clientName` — link while it exists, keep the number
 *    readable if it doesn't.
 *  - One invoice per quotation (the unique index): this is a straightforward
 *    "convert this approved offer into a bill" action, not a partial/
 *    split-billing workflow — that would be a deliberate, separate feature.
 *  - `payments` are EMBEDDED (they live and die with their invoice, exactly
 *    like a quotation's line items) with amountPaid/balanceDue/status always
 *    RECOMPUTED from the payments array, never trusted from the client —
 *    same discipline as quotation totals and the salary-advance ledger.
 */
import mongoose from 'mongoose';

export const INVOICE_STATUSES = ['Unpaid', 'Partially Paid', 'Paid'];
export const INVOICE_LINE_TYPES = ['Labour', 'Trading'];

/** Identical shape to Quotation's line item — copied, not imported, so an
 *  invoice never silently changes if Quotation's schema does. */
const invoiceLineItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: INVOICE_LINE_TYPES, required: true },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0, max: 100 },
    taxRate: { type: Number, default: 15, min: 0, max: 100 },
  },
  { _id: false }
);

/** One recorded payment. _id disabled — an append-only value object, same
 *  convention as the salary advance repayment ledger. */
const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    method: { type: String, trim: true, maxlength: 50 },
    reference: { type: String, trim: true, maxlength: 100 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation', required: true, unique: true },
    quotationNumber: { type: String, required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    clientName: { type: String, required: true },
    // Snapshot at creation, same durable-history reasoning as clientName —
    // a B2B ZATCA tax invoice must show the buyer's VAT number when they
    // have one; a later edit to the Client record must never retroactively
    // change what an already-issued invoice says. Null when the client has
    // no VAT number on file (never invented).
    clientVatNumber: { type: String, default: null },

    date: { type: Date, default: Date.now },
    dueDate: { type: Date, default: null },

    lineItems: { type: [invoiceLineItemSchema], required: true },
    notes: { type: String, trim: true, maxlength: 2000 },

    // Computed from lineItems at creation — an invoice's billed amount is
    // frozen at issue time, unlike a Quotation which can still be edited.
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    payments: { type: [paymentSchema], default: [] },
    // Always recomputed from `payments` — never set directly.
    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'Unpaid' },

    // Sum of every CreditNote issued against this invoice — always
    // recomputed from creditNote.service.js's own atomic update, same
    // never-trust-a-cached-figure discipline as amountPaid/balanceDue.
    // `balanceDue` already has any credited amount subtracted out of it;
    // this is kept separately so the PDF/detail view can show "Grand Total"
    // and "Credited" as two honest, separate lines rather than silently
    // rewriting the original grand total.
    creditedTotal: { type: Number, default: 0 },

    // Set once, the first time this invoice is found overdue by the daily
    // background job (overdueInvoice.job.js) — prevents re-notifying every
    // single day for the same still-overdue invoice. Reset to null if a
    // payment brings it current again, so a LATER relapse notifies again.
    overdueNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

invoiceSchema.index({ client: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ createdAt: -1 });
// The dashboard's monthly profit-trend aggregate (dashboard.service.js)
// range-matches on `date` (the invoice's own dated line-item total, not
// `createdAt`) — added 2026-09-22, a real QA-audit finding (P10): that
// query was doing a full COLLSCAN with no supporting index.
invoiceSchema.index({ date: 1 });

export default mongoose.model('Invoice', invoiceSchema);

/**
 * CreditNote — a formal correction against an issued Invoice (2026-09-24).
 * Closes a real gap: until now, the only way to undo a wrong invoice was
 * deleting it, and only before any payment was recorded — real accounting
 * practice (and ZATCA's own e-invoicing rules once fully onboarded) wants a
 * linked correction document instead, never a disappearing invoice.
 *
 * Schema choices, justified — deliberately mirroring Invoice's own:
 *  - `lineItems` reuse the exact same shape as Invoice's own (type/
 *    description/quantity/unitPrice/discount/taxRate), computed through the
 *    SAME computeTotals() formula — a credit note is structurally its own
 *    small tax document, not just a bare number, so it can carry a real VAT
 *    breakdown the way ZATCA expects.
 *  - `invoice`/`invoiceNumber` and `client`/`clientName` are reference +
 *    snapshot, same pattern as everywhere else in this app — the credit
 *    note keeps reading correctly even if the invoice or client is later
 *    renamed (an invoice itself is never edited after issue, so this is
 *    mostly a query-convenience snapshot, not a durable-history necessity).
 *  - No `payments`/status lifecycle: a credit note is not itself billed or
 *    paid — it only reduces what the ORIGINAL invoice still owes (see
 *    creditNote.service.js's atomic update against Invoice.creditedTotal/
 *    balanceDue). No delete route either — once issued, permanent, same
 *    posture as a real accounting document.
 *  - `reason` is required (unlike a plain amount adjustment) — a credit
 *    note without an explanation is exactly the kind of unaccountable money
 *    movement this app's audit-logging discipline exists to prevent.
 */
import mongoose from 'mongoose';

/** Identical shape to Invoice's own line item — copied, not imported, same
 *  "never let one document's schema drift silently change another's"
 *  reasoning invoice.model.js's own doc comment gives for not importing
 *  Quotation's. */
const creditNoteLineItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Labour', 'Trading'], required: true },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0, max: 100 },
    taxRate: { type: Number, default: 15, min: 0, max: 100 },
  },
  { _id: false }
);

const creditNoteSchema = new mongoose.Schema(
  {
    creditNoteNumber: { type: String, required: true, unique: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
    invoiceNumber: { type: String, required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    clientName: { type: String, required: true },

    date: { type: Date, default: Date.now },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },

    lineItems: { type: [creditNoteLineItemSchema], required: true },

    // Computed from lineItems at creation — never trusted from the client,
    // same discipline as Invoice/Quotation totals.
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

creditNoteSchema.index({ invoice: 1 });
creditNoteSchema.index({ createdAt: -1 });

export default mongoose.model('CreditNote', creditNoteSchema);

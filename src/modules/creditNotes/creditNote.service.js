/**
 * Credit note service — issue a correction against an invoice, list/get.
 * No update/delete: once issued, a credit note is a permanent accounting
 * record, same posture as a finalized payroll run or a decided approval.
 */
import Invoice from '../invoices/invoice.model.js';
import CreditNote from './creditNote.model.js';
import { nextSequence } from '../quotations/counter.model.js';
import ApiError from '../../utils/ApiError.js';
import { computeTotals, roundMoney } from '../../utils/moneyMath.js';
import { logAudit } from '../audit/audit.service.js';

async function newCreditNoteNumber() {
  const seq = await nextSequence('creditNote');
  return `CN-${String(seq).padStart(4, '0')}`;
}

export async function createCreditNote({ invoice: invoiceId, reason, lineItems }, actor) {
  const invoice = await Invoice.findById(invoiceId).lean();
  if (!invoice) throw new ApiError(404, 'Invoice not found.');

  const totals = computeTotals(lineItems);
  const remainingCreditable = roundMoney(invoice.grandTotal - invoice.creditedTotal);
  if (totals.grandTotal > remainingCreditable) {
    throw new ApiError(
      400,
      `That exceeds what's left to credit on this invoice (SAR ${remainingCreditable} of SAR ${invoice.grandTotal} not yet credited).`
    );
  }

  // Atomic, not read-then-save (same class of race invoice.service.js's
  // recordPayment and advance.service.js's addRepayment both guard against):
  // two concurrent credit notes could each pass the plain-JS check above
  // against the same stale `creditedTotal`, then both write, over-crediting
  // the invoice. `$expr` re-sums against the CURRENT document at write time.
  // balanceDue is floored at 0 with $max — a credit note issued after the
  // invoice was already fully paid reduces what was OWED, not what was
  // already collected; this app has no refund-tracking concept, a
  // deliberate scope line (see docs/CHANGELOG.md's ZATCA planning entry).
  const updated = await Invoice.findOneAndUpdate(
    {
      _id: invoiceId,
      $expr: { $lte: [{ $round: [{ $add: ['$creditedTotal', totals.grandTotal] }, 2] }, { $round: ['$grandTotal', 2] }] },
    },
    [
      {
        $set: {
          creditedTotal: { $round: [{ $add: ['$creditedTotal', totals.grandTotal] }, 2] },
          balanceDue: { $max: [0, { $round: [{ $subtract: ['$balanceDue', totals.grandTotal] }, 2] }] },
        },
      },
      {
        $set: {
          status: { $cond: [{ $lte: ['$balanceDue', 0] }, 'Paid', '$status'] },
          overdueNotifiedAt: { $cond: [{ $lte: ['$balanceDue', 0] }, null, '$overdueNotifiedAt'] },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    const fresh = await Invoice.findById(invoiceId).lean();
    if (!fresh) throw new ApiError(404, 'Invoice not found.');
    const freshRemaining = roundMoney(fresh.grandTotal - fresh.creditedTotal);
    throw new ApiError(400, `That exceeds what's left to credit on this invoice (SAR ${freshRemaining} not yet credited).`);
  }

  const creditNote = await CreditNote.create({
    creditNoteNumber: await newCreditNoteNumber(),
    invoice: invoice._id,
    invoiceNumber: invoice.invoiceNumber,
    client: invoice.client,
    clientName: invoice.clientName,
    reason,
    lineItems,
    ...totals,
    createdBy: actor.userId,
  });

  await logAudit({
    user: actor.userId,
    action: 'creditNote.create',
    targetType: 'CreditNote',
    targetId: creditNote._id,
    meta: { number: creditNote.creditNoteNumber, invoice: invoice.invoiceNumber, grandTotal: creditNote.grandTotal },
    ip: actor.ip,
  });
  return creditNote.toObject();
}

export async function listCreditNotes({ invoice, page, limit, search }) {
  const conditions = [];
  if (invoice) conditions.push({ invoice });
  if (search) {
    const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    conditions.push({ $or: [{ creditNoteNumber: rx }, { invoiceNumber: rx }, { clientName: rx }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};
  const [items, total] = await Promise.all([
    CreditNote.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CreditNote.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getCreditNote(id) {
  const creditNote = await CreditNote.findById(id).lean();
  if (!creditNote) throw new ApiError(404, 'Credit note not found.');
  return creditNote;
}

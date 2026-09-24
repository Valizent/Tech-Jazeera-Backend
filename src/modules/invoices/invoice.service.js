/**
 * Invoice service — create from an Approved quotation, record payments,
 * list/get/delete. Money is always server-computed, same discipline as
 * quotation totals.
 */
import mongoose from 'mongoose';
import Quotation from '../quotations/quotation.model.js';
import Client from '../clients/client.model.js';
import { nextSequence } from '../quotations/counter.model.js';
import Invoice from './invoice.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { computeTotals } from '../../utils/moneyMath.js';

async function newInvoiceNumber() {
  const seq = await nextSequence('invoice');
  return `INV-${String(seq).padStart(4, '0')}`;
}

export async function createInvoice({ quotation: quotationId, dueDate }, actor) {
  const quotation = await Quotation.findById(quotationId).lean();
  if (!quotation) throw new ApiError(404, 'Quotation not found.');
  if (quotation.status !== 'Approved') {
    throw new ApiError(400, 'Only an approved quotation can be invoiced.');
  }
  const existing = await Invoice.findOne({ quotation: quotationId }).lean();
  if (existing) throw new ApiError(409, `This quotation already has an invoice (${existing.invoiceNumber}).`);

  const client = await Client.findById(quotation.client).select('vatNumber').lean();
  const totals = computeTotals(quotation.lineItems);
  const invoice = await Invoice.create({
    invoiceNumber: await newInvoiceNumber(),
    quotation: quotation._id,
    quotationNumber: quotation.quotationNumber,
    client: quotation.client,
    clientName: quotation.clientName,
    clientVatNumber: client?.vatNumber || null,
    dueDate: dueDate ?? null,
    lineItems: quotation.lineItems,
    notes: quotation.notes,
    ...totals,
    // Nothing paid yet — the whole grand total is outstanding from day one.
    balanceDue: totals.grandTotal,
  });

  await logAudit({
    user: actor.userId,
    action: 'invoice.create',
    targetType: 'Invoice',
    targetId: invoice._id,
    meta: { number: invoice.invoiceNumber, from: quotation.quotationNumber, grandTotal: invoice.grandTotal },
    ip: actor.ip,
  });
  return invoice.toObject();
}

export async function listInvoices({ page, limit, client, quotation, status, overdue, search }) {
  const conditions = [];
  if (client) conditions.push({ client });
  if (quotation) conditions.push({ quotation });
  if (status) conditions.push({ status });
  // Same definition overdueInvoice.job.js and invoiceColumns.jsx's own
  // isOverdue() already use — kept in one place server-side so the
  // Financial hub's badge count and this list can never disagree.
  if (overdue) conditions.push({ status: { $ne: 'Paid' }, dueDate: { $ne: null, $lt: new Date() } });
  if (search) {
    const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    conditions.push({ $or: [{ invoiceNumber: rx }, { clientName: rx }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Invoice.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getInvoice(id) {
  const invoice = await Invoice.findById(id).lean();
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  return invoice;
}

export async function recordPayment(id, data, actor) {
  const invoice = await Invoice.findById(id).lean();
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  if (invoice.status === 'Paid') throw new ApiError(400, 'This invoice is already fully paid.');
  if (data.amount > invoice.balanceDue) {
    throw new ApiError(400, `That exceeds the balance due (SAR ${invoice.balanceDue}).`);
  }

  // Atomic update, not read-then-save (fixed 2026-09-14, a real QA-audit-
  // found race — F1): two concurrent payments could both pass the plain-JS
  // balance check above against the SAME stale in-memory read, then both
  // save, overpaying the invoice. The filter's `balanceDue: { $gte:
  // data.amount }` re-checks the real, current balance atomically at write
  // time — MongoDB guarantees only one concurrent writer can match it once
  // the balance drops below the next payment's amount, so a losing request
  // gets `null` back instead of silently succeeding.
  //
  // `$literal` around the appended payment (fixed 2026-09-15, a real
  // QA-audit-found injection — S1): this is a PIPELINE update ([...] array
  // form), not a plain update document — Mongo evaluates every value in it
  // as an aggregation expression, so a validated-as-a-string `reference` or
  // `method` like "$clientName" or "$$ROOT" was silently resolved against
  // the CURRENT document instead of stored as the literal text the user
  // typed. `$literal` tells Mongo to store its argument verbatim, dollar
  // signs and all. `recordedBy` is also explicitly cast to ObjectId here —
  // a pipeline update bypasses Mongoose's normal schema-driven casting
  // entirely, so the bare `actor.userId` string was being stored with the
  // wrong BSON type for a `ref: 'User'` field.
  const updated = await Invoice.findOneAndUpdate(
    { _id: id, status: { $ne: 'Paid' }, balanceDue: { $gte: data.amount } },
    [
      {
        $set: {
          payments: {
            $concatArrays: [
              '$payments',
              [{ $literal: { ...data, recordedBy: new mongoose.Types.ObjectId(actor.userId) } }],
            ],
          },
        },
      },
      {
        $set: {
          amountPaid: { $round: [{ $add: ['$amountPaid', data.amount] }, 2] },
          balanceDue: { $round: [{ $subtract: ['$balanceDue', data.amount] }, 2] },
        },
      },
      {
        $set: {
          status: { $cond: [{ $lte: ['$balanceDue', 0] }, 'Paid', 'Partially Paid'] },
          // Cleared once paid off — see overdueInvoice.job.js's own doc
          // comment. No real path currently makes an already-Paid invoice
          // overdue again (dueDate is set once, never edited), but this
          // keeps the dedupe field honestly reset rather than relying on
          // that staying true forever.
          overdueNotifiedAt: { $cond: [{ $lte: ['$balanceDue', 0] }, null, '$overdueNotifiedAt'] },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    // Someone else's concurrent payment landed first — re-fetch for an
    // accurate, current error instead of repeating the stale one above.
    const fresh = await Invoice.findById(id).lean();
    if (!fresh) throw new ApiError(404, 'Invoice not found.');
    if (fresh.status === 'Paid') throw new ApiError(400, 'This invoice is already fully paid.');
    throw new ApiError(400, `That exceeds the balance due (SAR ${fresh.balanceDue}).`);
  }

  await logAudit({
    user: actor.userId,
    action: 'invoice.payment.record',
    targetType: 'Invoice',
    targetId: updated._id,
    meta: { amount: data.amount, newStatus: updated.status, balanceDue: updated.balanceDue },
    ip: actor.ip,
  });
  return updated.toObject();
}

export async function deleteInvoice(id, actor) {
  const invoice = await Invoice.findById(id).lean();
  if (!invoice) throw new ApiError(404, 'Invoice not found.');
  if (invoice.payments.length > 0) {
    throw new ApiError(400, 'An invoice with recorded payments cannot be deleted.');
  }

  await Invoice.deleteOne({ _id: id });
  await logAudit({
    user: actor.userId,
    action: 'invoice.delete',
    targetType: 'Invoice',
    targetId: invoice._id,
    meta: { number: invoice.invoiceNumber },
    ip: actor.ip,
  });
}

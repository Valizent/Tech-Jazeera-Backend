/**
 * invoice.service.test.js — regression coverage for the two real,
 * QA-audit-found bugs fixed in recordPayment (see docs/QA-AUDIT-2026-09-15-
 * notes.md, S1 and F1's sibling class):
 *   S1: a pipeline update evaluates every field as an aggregation
 *       expression — an unwrapped `$clientName`/`$$ROOT` string would
 *       resolve against the document instead of storing literally.
 *   F1-class race: two concurrent payments read-then-saved against the same
 *       stale balance could both succeed and overpay the invoice; the fix
 *       re-checks `balanceDue` atomically in the update filter itself.
 */
import mongoose from 'mongoose';
import Invoice from './invoice.model.js';
import { recordPayment } from './invoice.service.js';

function actor() {
  return { userId: new mongoose.Types.ObjectId().toString(), ip: '127.0.0.1' };
}

async function makeInvoice(grandTotal = 100) {
  return Invoice.create({
    invoiceNumber: `INV-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    quotation: new mongoose.Types.ObjectId(),
    quotationNumber: 'QUO-0001',
    client: new mongoose.Types.ObjectId(),
    clientName: 'Test Client',
    lineItems: [{ type: 'Labour', description: 'Test', quantity: 1, unitPrice: grandTotal }],
    subtotal: grandTotal,
    grandTotal,
    balanceDue: grandTotal,
  });
}

describe('invoice.service recordPayment', () => {
  it('S1: stores a $-prefixed reference/method/note as literal text, not as an aggregation expression', async () => {
    const invoice = await makeInvoice(100);
    const updated = await recordPayment(
      invoice._id.toString(),
      { amount: 10, date: new Date(), reference: '$clientName', method: '$$ROOT', note: '$reason' },
      actor()
    );
    const payment = updated.payments.at(-1);
    expect(payment.reference).toBe('$clientName');
    expect(payment.method).toBe('$$ROOT');
    expect(payment.note).toBe('$reason');

    // Also confirm via a raw BSON read straight off the driver, bypassing
    // any read-side behavior Mongoose might apply — the report's own
    // verification bar.
    const raw = await mongoose.connection.db
      .collection('invoices')
      .findOne({ _id: invoice._id });
    expect(raw.payments.at(-1).reference).toBe('$clientName');
  });

  it('S1: recordedBy is cast to a real ObjectId, not stored as a bare string', async () => {
    const invoice = await makeInvoice(100);
    const act = actor();
    const updated = await recordPayment(invoice._id.toString(), { amount: 10, date: new Date() }, act);
    const payment = updated.payments.at(-1);
    expect(payment.recordedBy).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(payment.recordedBy.toString()).toBe(act.userId);
  });

  it('F1-class race: two concurrent payments that together exceed the balance — exactly one succeeds', async () => {
    const invoice = await makeInvoice(100);
    const results = await Promise.allSettled([
      recordPayment(invoice._id.toString(), { amount: 70, date: new Date() }, actor()),
      recordPayment(invoice._id.toString(), { amount: 70, date: new Date() }, actor()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(400);

    const fresh = await Invoice.findById(invoice._id).lean();
    expect(fresh.amountPaid).toBe(70);
    expect(fresh.balanceDue).toBe(30);
    expect(fresh.payments).toHaveLength(1);
  });

  it('two concurrent payments that together exactly cover the balance both succeed and the invoice closes Paid', async () => {
    const invoice = await makeInvoice(100);
    const results = await Promise.allSettled([
      recordPayment(invoice._id.toString(), { amount: 60, date: new Date() }, actor()),
      recordPayment(invoice._id.toString(), { amount: 40, date: new Date() }, actor()),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const fresh = await Invoice.findById(invoice._id).lean();
    expect(fresh.balanceDue).toBe(0);
    expect(fresh.status).toBe('Paid');
    expect(fresh.payments).toHaveLength(2);
  });
});

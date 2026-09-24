/**
 * creditNote.service.test.js — same coverage class as invoice.service.js's
 * own recordPayment tests (this file's createCreditNote uses the identical
 * atomic-pipeline-update pattern against Invoice): a race where two
 * concurrent credit notes could over-credit the same invoice, and the
 * business rule that a credit note can never exceed what's left to credit.
 */
import mongoose from 'mongoose';
import Invoice from '../invoices/invoice.model.js';
import { createCreditNote } from './creditNote.service.js';

function actor() {
  return { userId: new mongoose.Types.ObjectId().toString(), ip: '127.0.0.1' };
}

async function makeInvoice(grandTotal = 100) {
  return Invoice.create({
    invoiceNumber: `INV-CN-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const lineItems = (amount) => [{ type: 'Labour', description: 'Correction', quantity: 1, unitPrice: amount }];

describe('creditNote.service createCreditNote', () => {
  it('reduces the invoice balanceDue and sets creditedTotal', async () => {
    const invoice = await makeInvoice(100);
    const cn = await createCreditNote({ invoice: invoice._id.toString(), reason: 'Overcharged', lineItems: lineItems(30) }, actor());
    expect(cn.grandTotal).toBe(30);

    const updated = await Invoice.findById(invoice._id).lean();
    expect(updated.creditedTotal).toBe(30);
    expect(updated.balanceDue).toBe(70);
    expect(updated.status).toBe('Unpaid');
  });

  it('marks the invoice Paid once fully credited and clears overdueNotifiedAt', async () => {
    const invoice = await makeInvoice(100);
    await Invoice.updateOne({ _id: invoice._id }, { overdueNotifiedAt: new Date() });

    await createCreditNote({ invoice: invoice._id.toString(), reason: 'Full write-off', lineItems: lineItems(100) }, actor());

    const updated = await Invoice.findById(invoice._id).lean();
    expect(updated.balanceDue).toBe(0);
    expect(updated.status).toBe('Paid');
    expect(updated.overdueNotifiedAt).toBeNull();
  });

  it('refuses a credit note that would exceed what is left to credit', async () => {
    const invoice = await makeInvoice(100);
    await createCreditNote({ invoice: invoice._id.toString(), reason: 'First correction', lineItems: lineItems(60) }, actor());

    await expect(
      createCreditNote({ invoice: invoice._id.toString(), reason: 'Second correction', lineItems: lineItems(50) }, actor())
    ).rejects.toThrow(/exceeds what's left to credit/);

    const updated = await Invoice.findById(invoice._id).lean();
    expect(updated.creditedTotal).toBe(60); // unchanged by the refused attempt
  });

  it('race: two concurrent credit notes can never together over-credit the invoice', async () => {
    const invoice = await makeInvoice(100);

    const results = await Promise.allSettled([
      createCreditNote({ invoice: invoice._id.toString(), reason: 'A', lineItems: lineItems(70) }, actor()),
      createCreditNote({ invoice: invoice._id.toString(), reason: 'B', lineItems: lineItems(70) }, actor()),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBe(1); // only one of the two 70-vs-100 attempts can fit

    const updated = await Invoice.findById(invoice._id).lean();
    expect(updated.creditedTotal).toBe(70);
    expect(updated.balanceDue).toBe(30);
  });
});

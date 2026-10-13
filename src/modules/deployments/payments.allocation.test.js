/**
 * payments.allocation.test.js - recording a payment against invoices the
 * recorder picks, in order (2026-10-13): the amount fills them in that order
 * (the last may be part-paid), what is left stays as credit that joins the next
 * payment, older payments keep "oldest invoice first", and the same holds for
 * payments to a subcontractor.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from './deployment.model.js';
import ClientPayment from './clientPayment.model.js';
import { getClientAllocation, recordClientPaymentForInvoices } from './deployment.service.js';
import { decideClientPayment } from './clientPayment.service.js';
import { getSubcontractorAllocation, recordSubcontractorPaymentForInvoices } from './subcontractorInvoice.service.js';
import { decideSubcontractorPayment } from './subcontractorPayment.service.js';
import { allocatePayments, planAllocations } from './paymentAllocation.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });
const day = (n) => new Date(Date.UTC(2026, 5, n));

/** A client with three invoices (A 4,000, B 5,000, C 3,500), sent in that order, none paid. */
async function clientWithInvoices() {
  const client = await Client.create({ companyName: `Client ${unique()}` });
  const mobilisation = await Mobilisation.create({
    serialNumber: `MOB-P${unique()}`,
    workerType: 'Freelancer',
    workerName: 'Billed Worker',
    jobTitle: 'Labour',
    client: client._id,
    clientName: client.companyName,
    clientRate: 10,
    otClientRate: 10,
    mobilisationDate: new Date('2026-01-01'),
    createdBy: new mongoose.Types.ObjectId(),
    coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
  });
  const entry = (month, hours, number, sent) => ({
    month,
    contractHours: hours,
    actualHours: hours,
    otHours: 0,
    enteredBy: new mongoose.Types.ObjectId(),
    status: 'Approved',
    invoiceSentAt: sent,
    invoiceNumber: number,
    invoiceDate: sent,
    invoiceDueAt: day(28),
  });
  await Deployment.create({
    mobilisation: mobilisation._id,
    workerType: 'Freelancer',
    workerName: 'Billed Worker',
    client: client._id,
    clientName: client.companyName,
    startDate: new Date('2026-01-01'),
    monthlyHours: [entry('2026-02', 400, 'INV-A', day(1)), entry('2026-03', 500, 'INV-B', day(2)), entry('2026-04', 350, 'INV-C', day(3))],
  });
  return String(client._id);
}

const key = (number) => `no:${number.toLowerCase()}`;
const balances = async (clientId) => {
  const { perEntry, creditBalance } = await getClientAllocation(clientId);
  const out = Object.fromEntries(perEntry.map((e) => [e.invoiceNumber, e.balanceDue]));
  return { ...out, credit: creditBalance };
};
async function pay(clientId, amount, invoiceKeys) {
  const actor = admin();
  const payment = await recordClientPaymentForInvoices(clientId, { amount, ...(invoiceKeys && { invoiceKeys }) }, actor);
  await decideClientPayment(String(payment._id), { decision: 'Approved' }, actor);
  return payment;
}

describe('a payment picked against invoices, in order', () => {
  it('fills them in the picked order and leaves the last part-paid', async () => {
    const clientId = await clientWithInvoices();
    const payment = await recordClientPaymentForInvoices(
      clientId,
      { amount: 10_000, invoiceKeys: [key('INV-A'), key('INV-B'), key('INV-C')] },
      admin()
    );
    expect(payment.allocated).toBe(true);
    expect(payment.allocations.map((a) => [a.invoiceNumber, a.amount])).toEqual([
      ['INV-A', 4000],
      ['INV-B', 5000],
      ['INV-C', 1000],
    ]);
    // Pending: nothing counts yet.
    expect(await balances(clientId)).toEqual({ 'INV-A': 4000, 'INV-B': 5000, 'INV-C': 3500, credit: 0 });

    await decideClientPayment(String(payment._id), { decision: 'Approved' }, admin());
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 0, 'INV-C': 2500, credit: 0 });
  });

  it('follows the picked order, not the order the invoices were sent in', async () => {
    const clientId = await clientWithInvoices();
    await pay(clientId, 5000, [key('INV-C'), key('INV-A')]);
    expect(await balances(clientId)).toEqual({ 'INV-A': 2500, 'INV-B': 5000, 'INV-C': 0, credit: 0 });
  });

  it('keeps what is left as credit and adds it to the next payment', async () => {
    const clientId = await clientWithInvoices();
    await pay(clientId, 15_000, [key('INV-A')]); // A takes 4,000, 11,000 stays as credit
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 5000, 'INV-C': 3500, credit: 11_000 });

    // 1,000 received now; with the credit that is 12,000 for B (5,000) and C (3,500).
    const next = await recordClientPaymentForInvoices(clientId, { amount: 1000, invoiceKeys: [key('INV-B'), key('INV-C')] }, admin());
    expect(next.allocations.map((a) => a.amount)).toEqual([5000, 3500]);
    await decideClientPayment(String(next._id), { decision: 'Approved' }, admin());
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 0, 'INV-C': 0, credit: 3500 });
  });

  it('a rejected payment applies nothing', async () => {
    const clientId = await clientWithInvoices();
    const payment = await recordClientPaymentForInvoices(clientId, { amount: 4000, invoiceKeys: [key('INV-A')] }, admin());
    await decideClientPayment(String(payment._id), { decision: 'Rejected', note: 'wrong client' }, admin());
    expect(await balances(clientId)).toEqual({ 'INV-A': 4000, 'INV-B': 5000, 'INV-C': 3500, credit: 0 });
  });

  it('refuses an invoice that is not outstanding and one picked twice', async () => {
    const clientId = await clientWithInvoices();
    await expect(recordClientPaymentForInvoices(clientId, { amount: 100, invoiceKeys: [key('INV-Z')] }, admin())).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      recordClientPaymentForInvoices(clientId, { amount: 100, invoiceKeys: [key('INV-A'), key('INV-A')] }, admin())
    ).rejects.toMatchObject({ statusCode: 400 });
    await pay(clientId, 4000, [key('INV-A')]);
    await expect(recordClientPaymentForInvoices(clientId, { amount: 100, invoiceKeys: [key('INV-A')] }, admin())).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('a payment recorded without picking invoices', () => {
  it('is applied oldest invoice first, as before', async () => {
    const clientId = await clientWithInvoices();
    await pay(clientId, 6000);
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 3000, 'INV-C': 3500, credit: 0 });
  });

  it('a payment stored before this existed (no allocated flag) is applied oldest first, and picked ones follow', async () => {
    const clientId = await clientWithInvoices();
    await ClientPayment.collection.insertOne({
      client: new mongoose.Types.ObjectId(clientId),
      amount: 4500,
      paymentDate: day(10),
      recordedBy: new mongoose.Types.ObjectId(),
      recordedAt: day(10),
      decisionStatus: 'Approved',
    });
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 4500, 'INV-C': 3500, credit: 0 });
    await pay(clientId, 3500, [key('INV-C')]);
    expect(await balances(clientId)).toEqual({ 'INV-A': 0, 'INV-B': 4500, 'INV-C': 0, credit: 0 });
  });
});

describe('payments to a subcontractor work the same way', () => {
  it('fills the picked invoices in order', async () => {
    const subcontractor = await Subcontractor.create({ name: `Sub ${unique()}` });
    const client = await Client.create({ companyName: `Client ${unique()}` });
    const mobilisation = await Mobilisation.create({
      serialNumber: `MOB-S${unique()}`,
      workerType: 'SupplierEmployee',
      workerName: 'Supplied Worker',
      jobTitle: 'Labour',
      client: client._id,
      clientName: client.companyName,
      subcontractor: subcontractor._id,
      subcontractorName: subcontractor.name,
      clientRate: 30,
      otClientRate: 30,
      subcontractorRate: 20,
      mobilisationDate: new Date('2026-01-01'),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    const entry = (month, hours, number, received) => ({
      month,
      contractHours: hours,
      actualHours: hours,
      supplierHours: hours,
      otHours: 0,
      enteredBy: new mongoose.Types.ObjectId(),
      status: 'Approved',
      subcontractorInvoiceReceivedAt: received,
      subcontractorInvoiceNumber: number,
      subcontractorInvoiceDate: received,
      subcontractorInvoiceDueAt: day(28),
    });
    await Deployment.create({
      mobilisation: mobilisation._id,
      workerType: 'SupplierEmployee',
      workerName: 'Supplied Worker',
      client: client._id,
      clientName: client.companyName,
      subcontractor: subcontractor._id,
      subcontractorName: subcontractor.name,
      startDate: new Date('2026-01-01'),
      monthlyHours: [entry('2026-02', 100, 'S-1', day(1)), entry('2026-03', 150, 'S-2', day(2))], // 2,000 and 3,000
    });
    const subId = String(subcontractor._id);
    const actor = admin();
    const payment = await recordSubcontractorPaymentForInvoices(subId, { amount: 2500, invoiceKeys: [key('S-2'), key('S-1')] }, actor);
    expect(payment.allocations.map((a) => [a.invoiceNumber, a.amount])).toEqual([
      ['S-2', 2500],
    ]);
    await decideSubcontractorPayment(String(payment._id), { decision: 'Approved' }, actor);
    const { perEntry, creditBalance } = await getSubcontractorAllocation(subId);
    expect(Object.fromEntries(perEntry.map((e) => [e.invoiceNumber, e.balanceDue]))).toEqual({ 'S-1': 2000, 'S-2': 500 });
    expect(creditBalance).toBe(0);
  });
});

describe('the pure allocation functions', () => {
  const item = (number, revenue, sent) => ({ entryId: number, invoiceNumber: number, revenue, invoiceSentAt: day(sent) });

  it('groups entries sharing an invoice number into one invoice', () => {
    const items = [item('INV-1', 1000, 1), { ...item('INV-1', 500, 1), entryId: 'second' }, item('INV-2', 800, 2)];
    const payment = { _id: 'p1', amount: 1200, paymentDate: day(5), allocated: true, allocations: [{ invoiceKey: key('INV-1'), amount: 1200 }] };
    const { perEntry } = allocatePayments(items, [payment]);
    expect(perEntry.filter((e) => e.invoiceNumber === 'INV-1').map((e) => e.balanceDue)).toEqual([0, 300]);
    const plan = planAllocations({ perEntry, creditBalance: 0, amount: 5000, invoiceKeys: [key('INV-1'), key('INV-2')] });
    expect(plan.allocations.map((a) => a.amount)).toEqual([300, 800]);
    expect(plan.leftover).toBe(3900);
  });

  it('never applies more than the account holds, whatever was stored', () => {
    const items = [item('INV-1', 1000, 1)];
    const payment = { _id: 'p1', amount: 100, paymentDate: day(5), allocated: true, allocations: [{ invoiceKey: key('INV-1'), amount: 900 }] };
    const { perEntry, creditBalance } = allocatePayments(items, [payment]);
    expect(perEntry[0].balanceDue).toBe(900);
    expect(creditBalance).toBe(0);
  });
});

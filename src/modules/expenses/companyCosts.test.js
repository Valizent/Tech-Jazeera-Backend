/**
 * companyCosts.test.js - the Expenses ledger shows every company cost: typed-in expenses and paid reimbursements
 * (stored), plus mobilisation cost, approved subcontractor payments and end of service read live from where they
 * live, each only for a viewer who can also read that source.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import SubcontractorPayment from '../deployments/subcontractorPayment.model.js';
import Settlement from '../eosb/settlement.model.js';
import Expense from './expense.model.js';
import { listExpenses, getSummary } from './expense.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const oid = () => new mongoose.Types.ObjectId();
const admin = { userId: String(oid()), role: 'Admin' };
const staff = { userId: String(oid()), role: 'Staff' };
const day = new Date('2026-03-10T00:00:00Z');
const range = { page: 1, limit: 50, from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-31T23:59:59Z') };

async function seed() {
  const client = await Client.create({ companyName: `Client ${unique()}` });
  const sub = await Subcontractor.create({ name: `Sub ${unique()}` });
  await Expense.create({ date: day, category: 'Rent', vendor: 'Landlord', amount: 1000, recordedBy: oid() });
  const base = {
    workerType: 'Freelancer', workerName: 'Cost Worker', iqamaNumber: '2111111111', jobTitle: 'Labour', client: client._id,
    clientName: client.companyName, clientRate: 10, otClientRate: 10, mobilisationDate: day, createdBy: oid(),
    coordinators: [{ user: oid(), isPrimary: true, confirmed: true }],
  };
  await Mobilisation.create({ ...base, serialNumber: `MOB-C${unique()}`, status: 'Approved', mobilisationCost: 500 });
  await Mobilisation.create({ ...base, serialNumber: `MOB-C${unique()}`, status: 'Draft', mobilisationCost: 900 }); // not yet real
  await SubcontractorPayment.create({ subcontractor: sub._id, amount: 2000, paymentDate: day, recordedBy: oid(), decisionStatus: 'Approved' });
  await SubcontractorPayment.create({ subcontractor: sub._id, amount: 777, paymentDate: day, recordedBy: oid(), decisionStatus: 'Pending' });
  const settlement = {
    employee: oid(), employeeName: 'Leaver', employeeCode: `E-${unique()}`, joiningDate: new Date('2020-01-01'), exitDate: day,
    exitReason: 'Resignation', monthlyWage: 3000, serviceYears: 6, eosbGross: 100, reductionFactor: 1, eosbNet: 100,
    totalSettlement: 3500, computedBy: oid(),
  };
  await Settlement.create(settlement);
  await Settlement.create({ ...settlement, employee: oid(), employeeCode: `E-${unique()}`, exitReason: 'CurrentEmployee', totalSettlement: 999 });
}

describe('company cost ledger', () => {
  beforeEach(seed);

  it('merges every source for a viewer who can read them, and leaves out what is not yet real', async () => {
    const all = await listExpenses(range, admin);
    const byCategory = Object.fromEntries(all.items.map((i) => [i.category, i.amount]));
    expect(all.total).toBe(4);
    expect(byCategory).toEqual({ Rent: 1000, Mobilisation: 500, 'Subcontractor Payment': 2000, 'End of Service': 3500 });
    expect(all.items.find((i) => i.category === 'Mobilisation')).toMatchObject({ derived: true, receipt: null });

    const summary = await getSummary({ from: range.from, to: range.to }, admin);
    expect(summary.total).toBe(7000);
  });

  it('filters by a derived category and pages the merged list', async () => {
    const only = await listExpenses({ ...range, category: 'End of Service' }, admin);
    expect(only.items.map((i) => i.vendor)).toEqual(['Leaver']);
    const paged = await listExpenses({ ...range, limit: 2 }, admin);
    expect(paged).toMatchObject({ total: 4, pages: 2 });
    expect(paged.items).toHaveLength(2);
  });

  it('shows a viewer without access to those sources only the stored rows, and keeps a deployment listing stored-only', async () => {
    const limited = await listExpenses(range, staff);
    expect(limited.items.map((i) => i.category)).toEqual(['Rent']);
    const deployment = await listExpenses({ ...range, deployment: String(oid()) }, admin);
    expect(deployment.items).toEqual([]);
  });
});

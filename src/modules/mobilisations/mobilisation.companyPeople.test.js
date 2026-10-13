/**
 * mobilisation.companyPeople.test.js - the 2026-10-12 mobilisation changes:
 * OT billed at the client rate (new records only), a freelancer's hourly rate
 * and OT, the client's / subcontractor's own coordinators on a mobilisation,
 * and the commission recipient rule.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import Mobilisation from './mobilisation.model.js';
import { createMobilisation, updateMobilisation, addCompanyCoordinator } from './mobilisation.service.js';
import { createMobilisationSchema } from './mobilisation.validation.js';
import { computeMonthlyRevenueAndExpenses } from '../deployments/deployment.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const actor = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });
const iqama = () => String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));

async function employee() {
  return Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Own Employee ${unique()}`,
    type: 'Own',
    designation: 'Labour',
    joiningDate: new Date('2022-01-01'),
    salary: 3000,
    contractHours: 240,
  });
}

async function client(coordinators = []) {
  return Client.create({ companyName: `Client ${unique()}`, coordinators });
}

const base = { jobTitle: 'Labour', mobilisationDate: new Date('2030-01-01'), clientRate: 30 };

describe('OT rates', () => {
  it('a new mobilisation bills OT at its client rate, and keeps following it on edit', async () => {
    const [emp, c] = await Promise.all([employee(), client()]);
    const created = await createMobilisation({ ...base, workerType: 'Employee', worker: String(emp._id), client: String(c._id), otEmployeeRate: 5 }, actor());
    expect(created.otClientRate).toBe(30);
    expect(created.otClientRateFollowsClient).toBe(true);
    // An Own employee's OT hour is salary / contract hours x 1.5 (3000 / 240 x 1.5), not a typed rate.
    expect(created.otEmployeeRate).toBe(18.75);

    const edited = await updateMobilisation(String(created._id), { clientRate: 45 }, actor());
    expect(edited.clientRate).toBe(45);
    expect(edited.otClientRate).toBe(45);
  });

  it('a mobilisation that predates this keeps its own typed OT client rate', async () => {
    const [emp, c] = await Promise.all([employee(), client()]);
    const legacy = await Mobilisation.create({
      serialNumber: `MOB-L${unique()}`,
      workerType: 'Employee',
      worker: emp._id,
      workerName: emp.fullName,
      jobTitle: 'Labour',
      client: c._id,
      clientName: c.companyName,
      clientRate: 30,
      otClientRate: 40,
      mobilisationDate: new Date('2030-02-01'),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    const edited = await updateMobilisation(String(legacy._id), { clientRate: 50 }, { userId: String(legacy.coordinators[0].user), role: 'Admin', ip: '127.0.0.1' });
    expect(edited.otClientRate).toBe(40);
  });
});

describe('freelancer hourly rate', () => {
  it('is required by the schema, and a created freelancer is paid OT at it', async () => {
    const c = await client([{ name: 'Commission Receiver' }]);
    const input = { ...base, workerType: 'Freelancer', workerName: 'Free Lancer', iqamaNumber: iqama(), client: String(c._id) };
    expect(createMobilisationSchema.safeParse(input).success).toBe(false);

    const created = await createMobilisation(
      { ...input, employeeRate: 12, clientCommission: 3, clientCommissionCoordinatorId: String(c.coordinators[0]._id) },
      actor()
    );
    expect(created.employeeRate).toBe(12);
    expect(created.otEmployeeRate).toBe(12);
    expect(created.profitPerHour).toBe(15); // 30 - 3 - 12
  });

  it('an Own employee never carries an employee rate', async () => {
    const [emp, c] = await Promise.all([employee(), client()]);
    const created = await createMobilisation({ ...base, workerType: 'Employee', worker: String(emp._id), client: String(c._id), employeeRate: 9 }, actor());
    expect(created.employeeRate).toBe(0);
    expect(created.profitPerHour).toBe(30);
  });

  it('the monthly figures pay a freelancer their hourly rate on regular hours and OT at the same rate', () => {
    const entry = { actualHours: 100, otHours: 10, contractHours: 90, status: 'Approved' };
    const mobilisation = { workerType: 'Freelancer', clientRate: 30, otClientRate: 30, employeeRate: 12, otEmployeeRate: 12 };
    const result = computeMonthlyRevenueAndExpenses(entry, mobilisation, [entry], null);
    expect(result.revenue).toBe(3000);
    expect(result.breakdown.expenseFreelancerPay).toBe(1080); // 90 regular hours x 12
    expect(result.breakdown.otCalculations).toBe(120); // 10 OT hours x 12
    expect(result.expenses).toBe(1200);
    expect(result.profit).toBe(1800);
  });
});

describe('the client and subcontractor people on a mobilisation', () => {
  it('stores snapshots of the picked client coordinators and refuses another company\'s', async () => {
    const [emp, c, other] = await Promise.all([
      employee(),
      client([{ name: 'Aisha', designation: 'Site lead', phone: '+966500000001', email: 'a@c.test' }, { name: 'Bilal' }]),
      client([{ name: 'Stranger' }]),
    ]);
    const [aisha, bilal] = c.coordinators.map((x) => String(x._id));
    const created = await createMobilisation(
      { ...base, workerType: 'Employee', worker: String(emp._id), client: String(c._id), clientCoordinatorIds: [aisha, bilal, aisha] },
      actor()
    );
    expect(created.clientCoordinators.map((x) => x.name)).toEqual(['Aisha', 'Bilal']);
    expect(created.clientCoordinators[0]).toMatchObject({ designation: 'Site lead', phone: '+966500000001', email: 'a@c.test' });

    const [emp2] = await Promise.all([employee()]);
    await expect(
      createMobilisation(
        { ...base, workerType: 'Employee', worker: String(emp2._id), client: String(c._id), clientCoordinatorIds: [String(other.coordinators[0]._id)] },
        actor()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('needs a commission recipient from the same company once the commission is 1 or more', async () => {
    const [emp, c] = await Promise.all([employee(), client([{ name: 'Receiver' }])]);
    const input = { ...base, workerType: 'Employee', worker: String(emp._id), client: String(c._id) };

    await expect(createMobilisation({ ...input, clientCommission: 2 }, actor())).rejects.toMatchObject({ statusCode: 400 });
    const below = await createMobilisation({ ...input, clientCommission: 0.5 }, actor());
    expect(below.clientCommissionCoordinator).toBeNull();

    const emp2 = await employee();
    const created = await createMobilisation(
      { ...input, worker: String(emp2._id), clientCommission: 2, clientCommissionCoordinatorId: String(c.coordinators[0]._id) },
      actor()
    );
    expect(created.clientCommissionCoordinator).toMatchObject({ name: 'Receiver' });

    // Dropping the commission below 1 clears the recipient.
    const lowered = await updateMobilisation(String(created._id), { clientCommission: 0 }, actor());
    expect(lowered.clientCommissionCoordinator).toBeNull();
  });

  it('splits a commission between up to three coordinators by percentage', async () => {
    const c = await client([{ name: 'Aisha' }, { name: 'Bilal' }, { name: 'Chen' }, { name: 'Dara' }]);
    const [aisha, bilal, chen, dara] = c.coordinators.map((x) => String(x._id));
    const make = async (recipients) =>
      createMobilisation(
        {
          ...base,
          workerType: 'Employee',
          worker: String((await employee())._id),
          client: String(c._id),
          clientCommission: 3,
          clientCommissionRecipients: recipients,
        },
        actor()
      );

    const created = await make([
      { coordinatorId: aisha, sharePercent: 50 },
      { coordinatorId: bilal, sharePercent: 30 },
      { coordinatorId: chen, sharePercent: 20 },
    ]);
    expect(created.clientCommissionRecipients.map((r) => [r.name, r.sharePercent])).toEqual([
      ['Aisha', 50],
      ['Bilal', 30],
      ['Chen', 20],
    ]);
    // The first person stays as the single recipient older readers understand.
    expect(created.clientCommissionCoordinator).toMatchObject({ name: 'Aisha' });

    // One person is always 100%, whatever share came with it.
    const single = await make([{ coordinatorId: dara, sharePercent: 40 }]);
    expect(single.clientCommissionRecipients).toHaveLength(1);
    expect(single.clientCommissionRecipients[0]).toMatchObject({ name: 'Dara', sharePercent: 100 });

    // Shares must add up to 100, be above 0, and a person can only be picked once.
    await expect(make([{ coordinatorId: aisha, sharePercent: 50 }, { coordinatorId: bilal, sharePercent: 30 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(make([{ coordinatorId: aisha, sharePercent: 100 }, { coordinatorId: bilal, sharePercent: 0 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(make([{ coordinatorId: aisha, sharePercent: 50 }, { coordinatorId: aisha, sharePercent: 50 }])).rejects.toMatchObject({ statusCode: 400 });
    // More than three is refused by the request schema.
    const four = [aisha, bilal, chen, dara].map((coordinatorId) => ({ coordinatorId, sharePercent: 25 }));
    expect(createMobilisationSchema.safeParse({ ...base, workerType: 'Employee', worker: String(new mongoose.Types.ObjectId()), client: String(c._id), clientCommissionRecipients: four }).success).toBe(false);

    // Dropping the commission below 1 clears all of them.
    const lowered = await updateMobilisation(String(created._id), { clientCommission: 0 }, actor());
    expect(lowered.clientCommissionRecipients).toEqual([]);
    expect(lowered.clientCommissionCoordinator).toBeNull();
  });

  it('handles the subcontractor side for a subcontractor employee only', async () => {
    const c = await client();
    const sub = await Subcontractor.create({ name: `Sub ${unique()}`, coordinators: [{ name: 'Sami' }, { name: 'Sara' }] });
    const [sami, sara] = sub.coordinators.map((x) => String(x._id));
    const input = {
      ...base,
      workerType: 'SupplierEmployee',
      workerName: 'Sub Person',
      iqamaNumber: iqama(),
      client: String(c._id),
      subcontractor: String(sub._id),
      subcontractorRate: 20,
    };
    await expect(createMobilisation({ ...input, subcontractorCommission: 1 }, actor())).rejects.toMatchObject({ statusCode: 400 });

    const created = await createMobilisation(
      { ...input, iqamaNumber: iqama(), subcontractorCommission: 1, subcontractorCoordinatorIds: [sami], subcontractorCommissionCoordinatorId: sara },
      actor()
    );
    expect(created.subcontractorCoordinators.map((x) => x.name)).toEqual(['Sami']);
    expect(created.subcontractorCommissionCoordinator).toMatchObject({ name: 'Sara' });
  });

  it('editing a record saved before recipients existed does not demand one', async () => {
    const [emp, c] = await Promise.all([employee(), client()]);
    const legacy = await Mobilisation.create({
      serialNumber: `MOB-L${unique()}`,
      workerType: 'Employee',
      worker: emp._id,
      workerName: emp.fullName,
      jobTitle: 'Labour',
      client: c._id,
      clientName: c.companyName,
      clientRate: 30,
      clientCommission: 4,
      mobilisationDate: new Date('2030-03-01'),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    const edited = await updateMobilisation(String(legacy._id), { remark: 'fixed a typo' }, { userId: String(legacy.coordinators[0].user), role: 'Admin', ip: '127.0.0.1' });
    expect(edited.remark).toBe('fixed a typo');
  });
});

describe('adding a coordinator to a company from the form', () => {
  it('stores it on the client and returns it with its id', async () => {
    const c = await client();
    const added = await addCompanyCoordinator({ ownerType: 'Client', company: String(c._id), name: 'New Person', designation: 'Foreman', phone: '+966500000003' }, actor());
    expect(added).toMatchObject({ name: 'New Person', designation: 'Foreman' });
    const stored = await Client.findById(c._id).lean();
    expect(stored.coordinators.map((x) => String(x._id))).toContain(String(added._id));
  });

  it('works for a subcontractor and reports an unknown company', async () => {
    const sub = await Subcontractor.create({ name: `Sub ${unique()}` });
    const added = await addCompanyCoordinator({ ownerType: 'Subcontractor', company: String(sub._id), name: 'Sub Person' }, actor());
    expect((await Subcontractor.findById(sub._id).lean()).coordinators[0].name).toBe('Sub Person');
    expect(added._id).toBeTruthy();
    await expect(
      addCompanyCoordinator({ ownerType: 'Client', company: String(new mongoose.Types.ObjectId()), name: 'X' }, actor())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

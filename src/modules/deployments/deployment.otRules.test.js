/**
 * deployment.otRules.test.js - the 2026-10-13 overtime rules: a subcontractor
 * employee's OT is the client's hours minus the subcontractor's hours (until
 * those are entered, client hours minus contract hours); an Own employee's OT
 * hour is paid at salary / contract hours x 1.5 from their own record.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import Employee from '../employees/employee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from './deployment.model.js';
import { addMonthlyHours, updateMonthlyHours, computeMonthlyRevenueAndExpenses, listDeployments } from './deployment.service.js';
import { createMobilisation } from '../mobilisations/mobilisation.service.js';
import { ownEmployeeOtRate } from '../../utils/employeeOt.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });

/** Last calendar month as 'YYYY-MM' - the latest one hours may be entered for. */
const lastMonth = (() => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();
const threeMonthsAgo = new Date(Date.now() - 100 * 86_400_000);

/** An Active deployment of the given type with 260 contract hours. */
async function deployment(workerType, extra = {}) {
  const client = await Client.create({ companyName: `Client ${unique()}` });
  const mobilisation = await Mobilisation.create({
    serialNumber: `MOB-O${unique()}`,
    workerType,
    workerName: 'OT Worker',
    jobTitle: 'Labour',
    client: client._id,
    clientName: client.companyName,
    clientRate: 30,
    otClientRate: 30,
    mobilisationDate: threeMonthsAgo,
    createdBy: new mongoose.Types.ObjectId(),
    coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    ...(workerType === 'Employee' && { worker: extra.worker }),
  });
  return Deployment.create({
    mobilisation: mobilisation._id,
    workerType,
    workerName: 'OT Worker',
    client: client._id,
    clientName: client.companyName,
    startDate: threeMonthsAgo,
    requiredTimesheetHours: 260,
    ...(extra.worker && { worker: extra.worker }),
  });
}

describe('subcontractor employee: client hours minus subcontractor hours', () => {
  it('has no OT when the client and the subcontractor have the same hours, whatever the contract says', async () => {
    const dep = await deployment('SupplierEmployee');
    const updated = await addMonthlyHours(String(dep._id), { month: lastMonth, actualHours: 300, supplierHours: 300 }, admin());
    expect(updated.monthlyHours[0]).toMatchObject({ otHours: 0, otAmount: 0 });
  });

  it('has the difference as OT when the client has more hours than the subcontractor', async () => {
    const dep = await deployment('SupplierEmployee');
    const updated = await addMonthlyHours(String(dep._id), { month: lastMonth, actualHours: 300, supplierHours: 280 }, admin());
    expect(updated.monthlyHours[0]).toMatchObject({ otHours: 20, otAmount: 600 });
  });

  it('uses client hours minus contract hours until the subcontractor hours are entered, then switches', async () => {
    const dep = await deployment('SupplierEmployee');
    const added = await addMonthlyHours(String(dep._id), { month: lastMonth, actualHours: 300 }, admin());
    expect(added.monthlyHours[0].otHours).toBe(40); // 300 - 260, an estimate
    const entryId = String(added.monthlyHours[0]._id);
    const updated = await updateMonthlyHours(String(dep._id), entryId, { actualHours: 300, supplierHours: 300 }, admin());
    expect(updated.monthlyHours[0]).toMatchObject({ supplierHours: 300, otHours: 0, otAmount: 0 });
  });

  it('never goes below zero when the subcontractor has more hours', async () => {
    const dep = await deployment('SupplierEmployee');
    const updated = await addMonthlyHours(String(dep._id), { month: lastMonth, actualHours: 250, supplierHours: 270 }, admin());
    expect(updated.monthlyHours[0].otHours).toBe(0);
  });
});

describe('own employee: client hours minus contract hours, paid at salary / contract hours x 1.5', () => {
  it('keeps OT as client hours minus contract hours', async () => {
    const emp = await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'Own Worker',
      type: 'Own',
      designation: 'Labour',
      joiningDate: new Date('2022-01-01'),
      salary: 3000,
      contractHours: 240,
    });
    const dep = await deployment('Employee', { worker: emp._id });
    const updated = await addMonthlyHours(String(dep._id), { month: lastMonth, actualHours: 280 }, admin());
    expect(updated.monthlyHours[0].otHours).toBe(20); // 280 - 260 (the deployment's contract hours)
  });

  it('costs an OT hour at salary / contract hours x 1.5', () => {
    expect(ownEmployeeOtRate(3000, 240)).toBe(18.75);
    const entry = { actualHours: 280, otHours: 20, contractHours: 260, status: 'Approved' };
    const mobilisation = { workerType: 'Employee', clientRate: 30, otClientRate: 30, otEmployeeRate: 5 };
    const result = computeMonthlyRevenueAndExpenses(entry, mobilisation, [entry], { salary: 3000, contractHours: 240 });
    expect(result.breakdown.otCalculations).toBe(375); // 20 x 18.75
  });

  it('falls back to the typed OT rate for an employee record without contract hours', () => {
    expect(ownEmployeeOtRate(3000, null)).toBeNull();
    const entry = { actualHours: 280, otHours: 20, contractHours: 260, status: 'Approved' };
    const mobilisation = { workerType: 'Employee', clientRate: 30, otClientRate: 30, otEmployeeRate: 5 };
    const result = computeMonthlyRevenueAndExpenses(entry, mobilisation, [entry], { salary: 3000 });
    expect(result.breakdown.otCalculations).toBe(100); // 20 x 5
  });
});

describe('mobilising an own employee needs contract hours', () => {
  it('refuses an employee with no contract hours and derives the OT rate for one that has them', async () => {
    const client = await Client.create({ companyName: `Client ${unique()}` });
    const base = {
      workerType: 'Employee',
      client: String(client._id),
      jobTitle: 'Labour',
      clientRate: 30,
      mobilisationDate: new Date('2030-05-01'),
    };
    const without = await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'No Hours',
      type: 'Own',
      designation: 'Labour',
      joiningDate: new Date('2022-01-01'),
      salary: 3000,
    });
    await expect(createMobilisation({ ...base, worker: String(without._id) }, admin())).rejects.toMatchObject({ statusCode: 400 });

    const withHours = await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'Has Hours',
      type: 'Own',
      designation: 'Labour',
      joiningDate: new Date('2022-01-01'),
      salary: 2400,
      contractHours: 240,
    });
    const created = await createMobilisation({ ...base, worker: String(withHours._id) }, admin());
    expect(created.otEmployeeRate).toBe(15); // 2400 / 240 x 1.5
  });
});

describe('the Overview shows an Own employee\'s live OT rate', () => {
  it('prices OT from the employee record even when the mobilisation stored an older rate', async () => {
    const worker = await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'Own Worker',
      type: 'Own',
      designation: 'Fitter',
      joiningDate: new Date('2024-01-01'),
      salary: 3000,
      contractHours: 200,
    });
    const dep = await deployment('Employee', { worker: worker._id });
    await Mobilisation.updateOne({ _id: dep.mobilisation }, { $set: { otEmployeeRate: 10, otProfitPerHour: 20, otClientRate: 30 } });

    const { items } = await listDeployments({ page: 1, limit: 20 }, admin());
    const row = items.find((d) => String(d._id) === String(dep._id));

    expect(row.mobilisation.otEmployeeRate).toBe(22.5);
    expect(row.mobilisation.otProfitPerHour).toBe(7.5);
    expect(JSON.stringify(row)).not.toContain('3000');
  });
});

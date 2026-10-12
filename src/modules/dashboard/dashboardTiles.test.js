/**
 * dashboardTiles.test.js - the stat-tile row on the dashboard (2026-10-12):
 * "Currently deployed", "Active employees" and "Shared employees", and who
 * gets which.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import Client from '../clients/client.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import { getDashboard } from './dashboard.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let serial = 0;

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id };
}

/** An Approved mobilisation with an Active deployment, handled by the given coordinators. */
async function placement(client, coordinators, { status = 'Approved', deployed = true } = {}) {
  const n = `${Date.now()}${serial++}`;
  const mobilisation = await Mobilisation.create({
    serialNumber: `MOB-T${n}`,
    workerType: 'Freelancer',
    workerName: `Freelancer ${n}`,
    jobTitle: 'Helper',
    client: client._id,
    clientName: client.companyName,
    mobilisationDate: new Date(),
    status,
    createdBy: coordinators[0],
    coordinators: coordinators.map((id, i) => ({ user: id, isPrimary: i === 0, confirmed: true })),
  });
  if (deployed) {
    await Deployment.create({
      mobilisation: mobilisation._id,
      workerType: 'Freelancer',
      workerName: mobilisation.workerName,
      client: client._id,
      clientName: client.companyName,
      startDate: new Date(),
    });
  }
  return mobilisation;
}

describe('dashboard stat tiles', () => {
  it('counts deployed and shared placements per audience', async () => {
    const [c1, c2, secretary, accounts, admin] = await Promise.all(['Coordinator', 'Coordinator', 'Office Secretary', 'Accounts', 'Admin'].map(login));
    const client = await Client.create({ companyName: `Client ${unique()}` });
    await placement(client, [c1.id, c2.id]); // shared by both
    await placement(client, [c1.id]); // c1 alone
    await placement(client, [c1.id, c2.id], { status: 'Draft', deployed: false }); // not placed yet: never counted

    const one = (await getDashboard({ actor: c1 })).stats;
    expect(one.deployedActive).toBe(2);
    expect(one.sharedEmployees).toBe(1);
    expect(one.activeEmployees).toBeNull();

    const two = (await getDashboard({ actor: c2 })).stats;
    expect(two.deployedActive).toBe(1);
    expect(two.sharedEmployees).toBe(1);

    // Office Secretary and Accounts see the company total (this test DB is
    // shared across files' fixtures only per file, so compare with c1's own
    // numbers: everything here was placed by c1).
    for (const actor of [secretary, accounts]) {
      const stats = (await getDashboard({ actor })).stats;
      expect(stats.sharedEmployees).toBe(1);
      expect(stats.activeEmployees).toBeNull();
    }

    const management = (await getDashboard({ actor: admin })).stats;
    expect(management.deployedActive).toBe(2);
    expect(management.sharedEmployees).toBeNull();
    expect(management.activeEmployees).toBeGreaterThanOrEqual(0);
  });

  it('active employees counts everyone with status Active, office staff included', async () => {
    const admin = await login('Admin');
    const base = (await getDashboard({ actor: admin })).stats.activeEmployees;
    const common = { type: 'Own', designation: 'Tester', joiningDate: new Date('2023-01-01') };
    await Employee.create({ ...common, employeeId: `EMP-${unique()}`, fullName: 'Staff One' });
    await Employee.create({ ...common, employeeId: `EMP-${unique()}`, fullName: 'Staff Two', status: 'On Leave' });
    await Employee.create({ ...common, employeeId: `EMP-${unique()}`, fullName: 'Staff Three', status: 'Exited' });
    await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'Labourer',
      type: 'Outsourced',
      nationality: 'Indian',
      mobile: '+966500000000',
      designation: 'Helper',
      joiningDate: new Date('2023-01-01'),
      salary: 1500,
      coordinator: new mongoose.Types.ObjectId(),
    });
    const after = (await getDashboard({ actor: admin })).stats.activeEmployees;
    expect(after - base).toBe(2);
  });
});

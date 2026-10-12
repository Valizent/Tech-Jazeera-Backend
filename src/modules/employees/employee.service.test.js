/**
 * employee.service.test.js — regression coverage for A1 (docs/QA-AUDIT-
 * 2026-09-15-notes.md): `assertEmployeeVisibleToActor` is the shared
 * Coordinator team-scoping primitive wired into 8 endpoints across
 * Deployment/Documents/Assets/EOSB during that fix. Tested directly here
 * rather than through every call site — one correct implementation, reused
 * everywhere, matches how the fix itself was structured.
 */
import mongoose from 'mongoose';
import Employee from './employee.model.js';
import User from '../auth/user.model.js';
import { assertEmployeeVisibleToActor, listEmployees, getEmployee } from './employee.service.js';

async function makeEmployee(coordinatorId) {
  return Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
    coordinator: coordinatorId,
  });
}

describe('assertEmployeeVisibleToActor (A1)', () => {
  it('a Coordinator is rejected for an employee outside their team', async () => {
    const someoneElsesCoordinator = new mongoose.Types.ObjectId();
    const employee = await makeEmployee(someoneElsesCoordinator);
    const actor = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    await expect(assertEmployeeVisibleToActor(employee._id, actor)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a Coordinator is allowed for their own team member', async () => {
    const coordinatorId = new mongoose.Types.ObjectId();
    const employee = await makeEmployee(coordinatorId);
    const actor = { role: 'Coordinator', userId: coordinatorId.toString() };
    await expect(assertEmployeeVisibleToActor(employee._id, actor)).resolves.toBeUndefined();
  });

  it('a non-Coordinator role (e.g. Manager) is never scoped by this check', async () => {
    const someoneElsesCoordinator = new mongoose.Types.ObjectId();
    const employee = await makeEmployee(someoneElsesCoordinator);
    const actor = { role: 'Manager', userId: new mongoose.Types.ObjectId().toString() };
    await expect(assertEmployeeVisibleToActor(employee._id, actor)).resolves.toBeUndefined();
  });

  it('Admin is never scoped by this check', async () => {
    const someoneElsesCoordinator = new mongoose.Types.ObjectId();
    const employee = await makeEmployee(someoneElsesCoordinator);
    const actor = { role: 'Admin', userId: new mongoose.Types.ObjectId().toString() };
    await expect(assertEmployeeVisibleToActor(employee._id, actor)).resolves.toBeUndefined();
  });
});

/**
 * Coordinator visibility of the field workforce (2026-10-12, the user's
 * decision): a Coordinator sees every labourer (an employee holding a Worker
 * login) company-wide, not office staff that belong to someone else.
 */
describe('Coordinator sees every labourer', () => {
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const listQuery = { page: 1, limit: 100, sortBy: 'createdAt', sortOrder: 'desc' };

  async function makePerson({ role, coordinator = null }) {
    const employee = await makeEmployee(coordinator);
    await User.create({ name: employee.fullName, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role, employee: employee._id });
    return employee;
  }

  it('lists labourers assigned to other coordinators, and hides office staff of other teams', async () => {
    const me = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    const other = new mongoose.Types.ObjectId();
    const labourer = await makePerson({ role: 'Worker', coordinator: other });
    const unassignedLabourer = await makePerson({ role: 'Worker' });
    const officeStaff = await makePerson({ role: 'HR', coordinator: other });
    const mine = await makeEmployee(new mongoose.Types.ObjectId(me.userId));

    const ids = (await listEmployees(listQuery, me)).items.map((e) => String(e._id));
    expect(ids).toEqual(expect.arrayContaining([String(labourer._id), String(unassignedLabourer._id), String(mine._id)]));
    expect(ids).not.toContain(String(officeStaff._id));
  });

  it('opens a labourer profile but still refuses office staff of other teams', async () => {
    const me = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    const other = new mongoose.Types.ObjectId();
    const labourer = await makePerson({ role: 'Worker', coordinator: other });
    const officeStaff = await makePerson({ role: 'Accounts', coordinator: other });

    await expect(getEmployee(labourer._id, me)).resolves.toMatchObject({ fullName: 'Test Worker' });
    await expect(getEmployee(officeStaff._id, me)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not widen the documents and assets check for a labourer', async () => {
    const me = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    const labourer = await makePerson({ role: 'Worker', coordinator: new mongoose.Types.ObjectId() });
    await expect(assertEmployeeVisibleToActor(labourer._id, me)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('leaves the list unchanged for every other role', async () => {
    const manager = { role: 'Manager', userId: new mongoose.Types.ObjectId().toString() };
    const officeStaff = await makePerson({ role: 'HR', coordinator: new mongoose.Types.ObjectId() });
    const ids = (await listEmployees(listQuery, manager)).items.map((e) => String(e._id));
    expect(ids).toContain(String(officeStaff._id));
  });
});

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
import {
  assertEmployeeVisibleToActor,
  listEmployees,
  getEmployee,
  updateEmployee,
  redactFinancial,
  changedValues,
} from './employee.service.js';

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
 * Coordinator visibility (2026-10-13, the user's decision, replacing the
 * 2026-10-12 labourer-only widening): a Coordinator sees the whole register,
 * like everyone else who may view it. Other modules' per-employee checks
 * (assertEmployeeVisibleToActor) are unchanged.
 */
describe('Coordinator sees the whole register', () => {
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const listQuery = { page: 1, limit: 100, sortBy: 'createdAt', sortOrder: 'desc' };

  async function makePerson({ role, coordinator = null }) {
    const employee = await makeEmployee(coordinator);
    await User.create({ name: employee.fullName, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role, employee: employee._id });
    return employee;
  }

  it('lists labourers, office staff of other teams and their own team', async () => {
    const me = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    const other = new mongoose.Types.ObjectId();
    const labourer = await makePerson({ role: 'Worker', coordinator: other });
    const officeStaff = await makePerson({ role: 'HR', coordinator: other });
    const mine = await makeEmployee(new mongoose.Types.ObjectId(me.userId));

    const ids = (await listEmployees(listQuery, me)).items.map((e) => String(e._id));
    expect(ids).toEqual(expect.arrayContaining([String(labourer._id), String(officeStaff._id), String(mine._id)]));
  });

  it('opens any employee profile', async () => {
    const me = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString() };
    const officeStaff = await makePerson({ role: 'Accounts', coordinator: new mongoose.Types.ObjectId() });
    await expect(getEmployee(officeStaff._id, me)).resolves.toMatchObject({ fullName: 'Test Worker' });
  });

  it('does not widen the documents and assets check', async () => {
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

/**
 * Pay figures (2026-10-13): salary and the WPS breakdown leave the service
 * only for an actor with `canSeeFinancial`; an edit by anyone else cannot
 * change them; the log keeps old and new values of what did change.
 */
describe('employee pay figures', () => {
  const asAdmin = { role: 'Admin', userId: new mongoose.Types.ObjectId().toString(), canSeeFinancial: true };
  const asEditor = { role: 'Coordinator', userId: new mongoose.Types.ObjectId().toString(), canSeeFinancial: false };

  async function paidEmployee() {
    const e = await makeEmployee(null);
    e.salary = 5000;
    e.basicSalary = 3000;
    e.housingAllowance = 1500;
    e.transportAllowance = 500;
    await e.save();
    return e;
  }

  it('removes pay from every response without the permission, and says it is on file', async () => {
    const e = await paidEmployee();
    const seen = await getEmployee(e._id, asEditor);
    for (const field of ['salary', 'basicSalary', 'housingAllowance', 'transportAllowance']) expect(seen).not.toHaveProperty(field);
    expect(seen.salaryOnFile).toBe(true);

    const full = await getEmployee(e._id, asAdmin);
    expect(full.salary).toBe(5000);
    expect(full.basicSalary).toBe(3000);

    const listed = (await listEmployees({ page: 1, limit: 100, sortBy: 'createdAt', sortOrder: 'desc' }, asEditor)).items.find(
      (x) => String(x._id) === String(e._id)
    );
    expect(listed).not.toHaveProperty('salary');
  });

  it('ignores pay edits from someone without the permission but applies their other edits', async () => {
    const e = await paidEmployee();
    const result = await updateEmployee(e._id, { salary: 99999, designation: 'Supervisor' }, asEditor);
    expect(result).not.toHaveProperty('salary');
    expect(result.designation).toBe('Supervisor');
    expect((await Employee.findById(e._id).lean()).salary).toBe(5000);
  });

  it('lets someone with the permission change pay', async () => {
    const e = await paidEmployee();
    await updateEmployee(e._id, { salary: 5500 }, asAdmin);
    expect((await Employee.findById(e._id).lean()).salary).toBe(5500);
  });

  it('redactFinancial and changedValues behave as described', () => {
    expect(redactFinancial({ salary: 1, fullName: 'A' }, { canSeeFinancial: false })).toEqual({ fullName: 'A', salaryOnFile: true });
    expect(redactFinancial({ fullName: 'A' }, { canSeeFinancial: false })).toEqual({ fullName: 'A', salaryOnFile: false });
    expect(changedValues({ salary: 5000, designation: 'A' }, { salary: 5500, designation: 'A' }, ['salary', 'designation'])).toEqual({
      salary: { from: 5000, to: 5500 },
    });
  });
});

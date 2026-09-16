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
import { assertEmployeeVisibleToActor } from './employee.service.js';

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

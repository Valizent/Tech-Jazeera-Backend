/**
 * designationSync.service.test.js - Designation and Approval Role membership are
 * two views of one fact: changing either side changes the other.
 */
import ApprovalRole from '../approvals/approvalRole.model.js';
import User from '../auth/user.model.js';
import Employee from './employee.model.js';
import { updateEmployee } from './employee.service.js';
import { updateApprovalRole } from '../approvals/approvals.service.js';
import { listDesignationRoles } from './designationSync.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const actor = { userId: undefined, role: 'Admin', ip: '127.0.0.1', canSeeFinancial: true };

async function staff(designation = 'Clerk') {
  const employee = await Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation,
    joiningDate: new Date('2023-01-01'),
  });
  const user = await User.create({
    name: employee.fullName,
    email: `p-${unique()}@example.com`,
    passwordHash: 'x',
    role: 'HR',
    employee: employee._id,
  });
  return { employee, user };
}
const role = (name, members = []) => ApprovalRole.create({ name: `${name} ${unique()}`, members });
const members = async (r) => (await ApprovalRole.findById(r._id).lean()).members.map(String);

describe('designation <-> approval role', () => {
  beforeAll(async () => {
    actor.userId = String((await User.create({ name: 'A', email: `a-${unique()}@example.com`, passwordHash: 'x', role: 'Admin' }))._id);
  });

  it('lists active roles but not the reserved Worker/Staff ones', async () => {
    const r = await role('Lister');
    await ApprovalRole.create({ name: `Hidden ${unique()}`, isActive: false });
    const names = await listDesignationRoles();
    expect(names).toContain(r.name);
    expect(names).not.toContain('Staff');
  });

  it('moves the login between roles when the designation changes', async () => {
    const a = await role('Alpha');
    const b = await role('Beta');
    const { employee, user } = await staff(a.name);
    await ApprovalRole.updateOne({ _id: a._id }, { $addToSet: { members: user._id } });

    await updateEmployee(employee._id, { designation: b.name }, actor);

    expect(await members(a)).not.toContain(String(user._id));
    expect(await members(b)).toContain(String(user._id));
  });

  it('a free-text trade touches no role', async () => {
    const a = await role('Gamma', []);
    const { employee, user } = await staff('Welder');
    await updateEmployee(employee._id, { designation: 'Fitter' }, actor);
    expect(await members(a)).not.toContain(String(user._id));
  });

  it('adding someone to a role sets their designation; removing falls back', async () => {
    const a = await role('Delta');
    const b = await role('Epsilon');
    const { employee, user } = await staff('Clerk');

    await updateApprovalRole(a._id, { members: [user._id] }, actor);
    expect((await Employee.findById(employee._id)).designation).toBe(a.name);

    // already holds Delta, so joining Epsilon keeps the main designation
    await updateApprovalRole(b._id, { members: [user._id] }, actor);
    expect((await Employee.findById(employee._id)).designation).toBe(a.name);

    // leaving Delta falls back to the other role they still hold
    await updateApprovalRole(a._id, { members: [] }, actor);
    expect((await Employee.findById(employee._id)).designation).toBe(b.name);

    // leaving the last one leaves the designation as it was
    await updateApprovalRole(b._id, { members: [] }, actor);
    expect((await Employee.findById(employee._id)).designation).toBe(b.name);
  });

  it('follows a role rename', async () => {
    const a = await role('Zeta');
    const { employee } = await staff(a.name);
    await updateApprovalRole(a._id, { name: `Zeta2 ${unique()}` }, actor);
    expect((await Employee.findById(employee._id)).designation).not.toBe(a.name);
    expect((await Employee.findById(employee._id)).designation).toMatch(/^Zeta2/);
  });
});

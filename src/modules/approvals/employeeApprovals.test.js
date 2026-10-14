/**
 * employeeApprovals.test.js - an employee's own hierarchy per module: default until changed,
 * independent per module, and the old single override is converted at boot.
 */
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow from './approvalWorkflow.model.js';
import Employee from '../employees/employee.model.js';
import {
  listEmployeeApprovals,
  setEmployeeApprovalOverride,
  resolveApprovalWorkflow,
  migrateLegacyEmployeeOverrides,
} from './approvals.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const actor = { userId: undefined, role: 'Admin', ip: '127.0.0.1' };
const employee = (extra = {}) =>
  Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation: 'Clerk',
    joiningDate: new Date('2023-01-01'),
    ...extra,
  });

async function chain(name, appliesTo = []) {
  const role = await ApprovalRole.create({ name: `R ${unique()}`, members: [] });
  return ApprovalWorkflow.create({ name: `${name} ${unique()}`, steps: [{ roles: [role._id] }], appliesTo });
}

describe('per-employee approval hierarchy', () => {
  it('lists employees on the default until a module is changed, then only that module differs', async () => {
    const mine = await chain('Custom leave');
    const e = await employee();
    const before = (await listEmployeeApprovals({ search: e.employeeId })).items[0];
    expect(before.overrides).toEqual([]);

    await setEmployeeApprovalOverride(e._id.toString(), { requestType: 'Leave', workflow: mine._id.toString() }, actor);

    const after = (await listEmployeeApprovals({ search: e.employeeId })).items[0];
    expect(after.overrides).toHaveLength(1);
    expect(after.overrides[0]).toMatchObject({ requestType: 'Leave' });
    const stored = await Employee.findById(e._id).lean();
    expect((await resolveApprovalWorkflow(stored, 'Leave'))._id.toString()).toBe(mine._id.toString());
    expect(await resolveApprovalWorkflow(stored, 'AnnualVacation')).toBeNull();
  });

  it('puts a module back on the default with a null workflow, and refuses an inactive hierarchy', async () => {
    const mine = await chain('Another');
    const e = await employee();
    await setEmployeeApprovalOverride(e._id.toString(), { requestType: 'Timesheet', workflow: mine._id.toString() }, actor);
    await setEmployeeApprovalOverride(e._id.toString(), { requestType: 'Timesheet', workflow: null }, actor);
    expect((await Employee.findById(e._id).lean()).approvalOverrides).toHaveLength(0);

    await ApprovalWorkflow.updateOne({ _id: mine._id }, { isActive: false });
    await expect(
      setEmployeeApprovalOverride(e._id.toString(), { requestType: 'Timesheet', workflow: mine._id.toString() }, actor)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(setEmployeeApprovalOverride(e._id.toString(), { requestType: 'Mobilisation', workflow: null }, actor)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('converts the old single override into one entry per module, once', async () => {
    const mine = await chain('Legacy');
    const e = await employee();
    await Employee.collection.updateOne({ _id: e._id }, { $set: { approvalWorkflow: mine._id } });

    await migrateLegacyEmployeeOverrides();
    await migrateLegacyEmployeeOverrides();

    const raw = await Employee.collection.findOne({ _id: e._id });
    expect(raw.approvalWorkflow).toBeUndefined();
    expect(raw.approvalOverrides).toHaveLength(7);
    expect(new Set(raw.approvalOverrides.map((o) => String(o.workflow)))).toEqual(new Set([String(mine._id)]));
  });
});

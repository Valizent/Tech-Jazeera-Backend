/**
 * contractEnd.job.test.js - HR hears about a contract about to end and about one
 * that just ended, once each; the dashboard lists the ones that ended unrenewed.
 */
import User from '../auth/user.model.js';
import Employee from '../employees/employee.model.js';
import Notification from './notification.model.js';
import { getDashboardInsights } from '../dashboard/dashboardInsights.service.js';
import { runContractEndCheck } from './contractEnd.job.js';

const DAY = 86_400_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const inDays = (n) => new Date(Date.now() + n * DAY);

const person = (role) =>
  User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
const employee = (contractEndDate, extra = {}) =>
  Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation: 'Clerk',
    joiningDate: new Date('2023-01-01'),
    contractEndDate,
    ...extra,
  });

describe('contract end alerts to HR', () => {
  it('tells HR once about a contract ending soon and once about one that just ended, not about old ones', async () => {
    const hr = await person('HR');
    const other = await person('Manager');
    const soon = await employee(inDays(10));
    const justEnded = await employee(inDays(-3));
    await employee(inDays(-60)); // long ended: on the dashboard list, not a notification
    await employee(inDays(200)); // far away

    const first = await runContractEndCheck();
    const second = await runContractEndCheck();

    expect(first.notificationsSent).toBe(2);
    expect(second.notificationsSent).toBe(0);
    const told = await Notification.find({ user: hr._id });
    expect(told.map((n) => n.url).sort()).toEqual([`/employees/${soon._id}`, `/employees/${justEnded._id}`].sort());
    expect(await Notification.countDocuments({ user: other._id })).toBe(0);
  });

  it('starts a fresh cycle when the contract is renewed with a new end date', async () => {
    const hr = await person('HR');
    const e = await employee(inDays(5));
    await runContractEndCheck();
    await Employee.updateOne({ _id: e._id }, { $set: { contractEndDate: inDays(12) } });

    const again = await runContractEndCheck();

    expect(again.notificationsSent).toBe(1);
    expect(await Notification.countDocuments({ user: hr._id })).toBe(2);
  });
});

describe('contracts ended, not renewed', () => {
  it('lists them oldest first until HR enters new dates, and leaves out exited people', async () => {
    const admin = { userId: String((await person('Admin'))._id), role: 'Admin' };
    const old = await employee(inDays(-40));
    await employee(inDays(-5));
    await employee(inDays(-90), { status: 'Exited' });
    await employee(inDays(20));

    const { contractsEnded } = await getDashboardInsights(admin);

    expect(contractsEnded.count).toBeGreaterThanOrEqual(2);
    expect(String(contractsEnded.items[0]._id)).toBe(String(old._id));
    expect(contractsEnded.items[0].daysOverdue).toBeGreaterThanOrEqual(39);

    await Employee.updateOne({ _id: old._id }, { $set: { contractEndDate: inDays(300) } });
    const after = await getDashboardInsights(admin);
    expect(after.contractsEnded.items.map((i) => String(i._id))).not.toContain(String(old._id));
  });
});

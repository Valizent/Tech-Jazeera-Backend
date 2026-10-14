/**
 * expiryAlert.job.test.js - the document-expiry ladder: who is told when, how often, and never twice.
 */
import User from '../auth/user.model.js';
import Employee from '../employees/employee.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import Notification from './notification.model.js';
import { runExpiryAlertCheck, expiryStep } from './expiryAlert.job.js';

const DAY = 86_400_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const inDays = (n) => new Date(Date.now() + n * DAY + 3_600_000);

const user = (role, extra = {}) =>
  User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role, ...extra });
const employee = (docs, extra = {}) =>
  Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation: 'Clerk',
    joiningDate: new Date('2023-01-01'),
    ...docs,
    ...extra,
  });
const told = async (u) => (await Notification.find({ user: u._id, type: 'Expiry' }).lean()).length;

describe('expiryStep', () => {
  it('is monthly, then weekly, then daily, then daily once expired', () => {
    expect(expiryStep(180)).toBe('m6');
    expect(expiryStep(95)).toBe('m4');
    expect(expiryStep(30)).toBe('w5');
    expect(expiryStep(8)).toBe('w2');
    expect(expiryStep(7)).toBe('d7');
    expect(expiryStep(0)).toBe('d0');
    expect(expiryStep(-3)).toMatch(/^x\d{4}-\d{2}-\d{2}$/);
  });
});

describe('document expiry ladder', () => {
  it('starts a passport at 6 months and an iqama at 3, and tells only the employee and HR early on', async () => {
    const hr = await user('HR');
    const head = await user('Manager');
    const e = await employee({ passport: { number: 'P1', expiry: inDays(170) }, iqama: { number: '1', expiry: inDays(170) } }, { manager: head._id });
    const login = await user('Staff', { employee: e._id });

    const first = await runExpiryAlertCheck();
    const second = await runExpiryAlertCheck();

    // passport is inside 6 months; the iqama (170 days) is not yet inside 3 months
    expect(first.notificationsSent).toBeGreaterThanOrEqual(2);
    expect(second.notificationsSent).toBe(0);
    expect(await told(hr)).toBeGreaterThanOrEqual(1);
    expect(await told(login)).toBe(1);
    expect(await told(head)).toBe(0);
  });

  it('brings in the coordinator and manager within 30 days and the GM role within 14', async () => {
    const hr = await user('HR');
    const manager = await user('Manager');
    const coordinator = await user('Coordinator');
    const gm = await user('Executive');
    await ApprovalRole.create({ name: 'GM', members: [gm._id] }).catch(() => ApprovalRole.updateOne({ name: 'GM' }, { $addToSet: { members: gm._id } }));
    await employee({ medical: { number: 'M1', expiry: inDays(20) } }, { manager: manager._id, coordinator: coordinator._id });
    await runExpiryAlertCheck();
    expect(await told(manager)).toBe(1);
    expect(await told(coordinator)).toBe(1);
    expect(await told(gm)).toBe(0);

    await employee({ medical: { number: 'M2', expiry: inDays(10) } }, { manager: manager._id });
    await runExpiryAlertCheck();
    expect(await told(gm)).toBe(1);
    expect(await told(hr)).toBeGreaterThanOrEqual(2);
  });

  it('starts a fresh ladder when the expiry date is renewed', async () => {
    const hr = await user('HR');
    const e = await employee({ drivingLicense: { number: 'D1', expiry: inDays(5) } });
    await runExpiryAlertCheck();
    const before = await told(hr);
    await Employee.updateOne({ _id: e._id }, { $set: { 'drivingLicense.expiry': inDays(120) } });

    const again = await runExpiryAlertCheck();

    expect(again.notificationsSent).toBeGreaterThanOrEqual(1);
    expect(await told(hr)).toBeGreaterThan(before);
  });
});

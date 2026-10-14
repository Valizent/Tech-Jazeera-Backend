/**
 * dashboardHr.test.js - the HR desk on the dashboard (2026-10-14): HR does not get
 * System Health, does get the active-subcontractor count, the requests waiting in
 * each HR module (each behind the Read of its own module) and a headcount by
 * department.
 */
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import AnnualVacationRequest from '../annualVacation/annualVacation.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import AuditLog from '../audit/audit.model.js';
import { getDashboard } from './dashboard.service.js';
import { getDashboardInsights } from './dashboardInsights.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const DAY = 86_400_000;

async function viewer(role, keys = []) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
  if (keys.length) {
    const approvalRole = await ApprovalRole.create({ name: `Viewers ${unique()}`, members: [user._id] });
    for (const key of keys) {
      await SectionAccess.updateOne({ sectionKey: key }, { $addToSet: { readApprovalRoles: approvalRole._id }, $setOnInsert: { writeApprovalRoles: [] } }, { upsert: true });
    }
  }
  return { userId: String(user._id), role, id: user._id };
}

const staff = (department, extra = {}) =>
  Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2023-01-01'),
    department,
    ...extra,
  });

describe('the HR desk', () => {
  it('shows System Health to nobody who is HR, whatever they can read', async () => {
    await AuditLog.create({ action: 'auth.login.failed', meta: { email: 'a@b.c' } });
    const hr = await viewer('HR', ['auditLog', 'team', 'reconciliation']);
    const manager = await viewer('Manager', ['auditLog']);

    expect((await getDashboardInsights(hr)).systemHealth).toBeNull();
    expect((await getDashboardInsights(manager)).systemHealth).not.toBeNull();
  });

  it('sends HR no activity feed or system-health card even with the Audit log Read', async () => {
    const hr = await viewer('HR', ['auditLog']);
    const manager = await viewer('Manager', ['auditLog']);

    expect((await getDashboard({ actor: hr })).recentActivity).toBeNull();
    expect((await getDashboard({ actor: manager })).recentActivity).not.toBeNull();
  });

  it('gives HR the active-subcontractor count without the subcontractor Read; others still need it', async () => {
    await Subcontractor.create({ name: `Sub ${unique()}`, status: 'Active' });
    const hr = await viewer('HR');
    const accounts = await viewer('Accounts');

    expect((await getDashboard({ actor: hr })).activeSubcontractors).toBeGreaterThanOrEqual(1);
    expect((await getDashboard({ actor: accounts })).activeSubcontractors).toBeNull();
  });

  it('counts the requests waiting in each HR module behind that module Read', async () => {
    const employee = await staff('HR');
    await AnnualVacationRequest.create({
      employee: employee._id,
      startDate: new Date(Date.now() + 10 * DAY),
      endDate: new Date(Date.now() + 20 * DAY),
      requestedDays: 11,
      status: 'PendingReview',
    });
    await Timesheet.create({ employee: employee._id, periodStart: new Date(Date.UTC(2026, 8, 5)), periodEnd: new Date(Date.UTC(2026, 8, 11)), totalHours: 40, status: 'Submitted' });
    const reader = await viewer('HR', ['annualVacation', 'timesheetRequests']);
    const outsider = await viewer('HR');

    const seen = await getDashboard({ actor: reader });
    expect(seen.pendingAnnualVacation).toBeGreaterThanOrEqual(1);
    expect(seen.pendingTimesheets).toBeGreaterThanOrEqual(1);
    expect(seen.pendingFinancial).toBeNull();

    const none = await getDashboard({ actor: outsider });
    expect(none.pendingAnnualVacation).toBeNull();
    expect(none.pendingTimesheets).toBeNull();
  });

  it('counts internal staff per department, reading clear free-text and leaving the rest as not set', async () => {
    const hr = await viewer('HR', ['employeeCreate']);
    const before = (await getDashboard({ actor: hr })).departmentHeadcount;
    await staff('Accounts');
    await staff('accounting'); // an old free-text value that is clearly Accounts
    await staff('Something odd');
    await staff('IT', { status: 'Exited' }); // exited: not counted

    const after = (await getDashboard({ actor: hr })).departmentHeadcount;
    expect(after.counts.Accounts - before.counts.Accounts).toBe(2);
    expect(after.counts.IT - before.counts.IT).toBe(0);
    expect(after.unset - before.unset).toBe(1);

    const manager = await viewer('Manager', ['employeeCreate']);
    expect((await getDashboard({ actor: manager })).departmentHeadcount).toBeNull();
  });
});

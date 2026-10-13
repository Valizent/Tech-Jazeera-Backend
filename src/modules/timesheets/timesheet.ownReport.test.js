/**
 * timesheet.ownReport.test.js - a Coordinator opening their OWN monthly
 * timesheet (2026-10-13). Their own employee record is rarely on their own
 * team, and the team check used to run for their own month too, so the page
 * answered "You do not have access to one or more of these employees".
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import Employee from '../employees/employee.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import { getMonthlyReport } from './timesheet.controller.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const makeEmployee = (coordinator) =>
  Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: 'Report Subject',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
    ...(coordinator && { coordinator }),
  });

async function coordinatorWithRole(sectionKey) {
  const user = await User.create({ name: `Coordinator ${unique()}`, email: `c-${unique()}@example.com`, passwordHash: 'x', role: 'Coordinator' });
  const role = await ApprovalRole.create({ name: `Role ${unique()}`, members: [user._id] });
  await SectionAccess.create({ sectionKey, readApprovalRoles: [role._id] });
  return user;
}

const request = (user, employeeId) => ({
  user: { id: user._id.toString(), role: 'Coordinator', employee: user.employee?.toString() },
  query: { employeeId: employeeId.toString(), month: 10, year: 2026 },
  ip: '127.0.0.1',
});

const response = () => ({ json(body) { this.body = body; } });

describe('monthly timesheet report for a Coordinator', () => {
  it('opens their own month although their own record is not on their team', async () => {
    const user = await coordinatorWithRole('timesheetOwn');
    const own = await makeEmployee(); // no coordinator: not on anyone's team
    user.employee = own._id;
    const res = response();

    await getMonthlyReport(request(user, own._id), res);

    expect(res.body.success).toBe(true);
  });

  it("opens their own month through the everyone's-timesheets permission too", async () => {
    const user = await coordinatorWithRole('timesheetRequests');
    await SectionAccess.create({ sectionKey: 'timesheetOwn' }); // configured, nobody listed: no longer borrows
    const own = await makeEmployee();
    user.employee = own._id;
    const res = response();

    await getMonthlyReport(request(user, own._id), res);

    expect(res.body.success).toBe(true);
  });

  it("still refuses another employee outside the Coordinator's team", async () => {
    const user = await coordinatorWithRole('timesheetRequests');
    const stranger = await makeEmployee(new mongoose.Types.ObjectId());

    await expect(getMonthlyReport(request(user, stranger._id), response())).rejects.toMatchObject({ statusCode: 403 });
  });
});

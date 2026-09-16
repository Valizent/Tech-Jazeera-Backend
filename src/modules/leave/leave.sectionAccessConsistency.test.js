/**
 * leave.sectionAccessConsistency.test.js — regression coverage for the
 * consistency-sweep fix made this session (see CLAUDE.md's Section Access
 * entries / the 2026-09-15 QA retest's D1 finding class): `listLeaveRequests`
 * used to compute `canDecideCurrentStep` from `annotateCanDecide` alone
 * (ApprovalRole/legacy-role membership ONLY), never checking whether the
 * viewer actually holds real Section Access write on `leaveRequests` — the
 * real decide route (`decideLeaveRequest`, gated by
 * `requireSectionAccess('leaveRequests','write')` at the router level)
 * requires BOTH. A Manager with the right login role but no Section Access
 * grant used to see a working Approve/Reject button that would 403 on
 * click. Fixed by intersecting the hint with a real `canAccessSection`
 * check, mirroring the sibling fix already shipped in
 * financialRequests/advance.service.js's listAdvances.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import LeaveType from './leaveType.model.js';
import LeaveRequest from './leaveRequest.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import { updateSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { listLeaveRequests } from './leave.service.js';

async function makePendingLeaveRequest() {
  const employee = await Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
  });
  const leaveType = await LeaveType.create({
    name: `Test Leave ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    recurrence: 'Manual',
    minServiceMonths: 0,
  });
  await LeaveRequest.create({
    employee: employee._id,
    leaveType: leaveType._id,
    leaveTypeName: leaveType.name,
    startDate: new Date('2027-01-10'),
    endDate: new Date('2027-01-12'),
    days: 3,
    status: 'PendingReview', // legacy path — no workflow
  });
}

describe('listLeaveRequests canDecideCurrentStep — Section Access consistency', () => {
  it('a Manager (a legacy-allowed decide role) with NO leaveRequests Section Access write grant sees canDecideCurrentStep: false', async () => {
    await makePendingLeaveRequest();
    const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'Manager', employee: null };

    const { items } = await listLeaveRequests({ page: 1, limit: 20 }, actor);
    expect(items).toHaveLength(1);
    expect(items[0].canDecideCurrentStep).toBe(false);
  });

  it('the same Manager, once granted leaveRequests Section Access write via an ApprovalRole, sees canDecideCurrentStep: true', async () => {
    await makePendingLeaveRequest();
    const userId = new mongoose.Types.ObjectId();
    const actor = { userId: userId.toString(), role: 'Manager', employee: null };

    const role = await ApprovalRole.create({ name: `Test Reviewer ${Date.now()}`, isActive: true, members: [userId] });
    await updateSectionAccess(
      'leaveRequests',
      { readApprovalRoles: [], writeApprovalRoles: [role._id.toString()] },
      { userId: userId.toString(), ip: '127.0.0.1' }
    );

    const { items } = await listLeaveRequests({ page: 1, limit: 20 }, actor);
    expect(items).toHaveLength(1);
    expect(items[0].canDecideCurrentStep).toBe(true);
  });

  it('Admin always sees canDecideCurrentStep: true regardless of Section Access grants', async () => {
    await makePendingLeaveRequest();
    const actor = { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', employee: null };
    const { items } = await listLeaveRequests({ page: 1, limit: 20 }, actor);
    expect(items[0].canDecideCurrentStep).toBe(true);
  });
});

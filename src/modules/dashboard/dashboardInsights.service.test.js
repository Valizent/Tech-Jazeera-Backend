/**
 * dashboardInsights.service.test.js — the dashboard's second layer and the
 * portal home (2026-10-11): every block is null unless the viewer holds the
 * Read of the module it summarises, a Coordinator only ever sees their own
 * team, and the figures are the real counts (not estimates).
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import LeaveType from '../leave/leaveType.model.js';
import AuditLog from '../audit/audit.model.js';
import Attendance from '../attendance/attendance.model.js';
import Holiday from '../holidays/holiday.model.js';
import { getDashboardInsights } from './dashboardInsights.service.js';
import { getMyOverview } from '../me/meOverview.service.js';

const DAY = 86_400_000;
const oid = () => new mongoose.Types.ObjectId();
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const daysFromNow = (n) => new Date(Date.now() + n * DAY);
const utcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function employee(extra = {}) {
  return Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: `Person ${unique()}`,
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2022-01-01'),
    ...extra,
  });
}

/** A login in an approval role that holds Read (or Write) on the given sections. */
async function viewer(role, keys = [], extra = {}) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role, ...extra });
  if (keys.length) {
    const approvalRole = await ApprovalRole.create({ name: `Viewers ${unique()}`, members: [user._id] });
    for (const key of keys) {
      await SectionAccess.updateOne({ sectionKey: key }, { $addToSet: { readApprovalRoles: approvalRole._id }, $setOnInsert: { writeApprovalRoles: [] } }, { upsert: true });
    }
  }
  return { userId: String(user._id), role, user };
}

async function leave(emp, extra = {}) {
  const type = (await LeaveType.findOne({ name: 'Manual test' })) ?? (await LeaveType.create({ name: 'Manual test', recurrence: 'Manual' }));
  return LeaveRequest.create({
    employee: emp._id,
    leaveType: type._id,
    leaveTypeName: type.name,
    startDate: daysFromNow(-1),
    endDate: daysFromNow(2),
    days: 4,
    status: 'Approved',
    ...extra,
  });
}

describe('visibility: every block is null without its Read', () => {
  it('an HR login with no grants sees none of the gated blocks', async () => {
    const hr = await viewer('HR');
    await employee({ iqama: { number: '2000000001', expiry: daysFromNow(10) } });
    const insights = await getDashboardInsights(hr);
    expect(insights.systemHealth).toBeNull();
    expect(insights.stuckApprovals).toBeNull();
    expect(insights.expiringByType).toBeNull();
    expect(insights.contractsEnding).toBeNull();
    expect(insights.leavePicture).toBeNull();
    expect(insights.signedInToday).toBeNull();
    expect(insights.billing).toBeNull();
  });

  it('granting employeeCreate Read opens the HR blocks and nothing else', async () => {
    const hr = await viewer('HR', ['employeeCreate']);
    await employee({ iqama: { number: '2000000002', expiry: daysFromNow(10) } });
    const insights = await getDashboardInsights(hr);
    expect(insights.expiringByType).not.toBeNull();
    expect(insights.contractsEnding).not.toBeNull();
    expect(insights.leavePicture).toBeNull();
    expect(insights.billing).toBeNull();
  });
});

describe('HR watch', () => {
  it('buckets identity documents by how soon they lapse', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    await employee({ iqama: { number: '2000000003', expiry: daysFromNow(-3) } });
    await employee({ iqama: { number: '2000000004', expiry: daysFromNow(10) } });
    await employee({ iqama: { number: '2000000005', expiry: daysFromNow(45) } });
    await employee({ iqama: { number: '2000000006', expiry: daysFromNow(80) } });
    await employee({ iqama: { number: '2000000007', expiry: daysFromNow(200) } }); // outside the 90-day horizon
    const { expiringByType } = await getDashboardInsights(admin);
    const iqama = expiringByType.find((r) => r.type === 'iqama');
    expect(iqama).toMatchObject({ expired: 1, d30: 1, d60: 1, d90: 1 });
  });

  it('lists contracts ending within 30 days, soonest first, and ignores exited staff', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    await employee({ fullName: 'Ends soon', contractEndDate: daysFromNow(12) });
    await employee({ fullName: 'Ends sooner', contractEndDate: daysFromNow(3) });
    await employee({ fullName: 'Far away', contractEndDate: daysFromNow(120) });
    await employee({ fullName: 'Left already', contractEndDate: daysFromNow(5), status: 'Exited' });
    const { contractsEnding } = await getDashboardInsights(admin);
    expect(contractsEnding.count).toBe(2);
    expect(contractsEnding.items.map((i) => i.name)).toEqual(['Ends sooner', 'Ends soon']);
  });

  it('shows who is on leave today and who returns this week', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    const now = await employee({ fullName: 'On leave now' });
    const later = await employee({ fullName: 'Starts next month' });
    await leave(now, { startDate: daysFromNow(-2), endDate: daysFromNow(3) });
    await leave(later, { startDate: daysFromNow(30), endDate: daysFromNow(35) });
    await leave(now, { status: 'PendingReview' }); // not approved: ignored
    const { leavePicture } = await getDashboardInsights(admin);
    expect(leavePicture.onLeave.map((p) => p.name)).toEqual(['On leave now']);
    expect(leavePicture.returning.map((p) => p.name)).toEqual(['On leave now']);
  });

  it('narrows a Coordinator to their own team', async () => {
    const coordinator = await viewer('Coordinator', ['employeeCreate']);
    await employee({ fullName: 'Mine', coordinator: coordinator.user._id, iqama: { number: '2000000008', expiry: daysFromNow(5) } });
    await employee({ fullName: 'Someone else', coordinator: oid(), iqama: { number: '2000000009', expiry: daysFromNow(5) } });
    const { expiringByType } = await getDashboardInsights(coordinator);
    expect(expiringByType.find((r) => r.type === 'iqama').d30).toBe(1);
  });
});

describe('stuck approvals', () => {
  it('counts only requests waiting longer than 3 days, with the role holding them', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    const emp = await employee();
    const role = await ApprovalRole.create({ name: 'Zz Reviewers', members: [] });
    const old = await leave(emp, { status: 'PendingReview', workflow: oid(), steps: [{ label: 'Review', roles: [role._id] }], currentStep: 0 });
    // createdAt is immutable through Mongoose, so age the row through the raw collection.
    await LeaveRequest.collection.updateOne({ _id: old._id }, { $set: { createdAt: daysFromNow(-6) } });
    await leave(emp, { status: 'PendingReview', startDate: daysFromNow(40), endDate: daysFromNow(41) }); // fresh: not stuck
    const { stuckApprovals } = await getDashboardInsights(admin);
    expect(stuckApprovals).toHaveLength(1);
    expect(stuckApprovals[0]).toMatchObject({ label: 'Leave requests', count: 1, oldestDays: 6, waitingOn: ['Zz Reviewers'] });
  });

  it('is never returned to a Coordinator', async () => {
    const coordinator = await viewer('Coordinator', ['leaveRequests']);
    const { stuckApprovals } = await getDashboardInsights(coordinator);
    expect(stuckApprovals).toBeNull();
  });
});

describe('system health', () => {
  it('counts failed logins (24h), grant changes (7d) and logins never used, each behind its own Read', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    const used = await User.create({ name: 'Used', email: `used-${unique()}@example.com`, passwordHash: 'x', role: 'HR' });
    await User.create({ name: 'Never', email: `never-${unique()}@example.com`, passwordHash: 'x', role: 'HR' });
    await AuditLog.create({ action: 'auth.login.success', user: used._id });
    await AuditLog.create({ action: 'auth.login.failed', meta: { email: 'a@b.c' } });
    await AuditLog.create({ action: 'auth.login.failed', meta: { email: 'a@b.c' } });
    const stale = await AuditLog.create({ action: 'auth.login.failed', meta: { email: 'a@b.c' } });
    await AuditLog.collection.updateOne({ _id: stale._id }, { $set: { createdAt: daysFromNow(-3) } });
    await AuditLog.create({ action: 'sectionAccess.update' });

    const { systemHealth } = await getDashboardInsights(admin);
    expect(systemHealth.failedLogins24h).toBe(2);
    expect(systemHealth.grantsChanged7d).toBe(1);
    expect(systemHealth.neverLoggedIn).toBe(1);
    expect(systemHealth.reconciliationFindings).toBe(0);

    const onlyAudit = await viewer('Manager', ['auditLog']);
    const partial = (await getDashboardInsights(onlyAudit)).systemHealth;
    expect(partial.failedLogins24h).toBe(2);
    expect(partial.neverLoggedIn).toBeNull();
    expect(partial.reconciliationFindings).toBeNull();
  });
});

describe('floor today', () => {
  it('lists who signed in today', async () => {
    const admin = { userId: String(oid()), role: 'Admin' };
    const a = await employee({ fullName: 'Early bird' });
    const b = await employee({ fullName: 'Marked absent' });
    await Attendance.create({ employee: a._id, date: utcDay(), status: 'Present', checkInTime: new Date() });
    await Attendance.create({ employee: b._id, date: utcDay(), status: 'Absent' });
    const { signedInToday } = await getDashboardInsights(admin);
    expect(signedInToday.count).toBe(1);
    expect(signedInToday.recent[0].name).toBe('Early bird');
  });
});

describe('decided this week', () => {
  it('counts the requests this viewer decided in the last 7 days', async () => {
    const reviewer = await viewer('HR');
    const emp = await employee();
    await leave(emp, { decidedBy: reviewer.user._id, decidedAt: daysFromNow(-2) });
    await leave(emp, { decidedBy: reviewer.user._id, decidedAt: daysFromNow(-20), startDate: daysFromNow(50), endDate: daysFromNow(51) });
    await leave(emp, { decidedBy: oid(), decidedAt: daysFromNow(-1), startDate: daysFromNow(60), endDate: daysFromNow(61) });
    const insights = await getDashboardInsights(reviewer);
    expect(insights.decidedThisWeek).toBe(1);
  });
});

describe('portal home', () => {
  it('reports attendance today, leave balance, request counts, document warnings and vacation eligibility', async () => {
    await LeaveType.create({ name: 'Annual leave', recurrence: 'Annual', daysPerYear: 21 });
    await Holiday.create({ name: 'Zz Test Holiday', startDate: daysFromNow(9), endDate: daysFromNow(10) });
    const emp = await employee({
      iqama: { number: '2000000010', expiry: daysFromNow(15) },
      passport: { number: 'P1234567', expiry: daysFromNow(400) },
      contractEndDate: daysFromNow(-10), // ended: eligible for vacation
    });
    await Attendance.create({ employee: emp._id, date: utcDay(), status: 'Present', checkInTime: new Date() });
    await leave(emp, { status: 'PendingReview', startDate: daysFromNow(20), endDate: daysFromNow(21) });
    await leave(emp, { status: 'Rejected', startDate: daysFromNow(30), endDate: daysFromNow(31) });

    const overview = await getMyOverview(emp._id.toString());
    expect(overview.today).toMatchObject({ signedIn: true, signedOut: false });
    expect(overview.requests).toMatchObject({ pending: 1, rejected: 1 });
    expect(overview.documentWarnings.map((d) => d.type)).toEqual(['iqama']);
    expect(overview.nextHoliday.name).toBe('Zz Test Holiday');
    const annual = overview.leaveBalances.find((b) => b.leaveType === 'Annual leave');
    expect(annual).toMatchObject({ entitlementDays: 21, usedDays: 0, remainingDays: 21 });
    expect(overview.contract.vacationEligible).toBe(true);
  });

  it('says why annual vacation is not available yet', async () => {
    const emp = await employee({ contractEndDate: daysFromNow(200), joiningDate: new Date('2026-05-01') });
    const overview = await getMyOverview(emp._id.toString());
    expect(overview.contract.vacationEligible).toBe(false);
    expect(overview.contract.vacationReason).toMatch(/contract period has ended/i);
    expect(overview.today.signedIn).toBe(false);
  });
});

/**
 * annualVacation.service.test.js — the Annual Vacation flow end to end at the
 * service level: eligibility, ownership (the V2-S01 guard that never fired),
 * overlap rules, the approval engine, and the approved LeaveRequest it records.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import LeaveType from '../leave/leaveType.model.js';
import Notification from '../notifications/notification.model.js';
import User from '../auth/user.model.js';
import AnnualVacationRequest from './annualVacation.model.js';
import {
  submitOwnAnnualVacation,
  submitAnnualVacationFor,
  cancelAnnualVacation,
  decideAnnualVacation,
  listAnnualVacation,
  getEligibility,
} from './annualVacation.service.js';
import { updateEmployee } from '../employees/employee.service.js';

const oid = () => new mongoose.Types.ObjectId().toString();
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: oid(), role: 'Admin', ip: '127.0.0.1' });
const futureDay = (daysAhead) => new Date(Date.now() + daysAhead * 86_400_000);
const utcDayIn = (daysAhead) => {
  const d = futureDay(daysAhead);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

async function makeEmployee(extra = {}) {
  return Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2022-01-01'),
    contractEndDate: new Date('2025-01-01'), // already ended -> eligible
    annualVacationDays: 5, // the contract's days (set by HR); a request always starts from them
    ...extra,
  });
}

describe('Annual Vacation submission', () => {
  it('records the request with the end date derived from start + days', async () => {
    const employee = await makeEmployee();
    const start = futureDay(10);
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: start, requestedDays: 5, reason: 'Home' }, admin());
    expect(request.status).toBe('PendingReview');
    expect(request.requestedDays).toBe(5);
    expect(new Date(request.endDate).getTime() - new Date(request.startDate).getTime()).toBe(4 * 86_400_000);
  });

  it('can be filed before the contract ends, but the first day must come after the end date', async () => {
    const employee = await makeEmployee({
      joiningDate: new Date('2025-06-01'),
      contractStartDate: new Date('2025-06-10'),
      contractEndDate: futureDay(200),
    });
    await expect(
      submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/only after the contract end date/) });

    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(201), requestedDays: 5 }, admin());
    expect(request.status).toBe('PendingReview');
  });

  it('a contract renewed before it ended still follows the replaced end date, and the push moves the new end', async () => {
    const oldEnd = utcDayIn(60);
    const newEnd = utcDayIn(150);
    const employee = await makeEmployee({ contractEndDate: oldEnd, annualVacationDays: 5 });
    await updateEmployee(employee._id.toString(), { contractEndDate: newEnd }, admin());
    const renewed = await Employee.findById(employee._id).lean();
    expect(new Date(renewed.previousContractEndDate).getTime()).toBe(oldEnd.getTime());

    // the first day still has to be after the OLD end, not the new one
    const eligibility = await getEligibility(employee._id.toString(), admin());
    expect(eligibility.eligible).toBe(true);
    expect(new Date(eligibility.earliestStart).getTime()).toBe(oldEnd.getTime() + 86_400_000);

    const request = await submitOwnAnnualVacation(
      employee._id.toString(),
      { startDate: utcDayIn(65), requestedDays: 5 },
      admin()
    );
    await decideAnnualVacation(request._id.toString(), { status: 'Approved' }, admin());

    const after = await Employee.findById(employee._id).lean();
    expect(new Date(after.contractEndDate).getTime()).toBe(newEnd.getTime() + 5 * 86_400_000);
    // one vacation per period: a second one is refused until the next renewal
    await expect(
      submitOwnAnnualVacation(employee._id.toString(), { startDate: utcDayIn(200), requestedDays: 5 }, admin())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a contract that was not renewed keeps its dates when the vacation is approved', async () => {
    const employee = await makeEmployee({ annualVacationDays: 5 });
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());
    await decideAnnualVacation(request._id.toString(), { status: 'Approved' }, admin());
    const after = await Employee.findById(employee._id).lean();
    expect(new Date(after.contractEndDate).getTime()).toBe(new Date('2025-01-01').getTime());
  });

  it('refuses a second open request and overlapping dates', async () => {
    const employee = await makeEmployee();
    await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());
    await expect(
      submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(40), requestedDays: 3 }, admin())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses dates that overlap existing leave', async () => {
    const employee = await makeEmployee();
    const type = await LeaveType.create({ name: `Manual ${unique()}`, recurrence: 'Manual' });
    await LeaveRequest.create({
      employee: employee._id,
      leaveType: type._id,
      leaveTypeName: type.name,
      startDate: futureDay(10),
      endDate: futureDay(14),
      days: 5,
      status: 'Approved',
    });
    await expect(
      submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(12), requestedDays: 3 }, admin())
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Filing on behalf (V2-S01: the ownership guard must actually guard)', () => {
  it('a Coordinator without the Write grant cannot file for anyone', async () => {
    const employee = await makeEmployee();
    const coordinator = { userId: oid(), role: 'Coordinator', ip: '127.0.0.1' };
    await expect(
      submitAnnualVacationFor(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, coordinator)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await AnnualVacationRequest.countDocuments({})).toBe(0);
  });

  it('an Admin can file for an employee', async () => {
    const employee = await makeEmployee();
    const request = await submitAnnualVacationFor(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());
    expect(String(request.employee)).toBe(String(employee._id));
  });
});

describe('Cancel and decide', () => {
  it('only the owner can cancel, and only while pending', async () => {
    const employee = await makeEmployee();
    const other = await makeEmployee();
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());

    await expect(cancelAnnualVacation(other._id.toString(), request._id.toString(), admin())).rejects.toMatchObject({ statusCode: 403 });
    const cancelled = await cancelAnnualVacation(employee._id.toString(), request._id.toString(), admin());
    expect(cancelled.status).toBe('Cancelled');
    await expect(cancelAnnualVacation(employee._id.toString(), request._id.toString(), admin())).rejects.toMatchObject({ statusCode: 400 });
  });

  it('approving records an approved leave and tells the employee', async () => {
    const employee = await makeEmployee({ annualVacationDays: 7 });
    await User.create({ name: 'Worker', email: `w-${unique()}@example.com`, passwordHash: 'x', role: 'Worker', employee: employee._id });
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 7, reason: 'Home' }, admin());

    const decided = await decideAnnualVacation(request._id.toString(), { status: 'Approved' }, admin());
    expect(decided.status).toBe('Approved');

    const fresh = await AnnualVacationRequest.findById(request._id).lean();
    expect(fresh.linkedLeaveRequest).toBeTruthy();
    const leave = await LeaveRequest.findById(fresh.linkedLeaveRequest).lean();
    expect(leave).toMatchObject({ status: 'Approved', days: 7, leaveTypeName: 'Annual Vacation' });
    expect(String(leave.employee)).toBe(String(employee._id));
    expect(await Notification.countDocuments({ title: /annual vacation request approved/i })).toBe(1);
  });

  it('rejecting records nothing and keeps the request rejected', async () => {
    const employee = await makeEmployee();
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 3 }, admin());
    const decided = await decideAnnualVacation(request._id.toString(), { status: 'Rejected', decisionNote: 'Busy season' }, admin());
    expect(decided.status).toBe('Rejected');
    expect(await LeaveRequest.countDocuments({})).toBe(0);
  });

  it('reverts the approval, and tells nobody, when leave was filed over the same dates meanwhile', async () => {
    const employee = await makeEmployee();
    await User.create({ name: 'Worker', email: `w-${unique()}@example.com`, passwordHash: 'x', role: 'Worker', employee: employee._id });
    const request = await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());
    const type = await LeaveType.create({ name: `Manual ${unique()}`, recurrence: 'Manual' });
    await LeaveRequest.create({
      employee: employee._id,
      leaveType: type._id,
      leaveTypeName: type.name,
      startDate: futureDay(11),
      endDate: futureDay(12),
      days: 2,
      status: 'Approved',
    });

    await expect(decideAnnualVacation(request._id.toString(), { status: 'Approved' }, admin())).rejects.toMatchObject({ statusCode: 409 });
    const fresh = await AnnualVacationRequest.findById(request._id).lean();
    expect(fresh.status).toBe('PendingReview');
    expect(fresh.linkedLeaveRequest).toBeNull();
    expect(await Notification.countDocuments({ title: /annual vacation request approved/i })).toBe(0);
  });

  it('the review queue lists requests with who can decide them', async () => {
    const employee = await makeEmployee();
    await submitOwnAnnualVacation(employee._id.toString(), { startDate: futureDay(10), requestedDays: 5 }, admin());
    const { items, total } = await listAnnualVacation({ page: 1, limit: 20 }, admin());
    expect(total).toBe(1);
    expect(items[0].canDecideCurrentStep).toBe(true);
  });
});

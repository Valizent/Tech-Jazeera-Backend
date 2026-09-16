/**
 * leave.service.test.js — regression coverage for F3 (docs/QA-AUDIT-2026-09-
 * 15-notes.md): two concurrent leave submissions for the SAME employee used
 * to both pass the overlap/entitlement checks against the same
 * pre-either-request snapshot (no natural MongoDB write conflict for two
 * inserts of DIFFERENT documents) — fixed with a real serialization point,
 * `LeaveSubmissionLock` (a unique index on `employee`).
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import LeaveType from './leaveType.model.js';
import LeaveRequest from './leaveRequest.model.js';
import LeaveSubmissionLock from './leaveSubmissionLock.model.js';
import { submitLeaveRequest } from './leave.service.js';

function actor() {
  return { userId: new mongoose.Types.ObjectId().toString(), ip: '127.0.0.1' };
}

async function makeEmployee() {
  return Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
  });
}

async function makeLeaveType() {
  return LeaveType.create({
    name: `Test Leave ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    recurrence: 'Manual',
    minServiceMonths: 0,
  });
}

describe('leave.service submitLeaveRequest', () => {
  // The F3 fix's whole mechanism is a unique index on LeaveSubmissionLock.employee
  // — against a freshly created mongodb-memory-server, Mongoose builds that
  // index asynchronously after model registration, so the very first test to
  // exercise it could race the index build itself and see BOTH concurrent
  // inserts succeed (a flake, not a real failure of the fix). `Model.init()`
  // resolves once the model's indexes are actually built; safe to await here
  // even if another test file already triggered it.
  beforeAll(() => LeaveSubmissionLock.init());

  it('F3: two concurrent overlapping submissions for the same employee — exactly one succeeds, one 409s', async () => {
    const employee = await makeEmployee();
    const leaveType = await makeLeaveType();
    const payload = {
      leaveType: leaveType._id.toString(),
      startDate: new Date('2027-01-10'),
      endDate: new Date('2027-01-12'),
      reason: 'Concurrency test',
    };

    const results = await Promise.allSettled([
      submitLeaveRequest(employee._id.toString(), payload, null, actor()),
      submitLeaveRequest(employee._id.toString(), payload, null, actor()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);

    const requests = await LeaveRequest.find({ employee: employee._id }).lean();
    expect(requests).toHaveLength(1);
  });

  it('releases the submission lock after every request, success or failure', async () => {
    const employee = await makeEmployee();
    const leaveType = await makeLeaveType();

    await submitLeaveRequest(
      employee._id.toString(),
      { leaveType: leaveType._id.toString(), startDate: new Date('2027-02-01'), endDate: new Date('2027-02-02'), reason: 'First' },
      null,
      actor()
    );
    // A second, non-overlapping submission for the same employee must not be
    // blocked by a lock left behind from the first (already-finished) call.
    await expect(
      submitLeaveRequest(
        employee._id.toString(),
        { leaveType: leaveType._id.toString(), startDate: new Date('2027-03-01'), endDate: new Date('2027-03-02'), reason: 'Second' },
        null,
        actor()
      )
    ).resolves.toBeTruthy();

    const lock = await LeaveSubmissionLock.findOne({ employee: employee._id }).lean();
    expect(lock).toBeNull();
  });

  it('rejects an overlapping submission against an existing PendingReview request (no lock contention needed)', async () => {
    const employee = await makeEmployee();
    const leaveType = await makeLeaveType();
    await submitLeaveRequest(
      employee._id.toString(),
      { leaveType: leaveType._id.toString(), startDate: new Date('2027-04-10'), endDate: new Date('2027-04-15'), reason: 'First' },
      null,
      actor()
    );
    await expect(
      submitLeaveRequest(
        employee._id.toString(),
        { leaveType: leaveType._id.toString(), startDate: new Date('2027-04-14'), endDate: new Date('2027-04-16'), reason: 'Overlaps' },
        null,
        actor()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

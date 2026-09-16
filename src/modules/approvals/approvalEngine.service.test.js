/**
 * approvalEngine.service.test.js — regression coverage for the shared
 * decide engine's two real, QA-audit-found bugs (docs/QA-AUDIT-2026-09-15-
 * notes.md), both affecting every request type that reuses this engine
 * (Leave/SalaryAdvance/Reimbursement/Timesheet/Certificate/ExitReentry):
 *   F1: the legacy (no-workflow) decide path read-then-saved, so two
 *       concurrent decisions on the same request could both "win".
 *   F2: a notification failure inside the terminal Approved branch used to
 *       propagate out uncaught, aborting whatever business logic the
 *       caller still had to run after `decideApprovalStep` returned.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import Notification from '../notifications/notification.model.js';
import { decideApprovalStep } from './approvalEngine.service.js';

function actor(role = 'Admin') {
  return { userId: new mongoose.Types.ObjectId().toString(), role, ip: '127.0.0.1' };
}

/** With a linked User login, so the engine's default `notifyFinal`
 *  (notifyEmployeeUser) actually resolves a recipient and reaches
 *  Notification.create — without a login it short-circuits to a no-op,
 *  which would make the F2 fault-injection test below pass trivially
 *  without ever exercising notifyBestEffort's catch. */
async function makePendingAdvance() {
  const employee = await Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
  });
  await User.create({
    name: 'Test Worker',
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    passwordHash: 'x',
    role: 'Worker',
    employee: employee._id,
  });
  return SalaryAdvance.create({ employee: employee._id, amount: 500, status: 'Pending' });
}

function decideAdvance(advanceId, decision, act) {
  return decideApprovalStep({
    Model: SalaryAdvance,
    id: advanceId,
    decision,
    actor: act,
    pendingStatus: 'Pending',
    legacyAllowedRoles: ['Admin', 'Manager', 'HR'],
    notFoundMessage: 'Advance request not found.',
    auditAction: 'advance',
    buildFinalNotification: (doc) => ({ type: 'RequestStatus', title: `Salary advance ${doc.status.toLowerCase()}`, url: '/financial-requests' }),
  });
}

describe('approvalEngine.decideApprovalStep — legacy (no-workflow) path', () => {
  it('F1: two concurrent decisions on the same request — exactly one wins, one gets a clean 409', async () => {
    const advance = await makePendingAdvance();
    const results = await Promise.allSettled([
      decideAdvance(advance._id.toString(), 'Approved', actor()),
      decideAdvance(advance._id.toString(), 'Rejected', actor()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);

    const fresh = await SalaryAdvance.findById(advance._id).lean();
    expect(['Approved', 'Rejected']).toContain(fresh.status);
    expect(fresh.status).toBe(fulfilled[0].value.status);
  });

  it('rejects an actor without a legacy-allowed role', async () => {
    const advance = await makePendingAdvance();
    await expect(decideAdvance(advance._id.toString(), 'Approved', actor('Coordinator'))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('F2: a Notification.create failure does not abort the decision — the status still commits and the caller still gets its result', async () => {
    const advance = await makePendingAdvance();
    const spy = vi.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('simulated notification outage'));

    const result = await decideAdvance(advance._id.toString(), 'Approved', actor());
    expect(result.status).toBe('Approved');
    expect(spy).toHaveBeenCalled(); // proves the fault was actually hit, not skipped

    const fresh = await SalaryAdvance.findById(advance._id).lean();
    expect(fresh.status).toBe('Approved');
    spy.mockRestore();
  });
});

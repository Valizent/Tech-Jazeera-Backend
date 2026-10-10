/**
 * qaAuditV2.regressions.test.js — regression coverage for the 6 October 2026
 * "Production Readiness Audit V2" findings fixed on 2026-10-10:
 *   F04 payment amounts: whole halalas only, capped
 *   F05 a stale asset return must not free a re-assigned asset
 *   F06 leave that crosses the leave-year start is refused (one request per year)
 *   F07 the engine's onApproved hook runs BEFORE the "approved" notification
 *   F08 at most one requirement stage is the fully-mobilised destination
 */
import mongoose from 'mongoose';
import Employee from './employees/employee.model.js';
import User from './auth/user.model.js';
import SalaryAdvance from './financialRequests/advance.model.js';
import Notification from './notifications/notification.model.js';
import Asset from './assets/asset.model.js';
import AssetAssignment from './assets/assetAssignment.model.js';
import LeaveType from './leave/leaveType.model.js';
import RequirementStage from './requirements/requirementStage.model.js';
import { decideApprovalStep } from './approvals/approvalEngine.service.js';
import {
  recordClientPaymentSchema,
  recordSubcontractorPaymentSchema,
  recordSubInvoiceSchema,
} from './deployments/deployment.validation.js';
import { assignAsset, createAsset, returnAsset } from './assets/asset.service.js';
import { submitLeaveRequest } from './leave/leave.service.js';
import { createStage } from './requirements/requirementStage.service.js';

const actor = (role = 'Admin') => ({ userId: new mongoose.Types.ObjectId().toString(), role, ip: '127.0.0.1' });
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function makeEmployee(extra = {}) {
  return Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
    ...extra,
  });
}

describe('F04 payment amounts', () => {
  for (const [name, schema] of [
    ['client', recordClientPaymentSchema],
    ['subcontractor', recordSubcontractorPaymentSchema],
  ]) {
    it(`${name}: rejects a fraction of a halala, an overflow and zero, accepts a normal amount`, () => {
      expect(schema.safeParse({ amount: 0.011 }).success).toBe(false);
      expect(schema.safeParse({ amount: 1e308 }).success).toBe(false);
      expect(schema.safeParse({ amount: 10_000_000.01 }).success).toBe(false);
      expect(schema.safeParse({ amount: 0 }).success).toBe(false);
      expect(schema.safeParse({ amount: 12.34 }).success).toBe(true);
      expect(schema.safeParse({ amount: 10_000_000 }).success).toBe(true);
    });
  }
});

describe('F01 subcontractor invoice record', () => {
  it('requires the invoice number and date, so an empty record can no longer mark a month invoiced', () => {
    expect(recordSubInvoiceSchema.safeParse({}).success).toBe(false);
    expect(recordSubInvoiceSchema.safeParse({ invoiceNumber: '  ', invoiceDate: '2026-10-01' }).success).toBe(false);
    expect(recordSubInvoiceSchema.safeParse({ invoiceNumber: 'SUB-1' }).success).toBe(false);
    expect(recordSubInvoiceSchema.safeParse({ invoiceNumber: 'SUB-1', invoiceDate: '2026-10-01' }).success).toBe(true);
  });
});

describe('F05 asset return is compare-and-set', () => {
  it('two concurrent returns of the same asset: exactly one wins, the asset ends Available with no active assignment', async () => {
    const holder = await makeEmployee();
    const asset = await createAsset({ assetTag: `T-${unique()}`, name: 'Laptop', category: 'Laptop' }, actor());
    await assignAsset(asset._id.toString(), { employee: holder._id.toString() }, actor());

    const results = await Promise.allSettled([
      returnAsset(asset._id.toString(), {}, actor()),
      returnAsset(asset._id.toString(), {}, actor()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect([400, 409]).toContain(failure.reason.statusCode);

    const fresh = await Asset.findById(asset._id).lean();
    expect(fresh.status).toBe('Available');
    expect(await AssetAssignment.countDocuments({ asset: asset._id, status: 'Active' })).toBe(0);
  });

  it('a return that no longer matches the current holder does not free the asset', async () => {
    const first = await makeEmployee();
    const second = await makeEmployee();
    const asset = await createAsset({ assetTag: `T-${unique()}`, name: 'Phone', category: 'Mobile Device' }, actor());
    await assignAsset(asset._id.toString(), { employee: first._id.toString() }, actor());
    // The holder changes underneath a return that already read the first assignment.
    await Asset.updateOne({ _id: asset._id }, { currentEmployee: second._id });

    await expect(returnAsset(asset._id.toString(), {}, actor())).rejects.toMatchObject({ statusCode: 409 });
    const fresh = await Asset.findById(asset._id).lean();
    expect(String(fresh.currentEmployee)).toBe(String(second._id));
    expect(fresh.status).toBe('Assigned');
  });
});

describe('F06 leave across the leave-year start', () => {
  it('refuses a request that crosses the joining anniversary, accepts one inside a single leave year', async () => {
    const employee = await makeEmployee({ joiningDate: new Date('2024-01-01') });
    const annual = await LeaveType.create({
      name: `Annual ${unique()}`,
      recurrence: 'Annual',
      minServiceMonths: 0,
      daysPerYear: 10,
    });
    const base = { leaveType: annual._id.toString(), reason: 'test' };

    await expect(
      submitLeaveRequest(employee._id.toString(), { ...base, startDate: new Date('2026-12-30'), endDate: new Date('2027-01-02') }, null, actor())
    ).rejects.toMatchObject({ statusCode: 400 });

    const ok = await submitLeaveRequest(
      employee._id.toString(),
      { ...base, startDate: new Date('2027-01-05'), endDate: new Date('2027-01-06') },
      null,
      actor()
    );
    expect(ok.days).toBe(2);
  });
});

describe('F07 onApproved runs before the final notification', () => {
  async function pendingAdvance() {
    const employee = await makeEmployee();
    await User.create({ name: 'Worker', email: `w-${unique()}@example.com`, passwordHash: 'x', role: 'Worker', employee: employee._id });
    return SalaryAdvance.create({ employee: employee._id, amount: 100, status: 'Pending' });
  }
  const decide = (advance, onApproved) =>
    decideApprovalStep({
      Model: SalaryAdvance,
      id: advance._id.toString(),
      decision: 'Approved',
      actor: actor(),
      pendingStatus: 'Pending',
      legacyAllowedRoles: ['Admin'],
      notFoundMessage: 'not found',
      auditAction: 'advance',
      buildFinalNotification: () => ({ type: 'RequestStatus', title: 'approved', url: '/x' }),
      onApproved,
    });

  it('a throwing hook propagates and no "approved" notification is stored', async () => {
    const advance = await pendingAdvance();
    await expect(
      decide(advance, async () => {
        throw new Error('deployment failed');
      })
    ).rejects.toThrow('deployment failed');
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('a successful hook runs first and the notification is then stored', async () => {
    const advance = await pendingAdvance();
    const order = [];
    await decide(advance, async () => {
      order.push(`hook:${await Notification.countDocuments({})}`);
    });
    expect(order).toEqual(['hook:0']);
    expect(await Notification.countDocuments({})).toBe(1);
  });
});

describe('F08 exclusive mobilised stage', () => {
  beforeAll(() => RequirementStage.init());

  it('two concurrent flagged creates leave exactly one flagged stage', async () => {
    const results = await Promise.allSettled([
      createStage({ name: `A ${unique()}`, isMobilisedStage: true }, actor()),
      createStage({ name: `B ${unique()}`, isMobilisedStage: true }, actor()),
    ]);
    expect(await RequirementStage.countDocuments({ isMobilisedStage: true })).toBe(1);
    for (const failed of results.filter((r) => r.status === 'rejected')) expect(failed.reason.statusCode).toBe(409);
  });
});

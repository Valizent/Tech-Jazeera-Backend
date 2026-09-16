/**
 * advance.service.test.js — regression coverage for the SalaryAdvance
 * repayment ledger's real, QA-audit-found bugs (docs/QA-AUDIT-2026-09-15-
 * notes.md), the sibling of invoice.service.js's recordPayment:
 *   S1: pipeline-update injection via an unwrapped `$`-prefixed field.
 *   F5: raw IEEE-754 float drift (1.10 + 0.10 !== 1.20 exactly) rejected a
 *       legitimate final repayment that should close the advance at zero.
 *   F1-class race: two concurrent repayments over-repaying past the amount.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import SalaryAdvance from './advance.model.js';
import { addRepayment } from './advance.service.js';
import { addRepaymentSchema } from './advance.validation.js';

function actor() {
  return { userId: new mongoose.Types.ObjectId().toString(), ip: '127.0.0.1' };
}

async function makeApprovedAdvance(amount = 100) {
  const employee = await Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2024-01-01'),
  });
  return SalaryAdvance.create({ employee: employee._id, amount, status: 'Approved' });
}

describe('advance.validation addRepaymentSchema (F4-sibling)', () => {
  it('rejects a sub-cent amount', () => {
    expect(addRepaymentSchema.safeParse({ amount: 0.015, date: new Date() }).success).toBe(false);
  });
  it('accepts a real 2dp amount', () => {
    expect(addRepaymentSchema.safeParse({ amount: 1.1, date: new Date() }).success).toBe(true);
  });
});

describe('advance.service addRepayment', () => {
  it('S1: stores a $-prefixed note as literal text', async () => {
    const advance = await makeApprovedAdvance(100);
    const updated = await addRepayment(advance._id.toString(), { amount: 10, date: new Date(), note: '$reason' }, actor());
    expect(updated.repayments.at(-1).note).toBe('$reason');
  });

  it('F5: 1.10 then 0.10 repayment against a 1.20 advance correctly closes it despite float drift', async () => {
    const advance = await makeApprovedAdvance(1.2);
    await addRepayment(advance._id.toString(), { amount: 1.1, date: new Date() }, actor());
    const updated = await addRepayment(advance._id.toString(), { amount: 0.1, date: new Date() }, actor());
    expect(updated.outstandingBalance).toBe(0);
    expect(updated.status).toBe('Closed');
  });

  it('F1-class race: two concurrent repayments that together exceed the amount — exactly one succeeds', async () => {
    const advance = await makeApprovedAdvance(100);
    const results = await Promise.allSettled([
      addRepayment(advance._id.toString(), { amount: 70, date: new Date() }, actor()),
      addRepayment(advance._id.toString(), { amount: 70, date: new Date() }, actor()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const fresh = await SalaryAdvance.findById(advance._id).lean();
    expect(fresh.repayments).toHaveLength(1);
    expect(fresh.repayments[0].amount).toBe(70);
  });

  it('rejects a repayment recorded against a non-Approved advance', async () => {
    const advance = await makeApprovedAdvance(100);
    await SalaryAdvance.updateOne({ _id: advance._id }, { status: 'Pending' });
    await expect(addRepayment(advance._id.toString(), { amount: 10, date: new Date() }, actor())).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

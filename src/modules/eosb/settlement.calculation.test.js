/**
 * settlement.calculation.test.js — the End of Service award follows Saudi
 * Labor Law Articles 84-85 and leave is paid at the real unused balance
 * (2026-10-11; before this a flat 2 x wage and a fixed 45 / 21 days replaced
 * the law for anyone with 2+ years).
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import LeaveType from '../leave/leaveType.model.js';
import { computeEosb, createSettlement } from './settlement.service.js';

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });
const base = { joiningDate: d('2019-01-01'), monthlyWage: 6000 };

describe('computeEosb (Articles 84 and 85)', () => {
  it('terminated after 6 years: half a month x 5 years + a full month x 1 year', () => {
    const r = computeEosb({ ...base, exitDate: d('2025-01-01'), exitReason: 'TerminationByEmployer' });
    expect(r).toMatchObject({ serviceYears: 6, eosbGross: 21000, reductionFactor: 1, eosbNet: 21000 });
  });

  it('end of contract after 3 years: half a month per year', () => {
    const r = computeEosb({ joiningDate: d('2022-01-01'), monthlyWage: 6000, exitDate: d('2025-01-01'), exitReason: 'EndOfContract' });
    expect(r.eosbGross).toBe(9000);
    expect(r.eosbNet).toBe(9000);
  });

  it('under 1 year still accrues, pro-rated by whole months', () => {
    const r = computeEosb({ joiningDate: d('2024-07-01'), monthlyWage: 6000, exitDate: d('2025-01-01'), exitReason: 'EndOfContract' });
    expect(r.serviceYears).toBe(0.5);
    expect(r.eosbGross).toBe(1500);
  });

  it('resignation: nothing under 2 years, a third at 2-5, two thirds at 5-10, full from 10', () => {
    const at = (joined, exit) => computeEosb({ joiningDate: d(joined), monthlyWage: 6000, exitDate: d(exit), exitReason: 'Resignation' });
    expect(at('2024-01-01', '2025-01-01').eosbNet).toBe(0);
    expect(at('2022-01-01', '2025-01-01')).toMatchObject({ eosbGross: 9000, eosbNet: 3000 });
    expect(at('2018-01-01', '2025-01-01')).toMatchObject({ eosbGross: 15000 + 2 * 6000, eosbNet: 18000 });
    expect(at('2013-01-01', '2025-01-01')).toMatchObject({ eosbGross: 15000 + 7 * 6000, eosbNet: 57000 });
  });

  it('refuses an exit date on or before joining', () => {
    expect(() => computeEosb({ ...base, exitDate: d('2019-01-01'), exitReason: 'EndOfContract' })).toThrow(/after the joining date/);
  });
});

describe('createSettlement leave pay', () => {
  it('pays the real unused balance at the daily wage, not a fixed number of days', async () => {
    await LeaveType.create({ name: 'Annual leave', recurrence: 'Annual', daysPerYear: 21 });
    const employee = await Employee.create({
      employeeId: 'EOSB-1',
      fullName: 'Test Leaver',
      type: 'Own',
      designation: 'Fitter',
      joiningDate: d('2019-01-01'),
      salary: 6000,
    });
    const s = await createSettlement({ employee: employee._id.toString(), exitDate: d('2025-01-01'), exitReason: 'TerminationByEmployer' }, admin());
    expect(s.eosbGross).toBe(21000);
    expect(s.unusedLeaveDays).toBe(21);
    expect(s.leaveEncashment).toBe(4200);
    expect(s.totalSettlement).toBe(25200);
  });
});

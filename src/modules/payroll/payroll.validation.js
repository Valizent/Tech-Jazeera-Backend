/**
 * Zod schemas for the Payroll module. Note: no money TOTAL is ever accepted
 * from the client (grossPay/totalDeductions/netPay are always computed) —
 * only the inputs a line's totals derive from.
 */
import { z } from 'zod';
import { PAYROLL_STATUSES } from './payrollRun.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const createPayrollRunSchema = z.object({
  periodYear: z.coerce.number().int().min(2020).max(2100),
  periodMonth: z.coerce.number().int().min(1).max(12),
});

const deductionLineSchema = z.object({
  label: z.string().trim().min(1, 'Label is required.').max(100),
  // Capped 2026-09-14 (a real QA-audit-found gap) — matches the sibling
  // otherAllowances/gosiDeduction fields' own bound just below, which this
  // one had been missing.
  amount: z.coerce.number().min(0).max(1_000_000),
});

export const updatePayrollLineSchema = z.object({
  otherAllowances: z.coerce.number().min(0).max(1_000_000).default(0),
  gosiDeduction: z.coerce.number().min(0).max(1_000_000).default(0),
  otherDeductions: z.array(deductionLineSchema).max(20).default([]),
  // Optional: a line with no outstanding SalaryAdvance simply ignores this
  // (see payroll.service.js's updatePayrollLine — it's a no-op unless the
  // line already has one). The real ceiling (never above what was
  // suggested at creation) is enforced server-side, not here.
  advanceRepaymentAmount: z.coerce.number().min(0).max(1_000_000).optional(),
});

export const listPayrollRunsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(PAYROLL_STATUSES).optional()),
});

export const payrollRunIdParamSchema = z.object({ id });
export const payrollLineParamSchema = z.object({ id, lineId: id });

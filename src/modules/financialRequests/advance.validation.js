/**
 * Zod schemas for salary advance endpoints.
 */
import { z } from 'zod';
import { ADVANCE_STATUSES } from './advance.model.js';
import { money2dp } from '../../utils/money2dp.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const submitAdvanceSchema = z.object({
  amount: z.coerce.number({ error: 'Amount is required.' }).min(1).max(1_000_000),
  reason: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
  repaymentMonths: z.coerce.number().int().min(1).max(24).default(1),
});

export const decideAdvanceSchema = z.object({
  status: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
  decisionNote: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

// F4's sibling case (a sub-cent repayment would desync the repayments
// ledger from the derived outstanding balance the exact same way a
// sub-cent invoice payment did — see utils/money2dp.js for the full
// reasoning). Scoped to this field only — submitAdvanceSchema's `amount`
// above never flows through the ledger-append pipeline this fixes, so it's
// untouched.

export const addRepaymentSchema = z.object({
  amount: money2dp('Amount cannot have more than 2 decimal places.'),
  date: z.coerce.date({ error: 'Date is required.' }),
  note: z.preprocess(emptyToUndef, z.string().trim().max(200).optional()),
});

export const listAdvancesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(ADVANCE_STATUSES).optional()),
  employee: z.preprocess(emptyToUndef, id.optional()),
});

export const listMyAdvancesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(ADVANCE_STATUSES).optional()),
});

export const advanceIdParamSchema = z.object({ id });

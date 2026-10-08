/**
 * Zod schemas for the EOSB settlement endpoints. Note: EOSB/leave-encashment
 * FIGURES are never accepted from the client — they are computed server-side
 * from the employee's real record — so they are absent here.
 */
import { z } from 'zod';
import { EXIT_REASONS } from './settlement.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const createSettlementSchema = z.object({
  employee: id,
  exitDate: z.coerce.date({ error: 'Exit date is required.' }),
  exitReason: z.enum(EXIT_REASONS, { error: 'Choose why the employee is exiting.' }),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(1000).optional()),
  
  // HR manual overrides for the final calculation. Fixed 2026-10-06, a real
  // QA-audit finding (F02): no upper bound meant a value like 1e308 (finite,
  // so min(0) didn't catch it) overflowed to Infinity once the service's own
  // rounding multiplies it by 100 — and Infinity persisted straight into the
  // database as every downstream money field. Caps match the user's own call:
  // 10,000,000 SAR (10x the app's existing salary cap) covers any real
  // settlement; 1,000 days covers any real accrued-leave balance.
  // A blank box means "not overridden" (fixed 2026-10-08): the web form sends
  // '' for an empty override and z.coerce.number() reads '' as 0, so every
  // settlement computed with the boxes left blank was saved as SAR 0.
  overrideEosbGross: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(10_000_000).optional()),
  overrideLeaveDays: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(1000).optional()),
  overrideLeaveEncashment: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(10_000_000).optional()),
});

export const listSettlementsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  employee: id.optional(),
});

export const settlementIdParamSchema = z.object({ id });

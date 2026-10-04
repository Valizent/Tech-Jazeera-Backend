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
  
  // HR manual overrides for the final calculation
  overrideEosbGross: z.coerce.number().min(0).optional(),
  overrideLeaveDays: z.coerce.number().min(0).optional(),
  overrideLeaveEncashment: z.coerce.number().min(0).optional(),
});

export const listSettlementsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  employee: id.optional(),
});

export const settlementIdParamSchema = z.object({ id });

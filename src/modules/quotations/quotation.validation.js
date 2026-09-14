/**
 * Zod schemas for quotation endpoints. Note: money TOTALS are never accepted
 * from the client — they are computed server-side — so they are absent here
 * and Zod strips them if sent.
 */
import { z } from 'zod';
import { QUOTATION_STATUSES, QUOTATION_LINE_TYPES } from './quotation.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalDate = z.preprocess(emptyToUndef, z.coerce.date().optional());

const lineItemSchema = z.object({
  type: z.enum(QUOTATION_LINE_TYPES),
  description: z.string().trim().min(1, 'Description is required.').max(200),
  quantity: z.coerce.number({ error: 'Quantity must be a number.' }).min(0).max(1_000_000),
  unitPrice: z.coerce.number({ error: 'Unit price must be a number.' }).min(0).max(10_000_000),
  discount: z.coerce.number().min(0).max(100).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(15),
});

export const createQuotationSchema = z.object({
  client: id,
  date: optionalDate,
  validUntil: optionalDate,
  status: z.enum(QUOTATION_STATUSES).default('Draft'),
  lineItems: z.array(lineItemSchema).min(1, 'Add at least one line item.').max(100),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
});

/** PATCH: any subset; if lineItems is present, totals are recomputed.
 *  `status` is explicitly overridden to drop `.default('Draft')` (fixed
 *  2026-09-14, a real QA-audit-found gap — same bug class as
 *  employee.validation.js's own `updateEmployeeSchema`): `.partial()` only
 *  makes a field OPTIONAL, it doesn't strip the field's `.default()`, so
 *  omitting `status` from a PATCH body still resolved it to 'Draft' and
 *  silently reverted an Approved quotation on any unrelated field edit. */
export const updateQuotationSchema = createQuotationSchema.partial().extend({
  status: z.enum(QUOTATION_STATUSES).optional(),
});

export const listQuotationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  client: id.optional(),
  status: z.preprocess(emptyToUndef, z.enum(QUOTATION_STATUSES).optional()),
  search: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const quotationIdParamSchema = z.object({ id });

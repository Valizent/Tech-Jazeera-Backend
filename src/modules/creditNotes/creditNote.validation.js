/**
 * Zod schemas for credit note endpoints. Money totals are never accepted
 * from the client — computed server-side from lineItems, same as
 * Invoice/Quotation.
 */
import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');

const lineItemSchema = z.object({
  type: z.enum(['Labour', 'Trading'], { error: 'Choose a type.' }),
  description: z.string().trim().min(1, 'Description is required.').max(300),
  quantity: z.coerce.number().min(0.01).max(100_000),
  unitPrice: z.coerce.number().min(0).max(10_000_000),
  discount: z.coerce.number().min(0).max(100).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(15),
});

export const createCreditNoteSchema = z.object({
  invoice: id,
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required.').max(50),
});

const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const listCreditNotesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  invoice: id.optional(),
  search: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
});

export const creditNoteIdParamSchema = z.object({ id });

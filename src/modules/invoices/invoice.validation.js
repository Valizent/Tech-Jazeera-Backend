/**
 * Zod schemas for invoice endpoints. Note: money TOTALS are never accepted
 * from the client — they are computed server-side from the source
 * quotation's line items — so they are absent here, same as quotations.
 */
import { z } from 'zod';
import { INVOICE_STATUSES } from './invoice.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// Fixed 2026-09-15, a real QA-audit-found gap — F4: `min(0.01)` alone
// accepted a sub-cent amount like 0.015, which the atomic $round updates
// downstream then round independently for the stored payment vs. the
// running amountPaid/balanceDue totals — two DIFFERENT numbers computed
// from the same unrounded input, permanently desyncing the ledger from the
// cached balance. Rejecting anything finer than a cent here is the honest
// fix — SAR has no sub-halala denomination to round a payment amount TO in
// the first place. `Number(n.toFixed(2)) === n` is exact for this check:
// both sides go through the identical float rounding, so a real 2dp value
// like 1.10 compares equal to itself, while 0.015 does not.
const money2dp = (message) =>
  z.coerce
    .number({ error: 'Amount is required.' })
    .min(0.01)
    .refine((n) => Number(n.toFixed(2)) === n, { message });

export const createInvoiceSchema = z.object({
  quotation: id,
  dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
});

export const recordPaymentSchema = z.object({
  amount: money2dp('Amount cannot have more than 2 decimal places.'),
  date: z.coerce.date({ error: 'Date is required.' }),
  method: z.preprocess(emptyToUndef, z.string().trim().max(50).optional()),
  reference: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
});

export const listInvoicesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  client: id.optional(),
  quotation: id.optional(),
  status: z.preprocess(emptyToUndef, z.enum(INVOICE_STATUSES).optional()),
  search: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
});

export const invoiceIdParamSchema = z.object({ id });

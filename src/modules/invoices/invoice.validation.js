/**
 * Zod schemas for invoice endpoints. Note: money TOTALS are never accepted
 * from the client — they are computed server-side from the source
 * quotation's line items — so they are absent here, same as quotations.
 */
import { z } from 'zod';
import { INVOICE_STATUSES } from './invoice.model.js';
import { money2dp } from '../../utils/money2dp.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// Fixed 2026-09-15, a real QA-audit-found gap — F4 (see utils/money2dp.js
// for the full reasoning): rejects any amount finer than a cent, which
// would otherwise desync the payment ledger from the cached balance.

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
  // NOT z.coerce.boolean() — that coerces the string "false" to true (see
  // employee.validation.js's own warning comment on this exact class of
  // bug). notification.validation.js's own unreadOnly field is the
  // established correct pattern for a query-string boolean.
  overdue: z.preprocess((v) => v === 'true', z.boolean().default(false)),
  search: z.preprocess(emptyToUndef, z.string().trim().max(100).optional()),
});

export const invoiceIdParamSchema = z.object({ id });

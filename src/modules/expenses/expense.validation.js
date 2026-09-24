/**
 * Zod schemas for expense endpoints. `createExpenseSchema` validates the
 * multipart TEXT fields only — the receipt file (optional here, unlike a
 * reimbursement claim's required one) is handled by the upload middleware.
 * Amounts are still never trusted beyond "a positive number" — there is no
 * derived total to protect here, unlike quotations/invoices.
 */
import { z } from 'zod';
import { EXPENSE_CATEGORIES } from './expense.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const baseFields = {
  date: z.coerce.date({ error: 'Date is required.' }),
  category: z.enum(EXPENSE_CATEGORIES, { error: 'Choose a category.' }),
  vendor: z.string().trim().min(1, 'Vendor is required.').max(150),
  amount: z.coerce.number({ error: 'Amount is required.' }).min(0.01).max(10_000_000),
  client: z.preprocess(emptyToUndef, id.optional()),
  deployment: z.preprocess(emptyToUndef, id.optional()),
  notes: z.preprocess(emptyToUndef, z.string().trim().max(1000).optional()),
};

export const createExpenseSchema = z.object(baseFields);

export const updateExpenseSchema = z.object(baseFields).partial();

export const listExpensesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.preprocess(emptyToUndef, z.enum(EXPENSE_CATEGORIES).optional()),
  client: z.preprocess(emptyToUndef, id.optional()),
  // Added 2026-09-24 for the new per-Deployment expenses section — see
  // DeploymentDetailPage.jsx's own doc comment.
  deployment: z.preprocess(emptyToUndef, id.optional()),
  from: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  // A bare "YYYY-MM-DD" date-picks 00:00:00.000 UTC — push to the last
  // millisecond of that day so an inclusive "to" really covers it (same fix
  // as audit.validation.js).
  to: z.preprocess(
    emptyToUndef,
    z.coerce
      .date()
      .transform((d) => new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1))
      .optional()
  ),
  search: z.preprocess(emptyToUndef, z.string().trim().max(150).optional()),
});

export const summaryQuerySchema = z.object({
  from: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  to: z.preprocess(
    emptyToUndef,
    z.coerce
      .date()
      .transform((d) => new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1))
      .optional()
  ),
});

export const expenseIdParamSchema = z.object({ id });

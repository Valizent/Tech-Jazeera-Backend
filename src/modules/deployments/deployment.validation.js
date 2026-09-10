/**
 * Zod schemas for deployment endpoints. Deployments are never created or
 * edited by hand (see deployment.model.js) — everything here is either
 * read filters, a monthly-hours entry/correction, or a Release.
 */
import { z } from 'zod';
import { DEPLOYMENT_STATUSES } from './deployment.model.js';

const DECISIONS = ['Approved', 'Rejected'];

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter a month as YYYY-MM.');

export const listDeploymentsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  worker: id.optional(),
  client: id.optional(),
  status: z.preprocess(emptyToUndef, z.enum(DEPLOYMENT_STATUSES).optional()),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const deploymentIdParamSchema = z.object({ id });

export const monthlyHoursEntryParamSchema = z.object({ id, entryId: id });

/** Add this month's actual client-timesheet hours. `otAmount` is a plain
 *  manually-entered number — see deployment.model.js's doc comment. */
export const addMonthlyHoursSchema = z.object({
  month: monthStr,
  actualHours: z.coerce.number().min(0, 'Actual hours cannot be negative.'),
  otAmount: z.preprocess(emptyToUndef, z.coerce.number().min(0).optional()),
  notes: optionalStr(500),
});

/** Correcting an already-entered month — same shape, month itself is fixed
 *  (it identifies which entry, never changes on an edit). */
export const updateMonthlyHoursSchema = z.object({
  actualHours: z.coerce.number().min(0, 'Actual hours cannot be negative.'),
  otAmount: z.preprocess(emptyToUndef, z.coerce.number().min(0).optional()),
  notes: optionalStr(500),
});

/** Approve/Reject a Pending monthly-hours entry. */
export const decideMonthlyHoursSchema = z.object({
  decision: z.enum(DECISIONS, { error: 'Choose Approved or Rejected.' }),
  note: optionalStr(500),
});

export const releaseDeploymentSchema = z.object({
  releaseDate: z.coerce.date({ error: 'Release date is required.' }),
  releaseNote: optionalStr(1000),
});

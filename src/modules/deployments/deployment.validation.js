/**
 * Zod schemas for deployment endpoints. Deployments are never created or
 * edited by hand (see deployment.model.js) — everything here is either
 * read filters, a monthly-hours entry/correction, or a Release.
 */
import { z } from 'zod';
import { DEPLOYMENT_STATUSES, DEMOBILISATION_REASONS, DAILY_ENTRY_STATUSES } from './deployment.model.js';

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

// One entry per calendar day of the month — the exact array LENGTH (must
// equal that month's real day count) is checked in deployment.service.js,
// which knows the target month for both add (from the body) and update
// (from the existing entry) — one shared check (daysInMonth) instead of
// duplicating the month-aware part here. Each day is either a real worked
// day (`hours` required, 0-24) or an explicit Off/Sick/Absent mark (`hours`
// must be absent — see deployment.model.js's DAILY_ENTRY_STATUSES doc
// comment: these three BLOCK hours entirely, never both).
const dailyEntry = z
  .object({
    status: z.enum(DAILY_ENTRY_STATUSES, { error: 'Invalid day status.' }),
    hours: z.coerce.number().min(0, 'Hours cannot be negative.').max(24, 'A single day cannot exceed 24 hours.').optional(),
  })
  .superRefine((val, ctx) => {
    if (val.status === 'Worked' && val.hours == null) {
      ctx.addIssue({ code: 'custom', path: ['hours'], message: 'Enter hours for a worked day.' });
    }
    if (val.status !== 'Worked' && val.hours != null) {
      ctx.addIssue({ code: 'custom', path: ['hours'], message: 'An Off/Sick/Absent day cannot also have hours.' });
    }
  });
const dailyHours = z.array(dailyEntry).min(1, "Enter each day's status.");

/** Add this month's actual client-timesheet hours, one day at a time —
 *  `actualHours` is never in this payload at all, it's always the
 *  server-computed sum of `dailyHours` (see deployment.model.js's doc
 *  comment). `otAmount` isn't in this payload either, for the same reason —
 *  it's always server-computed from `otHours` × the source Mobilisation's
 *  `otClientRate`, never client-submitted. */
export const addMonthlyHoursSchema = z.object({
  month: monthStr,
  dailyHours,
  notes: optionalStr(500),
});

/** Correcting an already-entered month — same shape, month itself is fixed
 *  (it identifies which entry, never changes on an edit). */
export const updateMonthlyHoursSchema = z.object({
  dailyHours,
  notes: optionalStr(500),
});

/** Approve/Reject a Pending monthly-hours entry. */
export const decideMonthlyHoursSchema = z.object({
  decision: z.enum(DECISIONS, { error: 'Choose Approved or Rejected.' }),
  note: optionalStr(500),
});

/**
 * Demobilise (formerly Release) — `reason` drives what happens to the
 * worker (see deployment.model.js's DEMOBILISATION_OUTCOME). `exitOutcome`
 * is only read when `reason === 'Other'` (every other reason has a fixed
 * outcome) — an explicit yes/no for a genuinely novel reason, rather than
 * guessing. Whether `reason` is valid for this deployment's `workerType`
 * (the 3 Employee-only reasons) can't be checked here — this schema has no
 * access to the deployment record — so that check lives in
 * deployment.service.js's demobiliseDeployment.
 */
export const demobiliseDeploymentSchema = z.object({
  releaseDate: z.coerce.date({ error: 'Demobilisation date is required.' }),
  reason: z.enum(DEMOBILISATION_REASONS, { error: 'Choose a reason.' }),
  exitOutcome: z.coerce.boolean().optional(),
  releaseNote: optionalStr(1000),
});

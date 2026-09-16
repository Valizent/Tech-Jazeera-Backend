/**
 * Zod schemas for deployment endpoints. Deployments are never created or
 * edited by hand (see deployment.model.js) — everything here is either
 * read filters, a monthly-hours entry/correction, or a Release.
 */
import { z } from 'zod';
import { DEPLOYMENT_STATUSES, DEMOBILISATION_REASONS } from './deployment.model.js';

const DECISIONS = ['Approved', 'Rejected'];

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter a month as YYYY-MM.');

// Fixed 2026-09-15, a real QA-audit-found gap — F7: `z.coerce.boolean()`
// coerces via plain JS truthiness of the RAW input, before any type check —
// a nonempty string is always truthy, so the literal string "false" (a
// perfectly reasonable thing to send from a raw HTTP client, even though
// the real checkbox always sends a genuine JSON boolean) coerced to `true`.
// This only ever accepts a real boolean or the exact strings "true"/
// "false"; anything else is left as-is so the inner z.boolean() rejects it
// with a normal validation error instead of silently coercing it.
const strictOptionalBoolean = z.preprocess((v) => {
  if (v === undefined || typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}, z.boolean().optional());

export const listDeploymentsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  worker: id.optional(),
  client: id.optional(),
  status: z.preprocess(emptyToUndef, z.enum(DEPLOYMENT_STATUSES).optional()),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const deploymentIdParamSchema = z.object({ id });

/**
 * Correcting a deployment's own recorded details (2026-09-16, the user's own
 * ask) — gated by the new 'deploymentsEdit' Section Access key, see
 * deployment.routes.js. Deliberately narrow: only the free-typed SNAPSHOT
 * fields Deployment already carries independently of any other system
 * (`site`/`workerName`/`requiredTimesheetHours`/`notes`) — never `client`/
 * `subcontractor` (re-pointing either would strand Employee.currentClient,
 * the active-placement uniqueness guard, and every already-entered month's
 * OT-rate lookup, which all still resolve through the ORIGINAL client/
 * subcontractor), never `worker`/`workerType`/`mobilisation` (identity is
 * decided once, at creation, by which Mobilisation produced this Deployment
 * — reassigning it here would silently rewrite history), and never
 * `startDate`/`endDate`/`status`/`endReason`/`demobilisationOutcome`/
 * `releaseNote` (the dedicated Demobilise action owns the entire lifecycle
 * side of this record; this endpoint only ever touches the descriptive
 * fields sitting beside it). All optional — PATCH semantics, omitting a
 * field leaves it as-is, same convention as every other endpoint in this
 * app.
 */
export const updateDeploymentSchema = z.object({
  site: optionalStr(150),
  workerName: optionalStr(150),
  requiredTimesheetHours: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(1000).optional()),
  notes: optionalStr(1000),
});

export const monthlyHoursEntryParamSchema = z.object({ id, entryId: id });

// Fixed 2026-09-14, a real QA-audit-found gap: `.min(0)` with no upper bound
// accepted 1e308, which then produced non-finite profit/totalProfit once
// subtracted through — capped at the same order of magnitude every other
// money field in this app tops out at (e.g. quotation unitPrice).
const deductionAmount = z.preprocess(emptyToUndef, z.coerce.number().min(0).max(1_000_000).optional());

// Reverted 2026-09-16 (the user's own ask) from the day-by-day grid back to
// two typed totals, transcribed straight off the client's own paper/PDF
// timesheet — the same shape this app originally used on Mobilisation
// before the daily grid existed (see docs/MOBILISATION-notes.md's
// 2026-09-12 follow-up: `otHours = max(0, clientTimesheetHours -
// requiredTimesheetHours)`, unchanged here, just renamed `actualHours` to
// match the field this app already had). `daysWorked` is new — a second
// headline number a real client timesheet always carries alongside total
// hours; purely informational/cross-check, not part of the OT formula.
// Bounded loosely (a month has at most 31 real days) — the tighter, real
// bound (can't exceed the deployment's actual placement days that month)
// needs the deployment/month context this file doesn't have, so it's
// checked in deployment.service.js instead, same reasoning the old
// day-count check already used for exactly this file/service split.
export const addMonthlyHoursSchema = z.object({
  month: monthStr,
  actualHours: z.coerce.number({ error: 'Enter the client timesheet hours.' }).min(0, 'Cannot be negative.').max(1000, 'That looks too high for one month — check the figure.'),
  daysWorked: z.coerce.number({ error: 'Enter the number of days worked.' }).int('Whole days only.').min(0).max(31),
  deductionAmount,
  notes: optionalStr(500),
});

/** Correcting an already-entered month — same shape, month itself is fixed
 *  (it identifies which entry, never changes on an edit). */
export const updateMonthlyHoursSchema = z.object({
  actualHours: z.coerce.number({ error: 'Enter the client timesheet hours.' }).min(0, 'Cannot be negative.').max(1000, 'That looks too high for one month — check the figure.'),
  daysWorked: z.coerce.number({ error: 'Enter the number of days worked.' }).int('Whole days only.').min(0).max(31),
  deductionAmount,
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
  exitOutcome: strictOptionalBoolean,
  releaseNote: optionalStr(1000),
});

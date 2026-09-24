/**
 * Zod schemas for requirement + stage endpoints. Same conventions as the rest
 * of the app — empty strings from HTML forms become undefined (create) or clear
 * the field (update), transforms double as sanitization. Dates are date-only
 * `YYYY-MM-DD` strings turned into a Date at UTC midnight.
 */
import { z } from 'zod';
import { CANDIDATE_WORKER_TYPES } from './requirement.model.js';

const emptyToUndef = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const emptyToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const idParam = (label) => z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`) });

const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine(isRealDate, 'Enter a valid date.')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

/** Today at UTC midnight — matches `dateOnly`'s own UTC-midnight construction,
 *  so "needed by today" compares exactly, never off by a timezone. */
const todayUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** Real bug fix (2026-09-24, a real user report): nothing stopped a requirement
 *  being raised with a `neededBy` already in the past (e.g. added the 24th,
 *  needed by the 4th). Only wired into CREATE — a requirement is always new, so
 *  there is no "unchanged" case to protect. `updateRequirement` (the service)
 *  applies the equivalent rule itself instead of here, since it must allow
 *  resaving an untouched, now-stale `neededBy` on a requirement whose other
 *  fields are being edited (see its own comment) — a check Zod can't make
 *  without the existing record. */
const notPastDate = (date) => date === undefined || date >= todayUtc();

const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const clearableStr = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

const clientName = z.string().trim().min(2, 'Enter the client company name.').max(150);
const jobTitle = z.string().trim().min(2, 'Enter the job title.').max(150);
const headcount = z.coerce.number().int('Headcount must be a whole number.').min(1, 'At least 1 worker.').max(500);
const coordinators = z.array(objectId).min(1, 'Pick at least one coordinator.').max(20);

export const createRequirementSchema = z.object({
  clientName,
  jobTitle,
  headcount: z.preprocess(emptyToUndef, headcount.default(1)),
  neededBy: z.preprocess(emptyToUndef, dateOnly.optional()).refine(notPastDate, "Needed-by date can't be in the past."),
  site: optionalStr(150),
  notes: optionalStr(2000),
  coordinators: coordinators.optional(), // defaults to the caller
});

/** PATCH: any subset. `neededBy`/`site`/`notes` set to '' (or null) are cleared. */
export const updateRequirementSchema = z
  .object({
    clientName: clientName.optional(),
    jobTitle: jobTitle.optional(),
    headcount: z.preprocess(emptyToUndef, headcount.optional()),
    neededBy: z.preprocess(emptyToNull, dateOnly.nullable().optional()),
    site: clearableStr(150),
    notes: clearableStr(2000),
    coordinators: coordinators.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const moveStageSchema = z.object({ stage: objectId });

/** The board's filters — and, unchanged, the Excel export's: it exports what the board shows. */
export const boardQuerySchema = z.object({
  coordinator: z.preprocess(emptyToUndef, objectId.optional()),
  closed: z.preprocess(emptyToUndef, z.enum(['all']).optional()), // 'all' = include long-closed cards
  client: z.preprocess(emptyToUndef, z.string().trim().min(1).max(150).optional()), // the company name a card was typed with
  subcontractor: z.preprocess(emptyToUndef, objectId.optional()),
});

export const requirementIdParamSchema = idParam('requirement');

// ---- stages -------------------------------------------------------------------------

const stageName = z.string().trim().min(1, 'Give the stage a name.').max(60, 'Keep the name under 60 characters.');
const staleAfterDays = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.coerce.number().int('Whole days only.').min(1, 'At least 1 day.').max(365, 'At most 365 days.').nullable()
);

export const createStageSchema = z.object({
  name: stageName,
  staleAfterDays: staleAfterDays.default(null),
  isTerminal: z.boolean().default(false),
  notifyOnEnter: z.boolean().default(false),
  isMobilisedStage: z.boolean().default(false),
});

/** PATCH: any subset — `.partial()` would keep the `.default()`s and silently
 *  reset omitted flags, so each field is redeclared plain-optional. */
export const updateStageSchema = z
  .object({
    name: stageName.optional(),
    staleAfterDays: z.preprocess((v) => (v === '' ? null : v), staleAfterDays.optional()),
    isTerminal: z.boolean().optional(),
    notifyOnEnter: z.boolean().optional(),
    isMobilisedStage: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const reorderStagesSchema = z.object({ ids: z.array(objectId).min(1).max(50) });

export const stageIdParamSchema = idParam('stage');

// ---- candidates ---------------------------------------------------------------------

/** What a person may set by hand. 'Mobilised' is deliberately absent: it's set
 *  only by the system when the linked mobilisation is approved, so it can never
 *  be claimed without an actual approved placement behind it. */
const MANUAL_CANDIDATE_STATUSES = ['Identified', 'DocsInProgress', 'DocsReady', 'Dropped'];

const iqama = z.string().trim().regex(/^\d{10}$/, 'An Iqama number is exactly 10 digits.');
const phone = z.string().trim().regex(/^\+?[0-9][0-9 -]{5,18}$/, 'Enter a valid phone number.');

export const createCandidateSchema = z
  .object({
    workerType: z.enum(CANDIDATE_WORKER_TYPES),
    workerName: z.string().trim().min(2, 'Enter the worker name.').max(150),
    iqamaNumber: z.preprocess(emptyToUndef, iqama.optional()),
    nationality: optionalStr(80),
    phone: z.preprocess(emptyToUndef, phone.optional()),
    subcontractor: z.preprocess(emptyToUndef, objectId.optional()),
    status: z.enum(MANUAL_CANDIDATE_STATUSES).default('Identified'),
    docsNote: optionalStr(300),
  })
  .superRefine((v, ctx) => {
    if (v.workerType === 'SupplierEmployee' && !v.subcontractor) {
      ctx.addIssue({ code: 'custom', path: ['subcontractor'], message: 'Select the subcontractor this worker comes from.' });
    }
    if (v.workerType === 'Freelancer' && v.subcontractor) {
      ctx.addIssue({ code: 'custom', path: ['subcontractor'], message: 'A freelancer has no subcontractor.' });
    }
  });

/** PATCH: any subset. Worker type can't change (remove and re-add instead), so
 *  it isn't accepted here. '' clears an optional field. */
export const updateCandidateSchema = z
  .object({
    workerName: z.string().trim().min(2, 'Enter the worker name.').max(150).optional(),
    iqamaNumber: z.preprocess(emptyToNull, iqama.nullable().optional()),
    nationality: clearableStr(80),
    phone: z.preprocess(emptyToNull, phone.nullable().optional()),
    subcontractor: z.preprocess(emptyToUndef, objectId.optional()),
    status: z.enum(MANUAL_CANDIDATE_STATUSES).optional(),
    docsNote: clearableStr(300),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const candidateParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid requirement id.'),
  candidateId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid candidate id.'),
});

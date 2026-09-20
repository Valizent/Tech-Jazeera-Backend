/**
 * Zod schemas for requirement + stage endpoints. Same conventions as the rest
 * of the app — empty strings from HTML forms become undefined (create) or clear
 * the field (update), transforms double as sanitization. Dates are date-only
 * `YYYY-MM-DD` strings turned into a Date at UTC midnight.
 */
import { z } from 'zod';

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
  neededBy: z.preprocess(emptyToUndef, dateOnly.optional()),
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

export const boardQuerySchema = z.object({
  coordinator: z.preprocess(emptyToUndef, objectId.optional()),
  closed: z.preprocess(emptyToUndef, z.enum(['all']).optional()), // 'all' = include long-closed cards
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
});

/** PATCH: any subset — `.partial()` would keep the `.default()`s and silently
 *  reset omitted flags, so each field is redeclared plain-optional. */
export const updateStageSchema = z
  .object({
    name: stageName.optional(),
    staleAfterDays: z.preprocess((v) => (v === '' ? null : v), staleAfterDays.optional()),
    isTerminal: z.boolean().optional(),
    notifyOnEnter: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const reorderStagesSchema = z.object({ ids: z.array(objectId).min(1).max(50) });

export const stageIdParamSchema = idParam('stage');

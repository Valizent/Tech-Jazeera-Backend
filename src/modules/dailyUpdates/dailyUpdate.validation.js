/**
 * Zod schemas for daily-update endpoints. Same conventions as the rest of the
 * app — empty strings from HTML forms become undefined, transforms double as
 * sanitization. Dates are date-only `YYYY-MM-DD` strings turned into a Date at
 * UTC midnight (the only shape this module stores).
 */
import { z } from 'zod';
import { DAILY_UPDATE_KINDS, TASK_STATUSES } from './dailyUpdate.model.js';

const emptyToUndef = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');

const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine(isRealDate, 'Enter a valid date.')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

const optionalDate = z.preprocess(emptyToUndef, dateOnly.optional());

const text = z.string().trim().min(1, 'Write something first.').max(1000, 'Keep it under 1000 characters.');

export const createDailyUpdateSchema = z
  .object({
    kind: z.enum(DAILY_UPDATE_KINDS),
    text,
    date: optionalDate, // Log only — defaults to today in the service
    dueDate: optionalDate, // Task only
    coordinator: z.preprocess(emptyToUndef, objectId.optional()), // Task only — the assignee; defaults to the caller
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'Log') {
      if (v.dueDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'A log entry has no due date.' });
      if (v.coordinator) ctx.addIssue({ code: 'custom', path: ['coordinator'], message: 'A log entry is always your own.' });
    } else if (v.date) {
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'A task has a due date, not a log date.' });
    }
  });

/** PATCH: any subset. `dueDate: ''` (or null) clears a task's due date. */
export const updateDailyUpdateSchema = z
  .object({
    text: text.optional(),
    date: optionalDate,
    dueDate: z.preprocess((v) => (v === '' ? null : v), dateOnly.nullable().optional()),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const setStatusSchema = z.object({ status: z.enum(TASK_STATUSES) });

export const listDailyUpdatesSchema = z.object({
  kind: z.enum(DAILY_UPDATE_KINDS),
  coordinator: z.preprocess(emptyToUndef, objectId.optional()),
  status: z.preprocess(emptyToUndef, z.enum(TASK_STATUSES).optional()), // Task only
  from: optionalDate, // Log only
  to: optionalDate, // Log only
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const dailyUpdateIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.'),
});

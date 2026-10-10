/**
 * Zod schemas for Annual Vacation requests.
 */
import { z } from 'zod';
import { ANNUAL_VACATION_STATUSES } from './annualVacation.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const vacationFields = {
  startDate: z.coerce.date({ error: 'Choose the first day of the vacation.' }),
  requestedDays: z.coerce
    .number({ error: 'Enter the number of days.' })
    .int('Whole days only.')
    .min(1, 'Must request at least 1 day.')
    .max(90, 'A vacation can be at most 90 days.'),
  reason: z.preprocess(emptyToUndef, z.string().trim().max(1000).optional()),
};

/** An employee's own request (ESS, or a staff login for themself). */
export const submitOwnAnnualVacationSchema = z.object(vacationFields);

/** A staff login filing for an employee; omit `employee` to file for themself. */
export const submitAnnualVacationSchema = z.object({
  employee: z.preprocess(emptyToUndef, id.optional()),
  ...vacationFields,
});

export const decideAnnualVacationSchema = z.object({
  status: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
  decisionNote: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(ANNUAL_VACATION_STATUSES).optional()),
};

export const listAnnualVacationSchema = z.object({ ...paging, employee: z.preprocess(emptyToUndef, id.optional()) });
export const listMyAnnualVacationSchema = z.object(paging);
export const annualVacationIdParamSchema = z.object({ id });

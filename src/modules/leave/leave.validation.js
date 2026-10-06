/**
 * Zod schemas for the Leave module: LeaveType configuration (Admin/Manager)
 * and LeaveRequest submission/review.
 */
import { z } from 'zod';
import { LEAVE_RECURRENCES } from './leaveType.model.js';
import { LEAVE_REQUEST_STATUSES } from './leaveRequest.model.js';

const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const objectId = (label) => z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`);
const optionalDays = z.preprocess(emptyToUndef, z.coerce.number().min(0).max(365).optional());
const optionalYears = (max) => z.preprocess(emptyToUndef, z.coerce.number().min(1).max(max).optional());

/** One 'Sick' pay tier — see leaveType.model.js's sickPayTierSchema. */
const sickPayTierSchema = z.object({
  days: z.coerce.number().int().min(1).max(365),
  payPercent: z.coerce.number().min(0).max(100),
});
const optionalSickPayTiers = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? undefined : v),
  z.array(sickPayTierSchema).max(10).optional()
);

export const createLeaveTypeSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required.').max(60),
    recurrence: z.enum(LEAVE_RECURRENCES, { error: 'Choose how this leave is earned.' }),
    daysPerYear: optionalDays,
    tierYears: optionalYears(50),
    tierDaysPerYear: optionalDays,
    cycleYears: optionalYears(20),
    daysPerCycle: optionalDays,
    sickPayTiers: optionalSickPayTiers,
    minServiceMonths: z.coerce.number().min(0).max(600).default(0),
    maxDaysPerRequest: z.preprocess(emptyToUndef, z.coerce.number().min(1).max(365).optional()),
    isPaid: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.recurrence === 'Annual' && data.daysPerYear === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysPerYear'],
        message: 'Days per year is required for an Annual leave type.',
      });
    }
    if (data.recurrence === 'ContractCycle' && (data.cycleYears === undefined || data.daysPerCycle === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cycleYears'],
        message: 'Cycle length and days per cycle are required for a Contract-cycle leave type.',
      });
    }
    if (data.recurrence === 'Sick' && (!data.sickPayTiers || data.sickPayTiers.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sickPayTiers'],
        message: 'At least one pay tier is required for a Sick leave type.',
      });
    }
    if ((data.tierYears !== undefined) !== (data.tierDaysPerYear !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tierYears'],
        message: 'Tier years and tier days must be set together.',
      });
    }
  });

/** PATCH: any subset, same field rules, no cross-field re-check (partial edits are common). */
export const updateLeaveTypeSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  recurrence: z.enum(LEAVE_RECURRENCES).optional(),
  daysPerYear: optionalDays,
  tierYears: optionalYears(50),
  tierDaysPerYear: optionalDays,
  cycleYears: optionalYears(20),
  daysPerCycle: optionalDays,
  sickPayTiers: optionalSickPayTiers,
  minServiceMonths: z.coerce.number().min(0).max(600).optional(),
  maxDaysPerRequest: z.preprocess(emptyToUndef, z.coerce.number().min(1).max(365).optional()),
  isPaid: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const listLeaveTypesSchema = z.object({
  activeOnly: z.preprocess(emptyToUndef, z.enum(['true', 'false']).optional()),
});

export const leaveTypeIdParamSchema = z.object({ id: objectId('leave type') });

// Fixed 2026-10-06, a real QA-audit finding (F06): leave is counted in whole
// CALENDAR days (daysInclusive in leave.service.js), but this accepted any
// timestamp, not just a date. A same-day request with a real time-of-day gap
// (e.g. 06:00 to 20:30) rounds the elapsed ~0.6 fractional days up to a whole
// day before the +1 inclusive count, so one calendar day came out as two.
// The web client always sends a plain 'YYYY-MM-DD' (z.coerce.date() parses
// that as UTC midnight already, so this is a no-op for it); this only
// changes behavior for a caller — an API/mobile client — that sends a full
// timestamp, collapsing it to its UTC calendar date before anything compares
// it to another date.
const dateOnly = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const submitLeaveRequestSchema = z.object({
  leaveType: objectId('leave type'),
  startDate: z.coerce.date({ error: 'Start date is required.' }).transform(dateOnly),
  endDate: z.coerce.date({ error: 'End date is required.' }).transform(dateOnly),
  reason: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const decideLeaveRequestSchema = z.object({
  status: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
  decisionNote: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const listLeaveRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(LEAVE_REQUEST_STATUSES).optional()),
  employee: z.preprocess(emptyToUndef, objectId('employee').optional()),
});

export const listMyLeaveRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(LEAVE_REQUEST_STATUSES).optional()),
});

export const leaveRequestIdParamSchema = z.object({ id: objectId('leave request') });

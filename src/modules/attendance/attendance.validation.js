/**
 * Zod schemas for attendance endpoints. Dates are validated as `YYYY-MM-DD`
 * strings; the service converts them to UTC-midnight Dates.
 */
import { z } from 'zod';
import { ATTENDANCE_STATUSES } from './attendance.model.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
// The shape regex alone accepted a calendar-impossible date (e.g.
// "2026-02-31") which Date's own UTC constructor then silently rolls over
// to a real day ("2026-03-03") rather than rejecting — fixed 2026-09-14, a
// real QA-audit-found gap. The refine re-derives y/m/d from the constructed
// UTC date and requires them to match the input verbatim, which a rollover
// never does.
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  }, 'That date does not exist.');
const optionalNote = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().max(300).optional()
);

/** Mark many workers for a single day (the daily-marking action). */
export const markBulkSchema = z.object({
  date: dateOnly,
  records: z
    .array(
      z.object({
        employee: id,
        status: z.enum(ATTENDANCE_STATUSES),
        note: optionalNote,
      })
    )
    .min(1, 'Nothing to save — mark at least one worker.')
    .max(500),
});

/** A date range is required so we never scan the whole collection. */
const rangeShape = {
  from: dateOnly,
  to: dateOnly,
  employee: id.optional(),
};

export const listAttendanceSchema = z.object(rangeShape);
export const summarySchema = z.object(rangeShape);
export const exportSchema = z.object({
  format: z.enum(['xlsx', 'pdf']),
  from: dateOnly,
  to: dateOnly,
});

/** P2-M3: the office geofence Admin configures. */
export const officeLocationSchema = z.object({
  name: optionalNote,
  lat: z.coerce.number({ error: 'Latitude is required.' }).min(-90).max(90),
  lng: z.coerce.number({ error: 'Longitude is required.' }).min(-180).max(180),
  radiusMeters: z.coerce.number().int().min(10).max(5000).default(150),
  allowedIps: z.array(z.string().trim().min(3).max(45)).max(10).default([]),
});

/** P2-M3: a Worker's self-punch (Sign in/Sign out buttons — see selfPunch()).
 *  lat/lng are optional so an office-IP-only check still works if the
 *  browser denied location access. */
export const selfMarkSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().min(0).optional(),
});

/** A Worker's own attendance history — range is optional (service defaults it). */
export const listMyAttendanceSchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

/**
 * Admin/Manager/HR manually correcting ONE worker's day — e.g. they forgot
 * to sign in/out, or the recorded hours are wrong. Distinct from
 * markBulkSchema: that's fast status-only marking for many workers at once;
 * this is a precise single-record fix that can also set the actual
 * check-in/check-out times. `null` (not omitted) means "clear this time" —
 * the client always sends both keys.
 */
export const adjustAttendanceSchema = z
  .object({
    employee: id,
    date: dateOnly,
    status: z.enum(ATTENDANCE_STATUSES),
    checkInTime: z.coerce.date().nullable().optional(),
    checkOutTime: z.coerce.date().nullable().optional(),
    note: optionalNote,
  })
  // The service already rejects checkOut <= checkIn; it never capped the
  // gap between them at all (fixed 2026-09-14, a real QA-audit-found gap —
  // a 25-hour "shift" was accepted and stored as hoursWorked: 25). 24 hours
  // matches every other daily-hours cap already enforced elsewhere in the
  // app (Deployment's own daily entry, Employee.expectedDailyHours).
  .refine(
    (data) =>
      !data.checkInTime || !data.checkOutTime || data.checkOutTime.getTime() - data.checkInTime.getTime() <= 24 * 60 * 60 * 1000,
    { message: 'A single day cannot be more than 24 hours.', path: ['checkOutTime'] }
  );

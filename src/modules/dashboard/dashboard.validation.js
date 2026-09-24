import { z } from 'zod';

const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** thresholdDays (P2-M2): override the 30-day expiry-alert window.
 *  month (P2-M8): "YYYY-MM" — the period the real-profit section shows;
 *  defaults to the current calendar month when omitted. */
export const dashboardQuerySchema = z.object({
  thresholdDays: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(365).optional()),
  month: z.preprocess(emptyToUndef, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.').optional()),
});

/** ?month= only — the Coordinator Leaderboard's own query shape (2026-09-22).
 *  Same "YYYY-MM", optional-defaults-to-current-month" schema as dashboardQuerySchema's
 *  own `month`, split out so this route doesn't also accept/ignore a stray thresholdDays. */
export const monthQuerySchema = z.object({
  month: z.preprocess(emptyToUndef, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.').optional()),
});

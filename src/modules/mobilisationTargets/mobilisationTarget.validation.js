import { z } from 'zod';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.')
  .refine((m) => {
    const [y, mo] = m.split('-').map(Number);
    return mo >= 1 && mo <= 12 && y >= 2020;
  }, 'Invalid month.');

export const setTargetSchema = z.object({
  coordinatorId: id,
  month: monthSchema,
  target: z.number().int().min(1, 'Target must be at least 1.').max(500),
  incentivePercent: z.number().min(0).max(100).optional(),
});

export const getProgressSchema = z.object({
  month: monthSchema,
});

export const getMyTargetSchema = z.object({
  month: monthSchema.optional(),
});

export const targetIdParamSchema = z.object({ id });

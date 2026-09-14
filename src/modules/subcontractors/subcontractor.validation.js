/**
 * Zod schemas for subcontractor endpoints. Same conventions as
 * clients/client.validation.js — empty strings from HTML forms become
 * undefined, transforms double as sanitization.
 */
import { z } from 'zod';
import { SUBCONTRACTOR_STATUSES } from './subcontractor.model.js';

const emptyToUndef = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const optionalPhone = z.preprocess(
  emptyToUndef,
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 -]{5,18}$/, 'Enter a valid phone number.')
    .optional()
);

export const createSubcontractorSchema = z.object({
  name: z.string().trim().min(2, 'Subcontractor name is required.').max(150),
  contactPerson: optionalStr(100),
  phone: optionalPhone,
  email: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toLowerCase()) : v),
    z.email('Enter a valid email address.').optional()
  ),
  status: z.enum(SUBCONTRACTOR_STATUSES).default('Active'),
  notes: optionalStr(2000),
});

/** PATCH: any subset of the same fields, same rules. `status` is explicitly
 *  overridden to drop `.default('Active')` (fixed 2026-09-14, a real
 *  QA-audit-found gap — same bug class as employee.validation.js's own
 *  `updateEmployeeSchema`): `.partial()` only makes a field OPTIONAL, it
 *  doesn't strip the field's `.default()`, so omitting `status` from a PATCH
 *  body still resolved it to 'Active'. */
export const updateSubcontractorSchema = createSubcontractorSchema.partial().extend({
  status: z.enum(SUBCONTRACTOR_STATUSES).optional(),
});

export const listSubcontractorsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalStr(100),
  status: z.preprocess(emptyToUndef, z.enum(SUBCONTRACTOR_STATUSES).optional()),
  sortBy: z.enum(['name', 'createdAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const subcontractorIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid subcontractor id.'),
});

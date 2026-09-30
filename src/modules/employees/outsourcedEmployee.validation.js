/**
 * Outsourced Employee validation — added 2026-09-30 (a real, previously-
 * flagged gap: these routes had zero server-side validation at all, relying
 * only on Mongoose's own schema-level checks). Iqama/phone rules mirror
 * mobilisation.validation.js exactly, since this record uses the same
 * durable Iqama-based identity for a Freelancer/SupplierEmployee worker.
 */
import { z } from 'zod';

// Handles both an empty-string sentinel (mobilisation.validation.js's own
// convention) AND an explicit `null` (this form's own payload builder sends
// null for a cleared phone/email/iqamaNumber/subcontractor) — either way,
// "nothing here" should reach Zod as `undefined` so `.optional()` accepts it.
const emptyToUndef = (value) =>
  value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value;
const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());

const id = (label) => z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`);

const iqamaRegex = /^\d{10}$/;
const optionalIqama = z.preprocess(
  emptyToUndef,
  z.string().trim().regex(iqamaRegex, 'Iqama number must be exactly 10 digits.').optional()
);

const saudiPhoneRegex = /^(?:\+?9665\d{8}|05\d{8})$/;
const phoneToUndef = (value) => {
  const cleaned = emptyToUndef(value);
  return cleaned === '+966' ? undefined : cleaned;
};
const optionalSaudiPhone = z.preprocess(
  phoneToUndef,
  z.string().trim().regex(saudiPhoneRegex, 'Enter a valid Saudi mobile number (e.g. 05XXXXXXXX or +9665XXXXXXXX).').optional()
);

const baseFields = {
  name: z.string().trim().min(1, 'Name is required.').max(100),
  workerType: z.enum(['Freelancer', 'SupplierEmployee']),
  subcontractor: z.preprocess(emptyToUndef, id('subcontractor').optional()),
  iqamaNumber: optionalIqama,
  nationality: optionalStr(80),
  phone: optionalSaudiPhone,
  email: z.preprocess(emptyToUndef, z.string().trim().email('Invalid email.').max(100).optional()),
  agreedRate: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.number().min(0, 'Rate must be positive.').optional()
  ),
  notes: optionalStr(1000),
};

export const createOutsourcedEmployeeSchema = z
  .object(baseFields)
  .superRefine((val, ctx) => {
    if (val.workerType === 'SupplierEmployee' && !val.subcontractor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Subcontractor is required.', path: ['subcontractor'] });
    }
  });

export const updateOutsourcedEmployeeSchema = z
  .object(baseFields)
  .partial()
  .superRefine((val, ctx) => {
    if (val.workerType === 'SupplierEmployee' && !val.subcontractor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Subcontractor is required.', path: ['subcontractor'] });
    }
  });

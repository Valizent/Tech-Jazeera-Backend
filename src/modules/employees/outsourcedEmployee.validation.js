/**
 * Outsourced Employee validation — added 2026-09-30 (a real, previously-
 * flagged gap: these routes had zero server-side validation at all, relying
 * only on Mongoose's own schema-level checks). Iqama/phone rules mirror
 * mobilisation.validation.js exactly, since this record uses the same
 * durable Iqama-based identity for a Freelancer/SupplierEmployee worker.
 */
import { z } from 'zod';

import { OUTSOURCED_DOCUMENT_TYPES } from './outsourcedEmployee.model.js';
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

// ---- documents (added 2026-09-30, see outsourcedEmployee.model.js's own doc
// comment on the redesigned sub-schema) ----

export const outsourcedEmployeeIdParamSchema = z.object({ id: id('outsourced employee') });

// Fixed 2026-10-06, a real QA-audit finding (S01): this list had no query
// validation at all, so `?limit=1000000` returned every record in one
// response. Capped the same way listEmployeesSchema caps the real Employees
// list.
export const listOutsourcedEmployeesSchema = z.object({
  search: optionalStr(100),
  workerType: z.preprocess(emptyToUndef, z.enum(['Freelancer', 'SupplierEmployee']).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const documentFields = {
  type: z.enum(OUTSOURCED_DOCUMENT_TYPES, { error: 'Choose the kind of document.' }),
  // Only "Other" needs a name typed; the others are named by their type.
  title: z.preprocess(emptyToUndef, z.string().trim().min(2, 'Give the document a name.').max(150).optional()),
  number: z.preprocess(emptyToUndef, z.string().trim().max(80).optional()),
  expiryDate: z.preprocess(emptyToUndef, z.coerce.date({ error: 'Enter a valid expiry date.' }).optional()),
  reminderDays: z.preprocess(emptyToUndef, z.coerce.number().int().min(1, 'At least 1 day.').max(365, 'At most 365 days.').optional()),
};

const needsName = (val, ctx) => {
  if (val.type === 'Other' && !val.title) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give the document a name.', path: ['title'] });
  }
};

export const outsourcedEmployeeDocumentBodySchema = z.object(documentFields).superRefine(needsName);

/** Editing: any of the details (the file travels as multipart, optional). */
export const outsourcedEmployeeDocumentUpdateSchema = z
  .object({ ...documentFields, type: documentFields.type.optional(), clearExpiry: z.preprocess((v) => v === 'true' || v === true, z.boolean().optional()) })
  .superRefine((val, ctx) => {
    if (val.type === 'Other' && val.title === undefined) return; // keeps the name it already has
    needsName(val, ctx);
  });

export const outsourcedEmployeeDocumentParamSchema = z.object({
  id: id('outsourced employee'),
  fileId: id('document'),
});

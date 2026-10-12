/**
 * Zod pieces for the company profile fields (see companyProfile.model.js),
 * spread into the client and subcontractor create schemas. Every field is
 * optional: a company may be saved incomplete and flagged afterwards.
 */
import { z } from 'zod';

const emptyToUndef = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const optionalPhone = z.preprocess(
  emptyToUndef,
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 -]{5,18}$/, 'Enter a valid phone number.')
    .optional()
);
const optionalEmail = z.preprocess(
  (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toLowerCase()) : v),
  z.email('Enter a valid email address.').optional()
);
const digits = (count, label) =>
  z.preprocess(emptyToUndef, z.string().trim().regex(new RegExp(`^\\d{${count}}$`), `${label} is ${count} digits.`).optional());

const person = z.object({
  name: optionalStr(100),
  position: optionalStr(100),
  phone: optionalPhone,
  email: optionalEmail,
});

const nationalAddress = z.object({
  buildingNumber: digits(4, 'Building number'),
  streetName: optionalStr(120),
  district: optionalStr(120),
  city: optionalStr(80),
  postalCode: digits(5, 'Postal code'),
  additionalNumber: digits(4, 'Additional number'),
  unitNumber: z.preprocess(emptyToUndef, z.string().trim().regex(/^\d{1,4}$/, 'Unit number is up to 4 digits.').optional()),
  shortAddress: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toUpperCase()) : v),
    z.string().regex(/^[A-Z]{4}\d{4}$/, 'Short address is 4 letters then 4 digits (e.g. RRRD2929).').optional()
  ),
});

const companyCoordinator = z.object({
  _id: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  name: z.string().trim().min(1, 'Coordinator name is required.').max(100),
  designation: optionalStr(100),
  phone: optionalPhone,
  email: optionalEmail,
});

/** One new coordinator for a company, outside the company's own form (the mobilisation form's inline add). */
export const newCompanyCoordinatorSchema = companyCoordinator.omit({ _id: true });

/** Spread into createClientSchema / createSubcontractorSchema. */
export const companyProfileShape = {
  arabicName: optionalStr(150),
  // null clears a stored expiry; blank form input arrives as '' -> null.
  crExpiry: z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable().optional()),
  contactPosition: optionalStr(100),
  financePerson: person.optional(),
  owner: person.optional(),
  nationalAddress: nationalAddress.optional(),
  coordinators: z.array(companyCoordinator).max(30).optional(),
};

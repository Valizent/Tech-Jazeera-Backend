/**
 * Zod schemas for company settings. Every field is optional (a company can
 * fill these in gradually, field by field) and nullable via "" → null, same
 * "clear it" convention as coordinator/manager/weeklyOffDay elsewhere.
 */
import { z } from 'zod';

const emptyToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalStr = (max) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

// Fixed 2026-09-29, a real audit finding: bankIban had no format/checksum
// check on either layer, even though it's printed verbatim on every
// outstanding invoice's Payment Instructions section — a typo'd IBAN saved
// and printed silently, a real misdirected-payment risk. Mirrors the
// client's own companySettings.schema.js — real ISO 13616 structural +
// MOD-97 (ISO 7064) checksum, works for any country's IBAN.
function isValidIban(value) {
  const cleaned = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => (ch.charCodeAt(0) - 55).toString());
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
const optionalIban = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(50)
    .refine(isValidIban, 'Enter a valid IBAN.')
    .nullable()
    .optional()
);

export const updateCompanySettingsSchema = z.object({
  companyName: optionalStr(150),
  companyNameAr: optionalStr(150),
  crNumber: optionalStr(50),
  vatNumber: optionalStr(50),
  address: optionalStr(300),
  phone: optionalStr(30),
  email: z.preprocess(
    emptyToNull,
    z.email('Enter a valid email address.').nullable().optional()
  ),
  website: optionalStr(150),
  bankName: optionalStr(100),
  bankIban: optionalIban,
  signatoryName: optionalStr(100),
  signatoryTitle: optionalStr(100),
});

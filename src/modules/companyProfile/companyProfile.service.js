/**
 * Company profile completeness (2026-10-12): which of the details a client or
 * subcontractor is expected to carry are still missing.
 *
 * A record may be saved without any of them, so this is computed on read
 * (never stored): it can never go stale after a document is uploaded or a
 * field is filled. The Letterhead is optional by decision and never counts as
 * missing. The result is a list of stable keys; the web and phone apps turn
 * them into words.
 */
import Document from '../documents/document.model.js';

/** Documents a company must have on file. `needsExpiry`: the date is required too. */
export const REQUIRED_COMPANY_DOCUMENTS = [
  { key: 'agreementDocument', category: 'Agreement', needsExpiry: true },
  { key: 'crDocument', category: 'Commercial Registration', needsExpiry: true },
  { key: 'nationalAddressDocument', category: 'National Address', needsExpiry: false },
];

const filled = (value) => typeof value === 'string' && value.trim() !== '';

function personComplete(person) {
  return Boolean(person) && ['name', 'position', 'phone', 'email'].every((field) => filled(person[field]));
}

const ADDRESS_REQUIRED = ['buildingNumber', 'streetName', 'district', 'city', 'postalCode', 'additionalNumber'];

/**
 * `documents`: this company's Document rows ({ category, expiryDate }).
 * Returns the missing keys in the order the UI lists them.
 */
export function missingDetails(company, documents = []) {
  const missing = [];
  if (!filled(company.arabicName)) missing.push('arabicName');
  if (!filled(company.crNumber)) missing.push('crNumber');
  if (!company.crExpiry) missing.push('crExpiry');
  if (!ADDRESS_REQUIRED.every((field) => filled(company.nationalAddress?.[field]))) missing.push('nationalAddress');
  const contact = {
    name: company.contactPerson,
    position: company.contactPosition,
    phone: company.phone,
    email: company.email,
  };
  if (!personComplete(contact)) missing.push('contact');
  if (!personComplete(company.financePerson)) missing.push('finance');
  if (!personComplete(company.owner)) missing.push('owner');
  if (!company.coordinators?.length) missing.push('coordinators');
  for (const { key, category, needsExpiry } of REQUIRED_COMPANY_DOCUMENTS) {
    const ok = documents.some((d) => d.category === category && (!needsExpiry || d.expiryDate));
    if (!ok) missing.push(key);
  }
  return missing;
}

/**
 * Attach `missingDetails` to one company or a list of them (lean objects),
 * with one Document query for the whole batch. `ownerType` is 'Client' or
 * 'Subcontractor' (the Document.ownerType value).
 */
export async function withMissingDetails(ownerType, companies) {
  const list = Array.isArray(companies) ? companies : [companies];
  if (list.length === 0) return companies;
  const documents = await Document.find({
    ownerType,
    owner: { $in: list.map((c) => c._id) },
    category: { $in: REQUIRED_COMPANY_DOCUMENTS.map((d) => d.category) },
  })
    .select('owner category expiryDate')
    .lean();
  const byOwner = new Map();
  for (const doc of documents) {
    const key = String(doc.owner);
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(doc);
  }
  const attach = (company) => ({ ...company, missingDetails: missingDetails(company, byOwner.get(String(company._id)) ?? []) });
  return Array.isArray(companies) ? list.map(attach) : attach(companies);
}

/**
 * Company settings service — a found-or-created singleton (see the model's
 * doc comment). `getCompanySettings` never throws "not found": a company
 * with no logo/details configured yet is the normal starting state, not an
 * error.
 */
import CompanySettings from './companySettings.model.js';
import { deleteLogoMedia } from './logo.upload.js';
import { logAudit } from '../audit/audit.service.js';
import logger from '../../config/logger.js';

const EMPTY = {
  logoUrl: null,
  companyName: null,
  companyNameAr: null,
  crNumber: null,
  vatNumber: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  bankName: null,
  bankIban: null,
  signatoryName: null,
  signatoryTitle: null,
};

export async function getCompanySettings() {
  const settings = await CompanySettings.findOne().lean();
  return settings ?? EMPTY;
}

/**
 * Just the two fields the app shell needs to brand itself (sidebar/login
 * logo + name) — deliberately excludes everything else on the document
 * (CR/VAT numbers, bank IBAN, signatory), and deliberately has no access
 * check at the controller/route level (see companySettings.routes.js):
 * this has to reach the pre-login screen and the ESS Worker portal, neither
 * of which can pass the 'companySettings' Section Access check the full
 * record requires. A logo/name isn't sensitive the way those other fields
 * are (same reasoning as `logoUrl` itself, see the model's doc comment).
 */
export async function getCompanyBranding() {
  const settings = await CompanySettings.findOne().select('companyName logoUrl').lean();
  return { companyName: settings?.companyName ?? null, logoUrl: settings?.logoUrl ?? null };
}

// Edit access (who besides Admin may view/change this) is governed by
// Section Access's 'companySettings' key now — see
// sectionAccess.service.js's canAccessSection, called directly from
// companySettings.controller.js. Kept out of this service so this module
// doesn't need to know about ApprovalRole membership at all anymore.

export async function updateCompanySettings(data, actor) {
  const settings = await CompanySettings.findOneAndUpdate({}, data, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  await logAudit({
    user: actor.userId,
    action: 'companySettings.update',
    targetType: 'CompanySettings',
    targetId: settings._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return settings;
}

/**
 * Fetch the configured logo's actual bytes, ready to embed via exceljs
 * (which needs a buffer, not a URL) — shared by every Excel export that
 * brands itself with the company logo (Timesheet Processor, the real-
 * attendance monthly report). Uploaded as PNG unconditionally (see
 * logo.upload.js), so the extension is always known. Returns null — never
 * throws — if no logo is configured, or if the fetch fails: a transient
 * Cloudinary hiccup should degrade to "no logo" on export, not block
 * someone from getting a payroll-critical report out.
 */
export async function getLogoForEmbedding() {
  const settings = await getCompanySettings();
  if (!settings.logoUrl) return null;
  try {
    const upstream = await fetch(settings.logoUrl);
    if (!upstream.ok) throw new Error(`status ${upstream.status}`);
    return { buffer: Buffer.from(await upstream.arrayBuffer()), extension: 'png' };
  } catch (err) {
    logger.warn(`[companySettings] failed to fetch logo for embedding: ${err.message}`);
    return null;
  }
}

/**
 * One call for every PDF generator (invoice/quotation/EOSB settlement/
 * certificate/payslip) to get everything it needs for a letterhead.
 * `company` comes back null — not a half-filled-in object — until the
 * company has set at least a name or a logo, so a document generated
 * before anyone has touched this settings page renders exactly as it did
 * before this feature existed, rather than a letterhead with a "Company
 * name not set" placeholder on a real business document.
 */
export async function getLetterheadData() {
  const settings = await getCompanySettings();
  const hasIdentity = Boolean(settings.companyName || settings.logoUrl);
  if (!hasIdentity) return { company: null, logo: null };
  const logo = await getLogoForEmbedding();
  return { company: settings, logo };
}

export async function setLogo(logoUrl, actor) {
  const previous = await CompanySettings.findOne().lean();
  const settings = await CompanySettings.findOneAndUpdate(
    {},
    { logoUrl },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  if (previous?.logoUrl) await deleteLogoMedia(previous.logoUrl);

  await logAudit({
    user: actor.userId,
    action: 'companySettings.logo.set',
    targetType: 'CompanySettings',
    targetId: settings._id,
    ip: actor.ip,
  });
  return settings;
}

export async function removeLogo(actor) {
  const previous = await CompanySettings.findOne().lean();
  const settings = await CompanySettings.findOneAndUpdate(
    {},
    { logoUrl: null },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  if (previous?.logoUrl) await deleteLogoMedia(previous.logoUrl);

  await logAudit({
    user: actor.userId,
    action: 'companySettings.logo.remove',
    targetType: 'CompanySettings',
    targetId: settings._id,
    ip: actor.ip,
  });
  return settings;
}

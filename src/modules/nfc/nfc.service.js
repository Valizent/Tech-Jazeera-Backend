/**
 * NFC platform service — all business logic for companies, people, card
 * inventory, batches, assignment lifecycle, and the public lookup. Controllers
 * only translate HTTP; nothing here touches req/res.
 */
import NfcCompany from './nfcCompany.model.js';
import NfcEmployee from './nfcEmployee.model.js';
import NfcCard, { NFC_CARD_STATUSES } from './nfcCard.model.js';
import NfcBatch from './nfcBatch.model.js';
import NfcAssignment from './nfcAssignment.model.js';
import ApiError from '../../utils/ApiError.js';
import env from '../../config/env.js';
import { logAudit } from '../audit/audit.service.js';
import { generateToken, generateTokens } from './nfc.token.js';
import { deleteNfcMedia } from './nfc.upload.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

/** The public URL a chip is written with. */
export function cardUrl(token) {
  return `${env.publicBaseUrl}/c/${token}`;
}

/** Public URL for a stored logo/photo file, or null. */
export function mediaUrl(filename) {
  if (!filename) return null;
  if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
  return `${env.publicBaseUrl}/nfc-media/${filename}`;
}

/** Attach the public URL to a plain card object. */
function withUrl(card) {
  return { ...card, url: cardUrl(card.token) };
}

// ---------------------------------------------------------------- Companies

export async function listCompanies({ search }) {
  const filter = {};
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ companyName: rx }, { contactPerson: rx }, { phone: rx }, { city: rx }];
  }
  const companies = await NfcCompany.find(filter).sort({ companyName: 1 }).lean();
  const counts = await NfcEmployee.aggregate([{ $group: { _id: '$company', count: { $sum: 1 } } }]);
  const countBy = new Map(counts.map((c) => [c._id.toString(), c.count]));
  return companies.map((c) => ({
    ...c,
    employeeCount: countBy.get(c._id.toString()) ?? 0,
    logoUrl: mediaUrl(c.logo),
  }));
}

/** One company + its people, each with their currently-active card (if any). */
export async function getCompany(id) {
  const company = await NfcCompany.findById(id).lean();
  if (!company) throw new ApiError(404, 'Company not found.');
  const employees = await NfcEmployee.find({ company: id }).sort({ name: 1 }).lean();
  const activeCards = await NfcCard.find({ company: id, status: 'active' })
    .select('token status employee')
    .lean();
  const cardByEmployee = new Map(activeCards.map((c) => [c.employee?.toString(), c]));
  const withCards = employees.map((e) => {
    const card = cardByEmployee.get(e._id.toString());
    return {
      ...e,
      photoUrl: mediaUrl(e.photo),
      card: card ? { _id: card._id, token: card.token, url: cardUrl(card.token) } : null,
    };
  });
  return { ...company, logoUrl: mediaUrl(company.logo), employees: withCards };
}

export async function createCompany(data, actor) {
  const company = await NfcCompany.create(data);
  await logAudit({ user: actor.userId, action: 'nfc.company.create', targetType: 'NfcCompany', targetId: company._id, meta: { companyName: company.companyName }, ip: actor.ip });
  return company.toObject();
}

export async function updateCompany(id, data, actor) {
  const company = await NfcCompany.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
  if (!company) throw new ApiError(404, 'Company not found.');
  await logAudit({ user: actor.userId, action: 'nfc.company.update', targetType: 'NfcCompany', targetId: id, meta: { companyName: company.companyName, fields: Object.keys(data) }, ip: actor.ip });
  return company;
}

/** Delete a company: its people go too; their cards return to inventory. */
export async function deleteCompany(id, actor) {
  const company = await NfcCompany.findByIdAndDelete(id).lean();
  if (!company) throw new ApiError(404, 'Company not found.');
  await NfcAssignment.updateMany({ company: id, unassignedAt: null }, { unassignedAt: new Date() });
  const freed = await NfcCard.updateMany(
    { company: id },
    { $set: { employee: null, company: null, status: 'unassigned', assignedAt: null } }
  );
  deleteNfcMedia(company.logo);
  const people = await NfcEmployee.find({ company: id }).select('photo').lean();
  people.forEach((p) => deleteNfcMedia(p.photo));
  const removed = await NfcEmployee.deleteMany({ company: id });
  await logAudit({ user: actor.userId, action: 'nfc.company.delete', targetType: 'NfcCompany', targetId: id, meta: { companyName: company.companyName, removedEmployees: removed.deletedCount, freedCards: freed.modifiedCount }, ip: actor.ip });
}

// ---------------------------------------------------------------- Employees

export async function createEmployee(data, actor) {
  const company = await NfcCompany.findById(data.company).select('companyName').lean();
  if (!company) throw new ApiError(404, 'Company not found.');
  const employee = await NfcEmployee.create(data);
  await logAudit({ user: actor.userId, action: 'nfc.employee.create', targetType: 'NfcEmployee', targetId: employee._id, meta: { name: employee.name, company: company.companyName }, ip: actor.ip });
  return employee.toObject();
}

export async function updateEmployee(id, data, actor) {
  const employee = await NfcEmployee.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  await logAudit({ user: actor.userId, action: 'nfc.employee.update', targetType: 'NfcEmployee', targetId: id, meta: { name: employee.name, fields: Object.keys(data) }, ip: actor.ip });
  return employee;
}

/** Delete a person: any card they hold returns to inventory (not deleted). */
export async function deleteEmployee(id, actor) {
  const employee = await NfcEmployee.findByIdAndDelete(id).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  deleteNfcMedia(employee.photo);
  await NfcAssignment.updateMany({ employee: id, unassignedAt: null }, { unassignedAt: new Date() });
  await NfcCard.updateMany(
    { employee: id },
    { $set: { employee: null, company: null, status: 'unassigned', assignedAt: null } }
  );
  await logAudit({ user: actor.userId, action: 'nfc.employee.delete', targetType: 'NfcEmployee', targetId: id, meta: { name: employee.name }, ip: actor.ip });
}

// ---------------------------------------------------------------- Batches

export async function generateBatch({ count, label, note, company }, actor) {
  const batch = await NfcBatch.create({ label, note, count, createdBy: actor.userId });
  const tokens = generateTokens(count);
  // Guard the (astronomically unlikely) clash with an existing token.
  const clashes = await NfcCard.find({ token: { $in: tokens } }).select('token').lean();
  if (clashes.length) {
    const taken = new Set(clashes.map((c) => c.token));
    for (let i = 0; i < tokens.length; i++) {
      while (taken.has(tokens[i])) tokens[i] = generateToken();
      taken.add(tokens[i]);
    }
  }
  const docs = tokens.map((token) => ({ token, batch: batch._id, company: company || null, status: 'unassigned' }));
  await NfcCard.insertMany(docs);
  await logAudit({ user: actor.userId, action: 'nfc.batch.generate', targetType: 'NfcBatch', targetId: batch._id, meta: { count, label: label || '', company: company || null }, ip: actor.ip });
  return { batch: batch.toObject(), cards: docs.map((d) => withUrl(d)) };
}

export async function listBatches() {
  const batches = await NfcBatch.find().sort({ createdAt: -1 }).lean();
  return batches;
}

/** A batch's cards (for the CSV export and detail view). */
export async function getBatchCards(id) {
  const batch = await NfcBatch.findById(id).lean();
  if (!batch) throw new ApiError(404, 'Batch not found.');
  const cards = await NfcCard.find({ batch: id })
    .sort({ createdAt: 1 })
    .populate('employee', 'name')
    .lean();
  return { batch, cards: cards.map(withUrl) };
}

// ---------------------------------------------------------------- Cards

export async function listCards({ search, status, company, batch }) {
  const filter = {};
  if (status) filter.status = status;
  if (company) filter.company = company;
  if (batch) filter.batch = batch;
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    const people = await NfcEmployee.find({ name: rx }).select('_id').lean();
    filter.$or = [{ token: rx }, { chipUid: rx }, { employee: { $in: people.map((p) => p._id) } }];
  }
  const cards = await NfcCard.find(filter)
    .sort({ createdAt: -1 })
    .populate('employee', 'name')
    .populate('company', 'companyName')
    .populate('batch', 'label')
    .lean();
  return cards.map(withUrl);
}

export async function getCard(id) {
  const card = await NfcCard.findById(id)
    .populate('employee', 'name jobTitle phone email company')
    .populate('company', 'companyName brandColour')
    .populate('batch', 'label')
    .lean();
  if (!card) throw new ApiError(404, 'Card not found.');
  const history = await NfcAssignment.find({ card: id })
    .sort({ assignedAt: -1 })
    .populate('employee', 'name')
    .populate('company', 'companyName')
    .lean();
  return { ...withUrl(card), history };
}

export async function updateCard(id, data, actor) {
  const card = await NfcCard.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
  if (!card) throw new ApiError(404, 'Card not found.');
  await logAudit({ user: actor.userId, action: 'nfc.card.update', targetType: 'NfcCard', targetId: id, meta: { fields: Object.keys(data) }, ip: actor.ip });
  return withUrl(card);
}

export async function assignCard(id, { employee: employeeId }, actor) {
  const card = await NfcCard.findById(id);
  if (!card) throw new ApiError(404, 'Card not found.');
  if (card.status === 'lost') {
    throw new ApiError(400, 'This card is marked lost. Rotate its token before reusing it.');
  }
  const employee = await NfcEmployee.findById(employeeId).select('name company').lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  // Enforce company ownership: a card assigned to a company can only be given to an employee of that company.
  if (card.company && card.company.toString() !== employee.company.toString()) {
    throw new ApiError(400, 'This card belongs to a different company.');
  }

  // Close any current holder, then assign the new one (reassign is one step).
  await NfcAssignment.updateMany({ card: id, unassignedAt: null }, { unassignedAt: new Date() });
  card.employee = employee._id;
  card.company = employee.company;
  card.status = 'active';
  card.assignedAt = new Date();
  await card.save();
  await NfcAssignment.create({ card: id, employee: employee._id, company: employee.company, assignedBy: actor.userId });
  await logAudit({ user: actor.userId, action: 'nfc.card.assign', targetType: 'NfcCard', targetId: id, meta: { token: card.token, employee: employee.name }, ip: actor.ip });
  return getCard(id);
}

export async function assignCardToCompany(id, { company }, actor) {
  const card = await NfcCard.findById(id);
  if (!card) throw new ApiError(404, 'Card not found.');
  if (card.status !== 'unassigned') throw new ApiError(400, 'Only unassigned cards can be assigned to a company inventory.');
  
  card.company = company;
  await card.save();
  await logAudit({ user: actor.userId, action: 'nfc.card.assignCompany', targetType: 'NfcCard', targetId: id, meta: { token: card.token }, ip: actor.ip });
  return getCard(id);
}

/** Shared closer for unassign / lost / returned / disabled. */
async function releaseCard(id, { status, keepHolder }, action, actor) {
  const card = await NfcCard.findById(id);
  if (!card) throw new ApiError(404, 'Card not found.');
  await NfcAssignment.updateMany({ card: id, unassignedAt: null }, { unassignedAt: new Date() });
  card.status = status;
  card.assignedAt = null;
  if (!keepHolder) {
    card.employee = null;
    card.company = null;
  }
  await card.save();
  await logAudit({ user: actor.userId, action, targetType: 'NfcCard', targetId: id, meta: { token: card.token, status }, ip: actor.ip });
  return getCard(id);
}

export const unassignCard = (id, actor) => releaseCard(id, { status: 'unassigned', keepHolder: false }, 'nfc.card.unassign', actor);
export const markReturned = (id, actor) => releaseCard(id, { status: 'returned', keepHolder: false }, 'nfc.card.return', actor);
// Lost / disabled keep the last holder on the card for reference; the public
// page still 404s because it resolves only 'active' cards.
export const markLost = (id, actor) => releaseCard(id, { status: 'lost', keepHolder: true }, 'nfc.card.lost', actor);
export const disableCard = (id, actor) => releaseCard(id, { status: 'disabled', keepHolder: true }, 'nfc.card.disable', actor);

/** New token → new URL; the old URL dies immediately. Chip must be rewritten. */
export async function rotateToken(id, actor) {
  const card = await NfcCard.findById(id);
  if (!card) throw new ApiError(404, 'Card not found.');
  let token = generateToken();
  while (await NfcCard.exists({ token })) token = generateToken();
  card.token = token;
  await card.save();
  await logAudit({ user: actor.userId, action: 'nfc.card.rotate', targetType: 'NfcCard', targetId: id, meta: { token }, ip: actor.ip });
  return getCard(id);
}

// ---------------------------------------------------------------- Public

export async function deleteCard(id, actor) {
  const card = await NfcCard.findByIdAndDelete(id).lean();
  if (!card) throw new ApiError(404, 'Card not found.');
  await NfcAssignment.deleteMany({ card: id });
  await logAudit({ user: actor.userId, action: 'nfc.card.delete', targetType: 'NfcCard', targetId: id, meta: { token: card.token }, ip: actor.ip });
}

/**
 * Resolve a token for the public tap page. Returns whitelisted, already-public
 * fields only, or null for anything that must 404 identically (unknown, not
 * active, or not linked to a person).
 *
 * `ref` is the one exception to the whitelist: internal ids the analytics
 * recorder needs to attribute a tap. It is SERVER-ONLY — the page renderer
 * destructures the fields it needs by name and never sees it, and no route
 * serialises this object to the client.
 */
export async function getPublicCardByToken(token) {
  const card = await NfcCard.findOne({ token, status: 'active', employee: { $ne: null } })
    .populate('employee')
    .populate('company')
    .lean();
  if (!card || !card.employee) return null;

  const e = card.employee;
  const c = card.company || {};
  return {
    ref: { card: card._id, employee: e._id, company: c._id ?? null },
    employee: {
      name: e.name,
      nameAr: e.nameAr ?? '',
      jobTitle: e.jobTitle ?? '',
      jobTitleAr: e.jobTitleAr ?? '',
      phone: e.phone ?? '',
      whatsapp: e.whatsapp ?? '',
      email: e.email ?? '',
      altEmail: e.altEmail ?? '',
      linkedin: e.linkedin ?? '',
      bio: e.bio ?? '',
      bioAr: e.bioAr ?? '',
    },
    company: {
      companyName: c.companyName ?? '',
      companyNameAr: c.companyNameAr ?? '',
      website: c.website ?? '',
      address: c.address ?? '',
      mapLink: c.mapLink ?? '',
      brandColour: c.brandColour ?? '#4F46E5',
    },
    logoUrl: mediaUrl(c.logo),
    photoUrl: mediaUrl(e.photo),
  };
}

// ----------------------------------------------------------------- Images

export async function setCompanyLogo(id, filename, actor) {
  const company = await NfcCompany.findById(id);
  if (!company) {
    deleteNfcMedia(filename); // orphaned upload for a missing company
    throw new ApiError(404, 'Company not found.');
  }
  const old = company.logo;
  company.logo = filename;
  await company.save();
  deleteNfcMedia(old);
  await logAudit({ user: actor.userId, action: 'nfc.company.logo', targetType: 'NfcCompany', targetId: id, ip: actor.ip });
  return { logoUrl: mediaUrl(filename) };
}

export async function removeCompanyLogo(id, actor) {
  const company = await NfcCompany.findById(id);
  if (!company) throw new ApiError(404, 'Company not found.');
  deleteNfcMedia(company.logo);
  company.logo = null;
  await company.save();
  await logAudit({ user: actor.userId, action: 'nfc.company.logo.remove', targetType: 'NfcCompany', targetId: id, ip: actor.ip });
  return { logoUrl: null };
}

export async function setEmployeePhoto(id, filename, actor) {
  const employee = await NfcEmployee.findById(id);
  if (!employee) {
    deleteNfcMedia(filename);
    throw new ApiError(404, 'Person not found.');
  }
  const old = employee.photo;
  employee.photo = filename;
  await employee.save();
  deleteNfcMedia(old);
  await logAudit({ user: actor.userId, action: 'nfc.employee.photo', targetType: 'NfcEmployee', targetId: id, ip: actor.ip });
  return { photoUrl: mediaUrl(filename), company: employee.company };
}

export async function removeEmployeePhoto(id, actor) {
  const employee = await NfcEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Person not found.');
  deleteNfcMedia(employee.photo);
  employee.photo = null;
  await employee.save();
  await logAudit({ user: actor.userId, action: 'nfc.employee.photo.remove', targetType: 'NfcEmployee', targetId: id, ip: actor.ip });
  return { photoUrl: null, company: employee.company };
}

export { NFC_CARD_STATUSES };

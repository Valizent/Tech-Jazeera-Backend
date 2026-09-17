/**
 * Quotation service — CRUD, duplicate, and the authoritative money math.
 *
 * SECURITY / CORRECTNESS: totals are ALWAYS computed here from the line items,
 * never taken from the request. A client can send whatever it likes; the
 * stored subtotal/discount/tax/grand total are what the server calculates.
 */
import Quotation from './quotation.model.js';
import Client from '../clients/client.model.js';
import { nextSequence } from './counter.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { computeTotals } from '../../utils/moneyMath.js';

/** Fetch a client and its name, or 404. */
async function resolveClient(clientId) {
  const client = await Client.findById(clientId).lean();
  if (!client) throw new ApiError(404, 'Client not found.');
  return client;
}

async function newQuotationNumber() {
  const seq = await nextSequence('quotation');
  return `QT-${String(seq).padStart(4, '0')}`;
}

export async function createQuotation(data, actor) {
  const client = await resolveClient(data.client);
  const quotation = await Quotation.create({
    ...data,
    quotationNumber: await newQuotationNumber(),
    clientName: client.companyName,
    createdBy: actor.userId,
    ...computeTotals(data.lineItems),
  });
  await logAudit({
    user: actor.userId,
    action: 'quotation.create',
    targetType: 'Quotation',
    targetId: quotation._id,
    meta: { number: quotation.quotationNumber, client: client.companyName, grandTotal: quotation.grandTotal },
    ip: actor.ip,
  });
  return quotation.toObject();
}

export async function updateQuotation(id, data, actor) {
  const quotation = await Quotation.findById(id);
  if (!quotation) throw new ApiError(404, 'Quotation not found.');

  // Re-snapshot the client name if the client changed.
  if (data.client && data.client !== quotation.client.toString()) {
    quotation.client = data.client;
    quotation.clientName = (await resolveClient(data.client)).companyName;
  }
  for (const key of ['date', 'validUntil', 'status', 'notes', 'lineItems']) {
    if (data[key] !== undefined) quotation[key] = data[key];
  }
  // Recompute from whatever line items the document now holds.
  Object.assign(quotation, computeTotals(quotation.lineItems));
  await quotation.save();

  await logAudit({
    user: actor.userId,
    action: 'quotation.update',
    targetType: 'Quotation',
    targetId: quotation._id,
    meta: { number: quotation.quotationNumber, fields: Object.keys(data) },
    ip: actor.ip,
  });
  return quotation.toObject();
}

/** Duplicate a quotation into a fresh Draft with a new number. */
export async function duplicateQuotation(id, actor) {
  const source = await Quotation.findById(id).lean();
  if (!source) throw new ApiError(404, 'Quotation not found.');

  const copy = await Quotation.create({
    quotationNumber: await newQuotationNumber(),
    client: source.client,
    clientName: source.clientName,
    date: new Date(),
    validUntil: null,
    status: 'Draft',
    lineItems: source.lineItems,
    notes: source.notes,
    subtotal: source.subtotal,
    discountTotal: source.discountTotal,
    taxTotal: source.taxTotal,
    grandTotal: source.grandTotal,
  });
  await logAudit({
    user: actor.userId,
    action: 'quotation.duplicate',
    targetType: 'Quotation',
    targetId: copy._id,
    meta: { from: source.quotationNumber, to: copy.quotationNumber },
    ip: actor.ip,
  });
  return copy.toObject();
}

export async function listQuotations({ page, limit, client, status, search, sortOrder }) {
  const conditions = [];
  if (client) conditions.push({ client });
  if (status) conditions.push({ status });
  if (search) {
    const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    conditions.push({ $or: [{ quotationNumber: rx }, { clientName: rx }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [items, total] = await Promise.all([
    Quotation.find(filter)
      .sort({ createdAt: sortOrder === 'asc' ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Quotation.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getQuotation(id) {
  const quotation = await Quotation.findById(id).populate('client', 'companyName vatNumber crNumber address').lean();
  if (!quotation) throw new ApiError(404, 'Quotation not found.');
  return quotation;
}

export async function deleteQuotation(id, actor) {
  const quotation = await Quotation.findByIdAndDelete(id).lean();
  if (!quotation) throw new ApiError(404, 'Quotation not found.');
  await logAudit({
    user: actor.userId,
    action: 'quotation.delete',
    targetType: 'Quotation',
    targetId: quotation._id,
    meta: { number: quotation.quotationNumber },
    ip: actor.ip,
  });
}

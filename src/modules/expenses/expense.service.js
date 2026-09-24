/**
 * Expense service — CRUD plus a monthly-totals summary for the dashboard.
 * The receipt (if any) is fixed at creation, same discipline as a
 * reimbursement claim's — update() never touches it.
 */
import Expense from './expense.model.js';
import Client from '../clients/client.model.js';
import Deployment from '../deployments/deployment.model.js';
import ApiError from '../../utils/ApiError.js';
import { signedDownloadUrl, destroyDocumentFile } from '../../middleware/upload.js';
import { logAudit } from '../audit/audit.service.js';

function receiptFromFile(file) {
  return {
    fileName: file.filename, // Cloudinary public_id, set by uploadSingle
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

/** Resolves client/deployment refs on CREATE, returning the client doc (for
 *  the clientName snapshot) when one was given. */
async function resolveLinks({ client, deployment }) {
  let clientDoc = null;
  if (client) {
    clientDoc = await Client.findById(client).lean();
    if (!clientDoc) throw new ApiError(404, 'Client not found.');
  }
  if (deployment) {
    const deploymentDoc = await Deployment.findById(deployment).lean();
    if (!deploymentDoc) throw new ApiError(404, 'Deployment not found.');
    if (client && deploymentDoc.client.toString() !== client) {
      throw new ApiError(400, 'That deployment does not belong to the selected client.');
    }
  }
  return clientDoc;
}

export async function createExpense(data, file, actor) {
  const clientDoc = await resolveLinks(data);

  const expense = await Expense.create({
    ...data,
    clientName: clientDoc?.companyName ?? null,
    receipt: file ? receiptFromFile(file) : null,
    recordedBy: actor.userId,
  });

  await logAudit({
    user: actor.userId,
    action: 'expense.create',
    targetType: 'Expense',
    targetId: expense._id,
    meta: { category: expense.category, vendor: expense.vendor, amount: expense.amount },
    ip: actor.ip,
  });
  return expense.toObject();
}

export async function listExpenses({ page, limit, category, client, deployment, from, to, search }) {
  const conditions = [];
  if (category) conditions.push({ category });
  if (client) conditions.push({ client });
  // Added 2026-09-24 for the new per-Deployment expenses section on
  // DeploymentDetailPage.jsx — browsing one deployment's own expense history.
  if (deployment) conditions.push({ deployment });
  if (from || to) {
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    conditions.push({ date: range });
  }
  if (search) {
    const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    conditions.push({ $or: [{ vendor: rx }, { notes: rx }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [items, total] = await Promise.all([
    Expense.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('recordedBy', 'name')
      .lean(),
    Expense.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getExpense(id) {
  const expense = await Expense.findById(id).populate('recordedBy', 'name').lean();
  if (!expense) throw new ApiError(404, 'Expense not found.');
  return expense;
}

export async function updateExpense(id, data, actor) {
  const expense = await Expense.findById(id);
  if (!expense) throw new ApiError(404, 'Expense not found.');

  // Each link is resolved independently and only if the caller actually sent
  // it — an update that only changes, say, the amount shouldn't require
  // re-sending client. Sending an empty value clears that link.
  if ('client' in data) {
    if (data.client) {
      const clientDoc = await Client.findById(data.client).lean();
      if (!clientDoc) throw new ApiError(404, 'Client not found.');
      expense.client = data.client;
      expense.clientName = clientDoc.companyName;
    } else {
      expense.client = null;
      expense.clientName = null;
    }
  }
  if ('deployment' in data) {
    if (data.deployment) {
      const deploymentDoc = await Deployment.findById(data.deployment).lean();
      if (!deploymentDoc) throw new ApiError(404, 'Deployment not found.');
      const targetClient = 'client' in data ? data.client : expense.client?.toString();
      if (targetClient && deploymentDoc.client.toString() !== targetClient) {
        throw new ApiError(400, 'That deployment does not belong to the selected client.');
      }
      expense.deployment = data.deployment;
    } else {
      expense.deployment = null;
    }
  }

  for (const field of ['date', 'category', 'vendor', 'amount', 'notes']) {
    if (field in data) expense[field] = data[field];
  }
  await expense.save();

  await logAudit({
    user: actor.userId,
    action: 'expense.update',
    targetType: 'Expense',
    targetId: expense._id,
    ip: actor.ip,
  });
  return expense.toObject();
}

export async function deleteExpense(id, actor) {
  const expense = await Expense.findById(id).lean();
  if (!expense) throw new ApiError(404, 'Expense not found.');
  if (expense.sourceReimbursement) {
    throw new ApiError(400, 'This expense was auto-created from a paid reimbursement claim and cannot be deleted here.');
  }

  if (expense.receipt) {
    await destroyDocumentFile(expense.receipt.fileName, expense.receipt.resourceType).catch(() => {});
  }
  await Expense.deleteOne({ _id: id });

  await logAudit({
    user: actor.userId,
    action: 'expense.delete',
    targetType: 'Expense',
    targetId: expense._id,
    meta: { category: expense.category, vendor: expense.vendor, amount: expense.amount },
    ip: actor.ip,
  });
}

export async function getReceiptFile(id) {
  const expense = await Expense.findById(id).lean();
  if (!expense) throw new ApiError(404, 'Expense not found.');
  if (!expense.receipt) throw new ApiError(404, 'This expense has no receipt attached.');
  return {
    url: signedDownloadUrl(expense.receipt.fileName, expense.receipt.resourceType),
    mimeType: expense.receipt.mimeType,
    originalName: expense.receipt.originalName,
  };
}

/** Defaults to the current calendar month when no range is given. */
export async function getSummary({ from, to }) {
  let start = from;
  let end = to;
  if (!start || !end) {
    const now = new Date();
    start = start ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = end ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  }

  const byCategory = await Expense.aggregate([
    { $match: { date: { $gte: start, $lte: end } } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
  ]);

  const total = byCategory.reduce((sum, c) => sum + c.total, 0);
  return {
    from: start,
    to: end,
    total,
    byCategory: byCategory.map((c) => ({ category: c._id, total: c.total })),
  };
}

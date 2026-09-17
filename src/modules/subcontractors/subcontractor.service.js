/**
 * Subcontractor service — all business logic. Controllers only translate HTTP.
 */
import Subcontractor from './subcontractor.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

export async function listSubcontractors({ page, limit, search, status, sortBy, sortOrder }) {
  const conditions = [];
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({ $or: [{ name: rx }, { contactPerson: rx }, { email: rx }, { phone: rx }] });
  }
  if (status) conditions.push({ status });
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  // Secondary _id sort keeps pagination stable when the primary key ties.
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };

  const [items, total] = await Promise.all([
    Subcontractor.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Subcontractor.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getSubcontractor(id) {
  const subcontractor = await Subcontractor.findById(id).lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');
  return subcontractor;
}

export async function createSubcontractor(data, actor) {
  const subcontractor = await Subcontractor.create(data);
  await logAudit({
    user: actor.userId,
    action: 'subcontractor.create',
    targetType: 'Subcontractor',
    targetId: subcontractor._id,
    meta: { name: subcontractor.name },
    ip: actor.ip,
  });
  return subcontractor.toObject();
}

export async function updateSubcontractor(id, data, actor) {
  const subcontractor = await Subcontractor.findById(id);
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');
  Object.assign(subcontractor, data);
  await subcontractor.save({ validateModifiedOnly: true });
  await logAudit({
    user: actor.userId,
    action: 'subcontractor.update',
    targetType: 'Subcontractor',
    targetId: subcontractor._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return subcontractor.toObject();
}

/** Referential integrity: refuse to orphan mobilisations still pointing here. */
export async function deleteSubcontractor(id, actor) {
  const referenced = await Mobilisation.countDocuments({ subcontractor: id });
  if (referenced > 0) {
    throw new ApiError(
      409,
      `This subcontractor is used on ${referenced} mobilisation(s). Remove it from them first.`
    );
  }

  const subcontractor = await Subcontractor.findByIdAndDelete(id).lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');
  await logAudit({
    user: actor.userId,
    action: 'subcontractor.delete',
    targetType: 'Subcontractor',
    targetId: subcontractor._id,
    meta: { name: subcontractor.name },
    ip: actor.ip,
  });
}

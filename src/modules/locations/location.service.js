/**
 * Location service — plain CRUD. No referential-integrity check on delete:
 * Mobilisation/Requirement snapshot the chosen site as a string at pick-time
 * (see the model's doc comment), so removing an entry here never orphans
 * anything.
 *
 * Unlike JobTitle, create is open to ANY staff member (2026-09-24, the
 * user's own explicit choice) — a site name was completely free-text for
 * everyone before this list existed, so requiring a stricter circle just to
 * add one inline would be a new restriction, not a parity fix. Delete is
 * the one operation the user asked to lock to Admin (see location.routes.js).
 */
import Location from './location.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

export async function listLocations() {
  return Location.find({}).sort({ name: 1 }).lean();
}

export async function createLocation(data, actor) {
  const existing = await Location.findOne({ name: new RegExp(`^${escapeRegex(data.name)}$`, 'i') }).lean();
  if (existing) throw new ApiError(409, 'This location already exists.');

  const location = await Location.create(data);
  await logAudit({
    user: actor.userId,
    action: 'location.create',
    targetType: 'Location',
    targetId: location._id,
    meta: { name: location.name },
    ip: actor.ip,
  });
  return location.toObject();
}

export async function deleteLocation(id, actor) {
  const location = await Location.findByIdAndDelete(id).lean();
  if (!location) throw new ApiError(404, 'Location not found.');
  await logAudit({
    user: actor.userId,
    action: 'location.delete',
    targetType: 'Location',
    targetId: location._id,
    meta: { name: location.name },
    ip: actor.ip,
  });
}

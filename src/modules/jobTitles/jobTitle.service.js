/**
 * JobTitle service — plain CRUD. No referential-integrity check on delete:
 * Mobilisation snapshots the chosen title as a string at pick-time (see the
 * model's doc comment), so removing an entry here never orphans anything.
 */
import JobTitle from './jobTitle.model.js';
import { isApprovalRoleMember } from '../approvals/approvals.service.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Admin and Manager always may manage the list; beyond that, any member of
 * any configured ApprovalRole (e.g. BDM, COO, GM) — the same low-friction
 * "any approval role member" rule the Approval Log uses. A picklist of
 * labels is low-stakes enough not to need its own admin-configurable circle
 * the way Company Settings' legal/bank fields do.
 */
export async function canManageJobTitles(actor) {
  if (actor.role === 'Admin' || actor.role === 'Manager') return true;
  return isApprovalRoleMember(actor.userId);
}

export async function listJobTitles({ activeOnly } = {}) {
  const filter = activeOnly === 'true' ? { isActive: true } : {};
  return JobTitle.find(filter).sort({ name: 1 }).lean();
}

export async function createJobTitle(data, actor) {
  // escapeRegex (2026-09-14, a real QA-audit-found gap): the name was
  // spliced into `new RegExp()` unescaped — a value with regex
  // metacharacters (e.g. "QA [") threw a 500, and a value like ".*" matched
  // every existing title as a false duplicate.
  const existing = await JobTitle.findOne({ name: new RegExp(`^${escapeRegex(data.name)}$`, 'i') }).lean();
  if (existing) throw new ApiError(409, 'This job title already exists.');

  const jobTitle = await JobTitle.create(data);
  await logAudit({
    user: actor.userId,
    action: 'jobTitle.create',
    targetType: 'JobTitle',
    targetId: jobTitle._id,
    meta: { name: jobTitle.name },
    ip: actor.ip,
  });
  return jobTitle.toObject();
}

export async function updateJobTitle(id, data, actor) {
  const jobTitle = await JobTitle.findById(id);
  if (!jobTitle) throw new ApiError(404, 'Job title not found.');
  Object.assign(jobTitle, data);
  await jobTitle.save({ validateModifiedOnly: true });
  await logAudit({
    user: actor.userId,
    action: 'jobTitle.update',
    targetType: 'JobTitle',
    targetId: jobTitle._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return jobTitle.toObject();
}

export async function deleteJobTitle(id, actor) {
  const jobTitle = await JobTitle.findByIdAndDelete(id).lean();
  if (!jobTitle) throw new ApiError(404, 'Job title not found.');
  await logAudit({
    user: actor.userId,
    action: 'jobTitle.delete',
    targetType: 'JobTitle',
    targetId: jobTitle._id,
    meta: { name: jobTitle.name },
    ip: actor.ip,
  });
}

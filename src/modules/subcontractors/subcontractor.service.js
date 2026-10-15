/**
 * Subcontractor service — all business logic. Controllers only translate HTTP.
 */
import Subcontractor from './subcontractor.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { withMissingDetails } from '../companyProfile/companyProfile.service.js';
import { startApproval } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { populateTrail } from '../approvals/approvalFields.js';
import { notifyUser } from '../notifications/notification.service.js';

// Admin and Manager add subcontractors straight in; anyone else's addition waits for approval.
const AUTO_APPROVE_ROLES = ['Admin', 'Manager'];
// With no hierarchy set up for SubcontractorApproval, the original rule stands: an Admin or Manager decides.
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager'];

/** Pending-subcontractor buttons: whoever sits at the current step, or (no hierarchy) an Admin or Manager. */
async function withCanDecide(items, actor) {
  if (!actor) return items;
  return annotateCanDecide(items, actor, { pendingStatus: 'Pending', statusField: 'approvalStatus', legacyAllowedRoles: LEGACY_DECIDE_ROLES });
}

const buildStepNotification = (doc) => ({
  type: 'RequestStatus',
  title: `Subcontractor waiting for your approval: ${doc.name}`,
  url: `/subcontractors/${doc._id}`,
});

/** 'Approved' also matches subcontractors stored before the field existed. */
const approvedFilter = { $or: [{ approvalStatus: 'Approved' }, { approvalStatus: { $exists: false } }] };

export async function listSubcontractors({ page, limit, search, status, approvalStatus, sortBy, sortOrder }, actor = null) {
  const conditions = [];
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({ $or: [{ name: rx }, { contactPerson: rx }, { email: rx }, { phone: rx }] });
  }
  if (status) conditions.push({ status });
  if (approvalStatus) conditions.push(approvalStatus === 'Approved' ? approvedFilter : { approvalStatus });
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  // Secondary _id sort keeps pagination stable when the primary key ties.
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };

  const [items, total] = await Promise.all([
    Subcontractor.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate(populateTrail()).lean(),
    Subcontractor.countDocuments(filter),
  ]);
  const annotated = await withCanDecide(await withMissingDetails('Subcontractor', items), actor);
  return { items: annotated, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getSubcontractor(id, actor = null) {
  const subcontractor = await Subcontractor.findById(id).populate('decidedBy', 'name').populate(populateTrail()).lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');
  const [annotated] = await withCanDecide([await withMissingDetails('Subcontractor', subcontractor)], actor);
  return annotated;
}

export async function createSubcontractor(data, actor) {
  // Incomplete by definition (no documents yet): the missing-details clock starts now.
  const payload = { ...data, createdBy: actor.userId, missingDetailsSince: new Date() };
  if (!AUTO_APPROVE_ROLES.includes(actor.role)) {
    payload.approvalStatus = 'Pending';
    Object.assign(payload, await startApproval('SubcontractorApproval'));
  }
  const subcontractor = await Subcontractor.create(payload);
  if (subcontractor.approvalStatus === 'Pending' && subcontractor.workflow) {
    await notifySubmission(subcontractor.toObject(), buildStepNotification, LEGACY_DECIDE_ROLES);
  }
  await logAudit({
    user: actor.userId,
    action: 'subcontractor.create',
    targetType: 'Subcontractor',
    targetId: subcontractor._id,
    meta: { name: subcontractor.name, approvalStatus: subcontractor.approvalStatus },
    ip: actor.ip,
  });
  return subcontractor.toObject();
}

export async function updateSubcontractor(id, data, actor) {
  const subcontractor = await Subcontractor.findById(id);
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');

  // Anyone but an Admin or Manager may only edit what they submitted themselves, and only until it is approved;
  // an edit sends it back for review (Pending again, the earlier decision cleared).
  if (!AUTO_APPROVE_ROLES.includes(actor.role)) {
    if (subcontractor.createdBy?.toString() !== actor.userId) {
      throw new ApiError(403, 'You can only edit subcontractors you added yourself.');
    }
    if (subcontractor.approvalStatus === 'Approved') {
      throw new ApiError(403, 'This subcontractor is already approved: ask an Admin or Manager to make further changes.');
    }
    const wasRejected = subcontractor.approvalStatus === 'Rejected';
    data.approvalStatus = 'Pending';
    data.decidedBy = null;
    data.decidedAt = null;
    data.decisionNote = '';
    Object.assign(data, await startApproval('SubcontractorApproval'));
    Object.assign(subcontractor, data);
    await subcontractor.save({ validateModifiedOnly: true });
    if (subcontractor.workflow) await notifySubmission(subcontractor.toObject(), buildStepNotification, LEGACY_DECIDE_ROLES);
    await logAudit({
      user: actor.userId,
      action: wasRejected ? 'subcontractor.resubmit' : 'subcontractor.update',
      targetType: 'Subcontractor',
      targetId: subcontractor._id,
      meta: { fields: Object.keys(data) },
      ip: actor.ip,
    });
    return subcontractor.toObject();
  }

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

/**
 * Approve or reject a Pending subcontractor through the shared approval engine. With a hierarchy set up for
 * Subcontractor Approval the request walks its steps and only a member of the current step's roles (or an Admin)
 * may decide; with none, an Admin or Manager decides. Rejecting needs a note (decideSubcontractorSchema).
 */
export async function decideSubcontractor(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: Subcontractor,
    id,
    decision: status,
    note: decisionNote ?? '',
    actor,
    pendingStatus: 'Pending',
    statusField: 'approvalStatus',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    notFoundMessage: 'Subcontractor not found.',
    auditAction: 'subcontractor',
    buildFinalNotification: (subcontractor) => ({
      type: 'RequestStatus',
      title: `${subcontractor.name} subcontractor submission ${subcontractor.approvalStatus.toLowerCase()}`,
      body: subcontractor.decisionNote || undefined,
      url: `/subcontractors/${subcontractor._id}`,
    }),
    buildStepNotification,
    // The submitter is a User, not an Employee to resolve through.
    notifyFinal: (subcontractor, notification) => (subcontractor.createdBy ? notifyUser(subcontractor.createdBy, notification) : undefined),
  });
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

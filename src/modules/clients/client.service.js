/**
 * Client service — all client business logic. Controllers only translate HTTP.
 */
import Client from './client.model.js';
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { withMissingDetails } from '../companyProfile/companyProfile.service.js';
import { startApproval } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { populateTrail } from '../approvals/approvalFields.js';

const LEGACY_DECIDE_ROLES = ['Admin', 'Manager'];

/** Pending-client buttons: whoever sits at the current step, or (no hierarchy set up) the Admin or the
 *  coordinator's own manager - the original rule. */
async function withCanDecide(items, actor) {
  if (!actor) return items;
  return annotateCanDecide(items, actor, {
    pendingStatus: 'Pending',
    statusField: 'approvalStatus',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    isInLegacyScope: (item) => actor.role === 'Admin' || String(item.createdBy?.employee?.manager ?? '') === actor.userId,
  });
}

const buildStepNotification = (doc) => ({
  type: 'RequestStatus',
  title: `Client submission waiting for your approval: ${doc.companyName}`,
  url: `/clients/${doc._id}`,
});

/**
 * Paginated, searchable, sortable listing.
 * search         → case-insensitive match on company / contact / email / phone
 * status         → exact match (Active/Inactive — operational)
 * approvalStatus → exact match (Approved/Pending/Rejected — see client.model.js)
 * createdByRole  → 'Coordinator' narrows to clients a Coordinator submitted
 * industry       → case-insensitive partial match
 */
export async function listClients({ page, limit, search, status, approvalStatus, industry, createdByRole, sortBy, sortOrder }, actor = null) {
  const conditions = [];
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({
      $or: [{ companyName: rx }, { contactPerson: rx }, { email: rx }, { phone: rx }],
    });
  }
  if (status) conditions.push({ status });
  if (approvalStatus) conditions.push({ approvalStatus });
  if (industry) conditions.push({ industry: { $regex: escapeRegex(industry), $options: 'i' } });
  if (createdByRole === 'Coordinator') {
    const coordinatorIds = await User.find({ role: 'Coordinator' }).distinct('_id');
    conditions.push({ createdBy: { $in: coordinatorIds } });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  // Secondary _id sort keeps pagination stable when the primary key ties.
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };

  const [items, total] = await Promise.all([
    Client.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'createdBy', select: 'name role employee', populate: { path: 'employee', select: 'manager' } })
      .populate(populateTrail())
      .lean(),
    Client.countDocuments(filter),
  ]);
  const annotated = await withCanDecide(await withMissingDetails('Client', items), actor);
  return { items: annotated, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getClient(id, actor = null) {
  const client = await Client.findById(id)
    .populate({ path: 'createdBy', select: 'name role employee', populate: { path: 'employee', select: 'manager' } })
    .populate('decidedBy', 'name')
    .populate(populateTrail())
    .lean();
  if (!client) throw new ApiError(404, 'Client not found.');
  const [annotated] = await withCanDecide([await withMissingDetails('Client', client)], actor);
  return annotated;
}

/**
 * Admin/Manager submissions are auto-approved (they already own the client
 * relationship). A Coordinator's submission always starts Pending, regardless
 * of anything in the request body — approvalStatus is never client-settable
 * (not even in the Zod schema; this is the one place it's assigned).
 */
export async function createClient(data, actor) {
  // A new client is incomplete by definition (it has no documents yet), so the
  // missing-details clock starts now (see notifications/companyDetails.job.js).
  const payload = { ...data, createdBy: actor.userId, missingDetailsSince: new Date() };
  if (actor.role === 'Coordinator') {
    payload.approvalStatus = 'Pending';
    Object.assign(payload, await startApproval('ClientApproval'));
  }
  const client = await Client.create(payload);
  if (client.approvalStatus === 'Pending' && client.workflow) {
    await notifySubmission(client.toObject(), buildStepNotification, LEGACY_DECIDE_ROLES);
  }
  await logAudit({
    user: actor.userId,
    action: 'client.create',
    targetType: 'Client',
    targetId: client._id,
    meta: { companyName: client.companyName, approvalStatus: client.approvalStatus },
    ip: actor.ip,
  });
  return client.toObject();
}

/**
 * A Coordinator may only edit a client they submitted themselves, and only
 * while it isn't Approved yet — once approved it's out of their hands, same
 * boundary as the create-then-hand-off model for clients generally. Any edit
 * they make resubmits it for review: Pending again, previous decision
 * cleared, so a stale rejection note doesn't linger next to fresh data.
 * Admin/Manager keep their existing unrestricted edit (unchanged).
 */
export async function updateClient(id, data, actor) {
  const client = await Client.findById(id);
  if (!client) throw new ApiError(404, 'Client not found.');

  if (actor.role === 'Coordinator') {
    if (client.createdBy?.toString() !== actor.userId) {
      throw new ApiError(403, 'You can only edit clients you added yourself.');
    }
    if (client.approvalStatus === 'Approved') {
      throw new ApiError(403, 'This client is already approved ask an Admin or Manager to make further changes.');
    }
    const wasRejected = client.approvalStatus === 'Rejected';
    data.approvalStatus = 'Pending';
    data.decidedBy = null;
    data.decidedAt = null;
    data.decisionNote = '';
    // A resubmission starts the hierarchy again from the first step (the hierarchy in force now).
    Object.assign(data, await startApproval('ClientApproval'));
    Object.assign(client, data);
    await client.save({ validateModifiedOnly: true });
    if (client.workflow) await notifySubmission(client.toObject(), buildStepNotification, LEGACY_DECIDE_ROLES);
    await logAudit({
      user: actor.userId,
      action: wasRejected ? 'client.resubmit' : 'client.update',
      targetType: 'Client',
      targetId: client._id,
      meta: { companyName: client.companyName, fields: Object.keys(data) },
      ip: actor.ip,
    });
    return client.toObject();
  }

  Object.assign(client, data);
  await client.save({ validateModifiedOnly: true });
  await logAudit({
    user: actor.userId,
    action: 'client.update',
    targetType: 'Client',
    targetId: client._id,
    meta: { companyName: client.companyName, fields: Object.keys(data) },
    ip: actor.ip,
  });
  return client.toObject();
}

/**
 * Approve or reject a Pending client, through the shared approval engine (2026-10-14). With a hierarchy set up
 * for Client Approval the request walks its steps and only a member of the current step's roles (or an Admin)
 * may decide; with none, the original rule stands: the Admin, or a Manager who is this coordinator's manager
 * (Employee.manager, via the coordinator's own linked Employee record). Approving flips the client live for
 * deployment/quotation pickers; rejecting requires a note (decideClientSchema) so the Coordinator knows what to fix.
 */
export async function decideClient(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: Client,
    id,
    decision: status,
    note: decisionNote ?? '',
    actor,
    pendingStatus: 'Pending',
    statusField: 'approvalStatus',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    assertScope: async (who, _employee, client) => {
      if (who.role === 'Admin') return;
      const submitter = await User.findById(client.createdBy).select('employee').lean();
      const submitterEmployee = submitter?.employee ? await Employee.findById(submitter.employee).select('manager').lean() : null;
      if (!submitterEmployee || submitterEmployee.manager?.toString() !== who.userId) {
        throw new ApiError(403, "You are not this coordinator's manager.");
      }
    },
    notFoundMessage: 'Client not found.',
    auditAction: 'client',
    buildFinalNotification: (client) => ({
      type: 'RequestStatus',
      title: `${client.companyName} client submission ${client.approvalStatus.toLowerCase()}`,
      body: client.decisionNote || undefined,
      url: `/clients/${client._id}`,
    }),
    buildStepNotification,
    // The submitter is a User (a Coordinator's own login), not an Employee to resolve through.
    notifyFinal: (client, notification) => notifyUser(client.createdBy, notification),
  });
}

export async function deleteClient(id, actor) {
  // Referential integrity: refuse to orphan employees still pointing here.
  // Assignment lands in M6; until then this count is 0, but the guard is real
  // and prevents a future foot-gun.
  const assigned = await Employee.countDocuments({ currentClient: id });
  if (assigned > 0) {
    throw new ApiError(
      409,
      `This client has ${assigned} assigned employee(s). Reassign or unassign them first.`
    );
  }

  const client = await Client.findByIdAndDelete(id).lean();
  if (!client) throw new ApiError(404, 'Client not found.');
  await logAudit({
    user: actor.userId,
    action: 'client.delete',
    targetType: 'Client',
    targetId: client._id,
    meta: { companyName: client.companyName },
    ip: actor.ip,
  });
}

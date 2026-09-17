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

/**
 * Paginated, searchable, sortable listing.
 * search         → case-insensitive match on company / contact / email / phone
 * status         → exact match (Active/Inactive — operational)
 * approvalStatus → exact match (Approved/Pending/Rejected — see client.model.js)
 * createdByRole  → 'Coordinator' narrows to clients a Coordinator submitted
 * industry       → case-insensitive partial match
 */
export async function listClients({ page, limit, search, status, approvalStatus, industry, createdByRole, sortBy, sortOrder }) {
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
      .lean(),
    Client.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getClient(id) {
  const client = await Client.findById(id)
    .populate({ path: 'createdBy', select: 'name role employee', populate: { path: 'employee', select: 'manager' } })
    .populate('decidedBy', 'name')
    .lean();
  if (!client) throw new ApiError(404, 'Client not found.');
  return client;
}

/**
 * Admin/Manager submissions are auto-approved (they already own the client
 * relationship). A Coordinator's submission always starts Pending, regardless
 * of anything in the request body — approvalStatus is never client-settable
 * (not even in the Zod schema; this is the one place it's assigned).
 */
export async function createClient(data, actor) {
  const payload = { ...data, createdBy: actor.userId };
  if (actor.role === 'Coordinator') payload.approvalStatus = 'Pending';
  const client = await Client.create(payload);
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
      throw new ApiError(403, 'This client is already approved — ask an Admin or Manager to make further changes.');
    }
    const wasRejected = client.approvalStatus === 'Rejected';
    data.approvalStatus = 'Pending';
    data.decidedBy = null;
    data.decidedAt = null;
    data.decisionNote = '';
    Object.assign(client, data);
    await client.save({ validateModifiedOnly: true });
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
 * Approve or reject a Pending client. Admin may always decide; a Manager may
 * only decide submissions from a Coordinator who actually reports to them
 * (Employee.manager, via the Coordinator's own linked Employee record) — not
 * just any pending client. Approving flips the client live for deployment/
 * quotation pickers; rejecting requires a note (enforced by
 * decideClientSchema) so the Coordinator knows what to fix.
 */
export async function decideClient(id, { status, decisionNote }, actor) {
  const client = await Client.findById(id);
  if (!client) throw new ApiError(404, 'Client not found.');
  if (client.approvalStatus !== 'Pending') {
    throw new ApiError(400, 'Only a client pending approval can be decided.');
  }

  if (actor.role !== 'Admin') {
    // "Is this Manager actually this Coordinator's manager" now reads
    // through the Coordinator's own Employee record — Employee.manager
    // replaced User.managedBy as the hierarchy field.
    const submitter = await User.findById(client.createdBy).select('employee').lean();
    const submitterEmployee = submitter?.employee
      ? await Employee.findById(submitter.employee).select('manager').lean()
      : null;
    if (!submitterEmployee || submitterEmployee.manager?.toString() !== actor.userId) {
      throw new ApiError(403, "You are not this coordinator's manager.");
    }
  }

  client.approvalStatus = status;
  client.decidedBy = actor.userId;
  client.decidedAt = new Date();
  client.decisionNote = decisionNote ?? '';
  await client.save();

  await logAudit({
    user: actor.userId,
    action: status === 'Approved' ? 'client.approved' : 'client.rejected',
    targetType: 'Client',
    targetId: client._id,
    meta: { companyName: client.companyName, decisionNote },
    ip: actor.ip,
  });
  // The submitter (`createdBy`) is already a User id — a Coordinator's own
  // login, not an Employee to resolve through, unlike every other
  // notifyEmployeeUser() call in this module.
  await notifyUser(client.createdBy, {
    type: 'RequestStatus',
    title: `${client.companyName} — client submission ${status.toLowerCase()}`,
    body: decisionNote || undefined,
    url: `/clients/${client._id}`,
  });
  return client.toObject();
}

export async function deleteClient(id, actor) {
  // Referential integrity: refuse to orphan employees still pointing here.
  // Assignment lands in M6; until then this count is 0, but the guard is real
  // and prevents a future foot-gun.
  const assigned = await Employee.countDocuments({ currentClient: id });
  if (assigned > 0) {
    throw new ApiError(
      409,
      `This client has ${assigned} assigned worker(s). Reassign or unassign them first.`
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

/**
 * Deployment service — assign / transfer / end / list, plus the integrity
 * rules the whole feature rests on.
 *
 * Every operation that touches TWO documents (the Deployment and the
 * Employee's current* fields) runs inside a MongoDB transaction, so the two
 * can never drift apart: either both writes land or neither does. Atlas is a
 * replica set, so transactions are available.
 */
import mongoose from 'mongoose';
import Deployment from './deployment.model.js';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/**
 * Validate the placement target: the client must exist, be Active, and the
 * given site must be one of that client's registered sites. Returns the
 * client so callers can snapshot its name.
 */
async function resolveClientSite(clientId, site) {
  const client = await Client.findById(clientId).lean();
  if (!client) throw new ApiError(404, 'Client not found.');
  if (client.status !== 'Active') {
    throw new ApiError(400, `${client.companyName} is inactive — reactivate it before deploying workers.`);
  }
  const known = (client.sites ?? []).some((s) => s.name === site);
  if (!known) {
    throw new ApiError(400, `"${site}" is not a registered site for ${client.companyName}.`);
  }
  return client;
}

/** The one active deployment for a worker, or null. */
function findActive(workerId, session) {
  return Deployment.findOne({ worker: workerId, status: 'Active' }).session(session ?? null);
}

/**
 * Assign an unassigned worker to a client site.
 * Errors: 404 worker/client · 400 exited worker / inactive client / bad site
 *         · 409 worker already has an active deployment (double-assignment).
 */
export async function assignWorker(data, actor) {
  const employee = await Employee.findById(data.worker).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (employee.status === 'Exited') {
    throw new ApiError(400, 'This employee has exited the company and cannot be deployed.');
  }
  const existing = await findActive(data.worker);
  if (existing) {
    throw new ApiError(
      409,
      `${employee.fullName} is already deployed. Transfer or end the current deployment first.`
    );
  }
  const client = await resolveClientSite(data.client, data.site);

  const session = await mongoose.startSession();
  try {
    let deployment;
    await session.withTransaction(async () => {
      const [created] = await Deployment.create(
        [{ ...data, clientName: client.companyName, status: 'Active' }],
        { session }
      );
      await Employee.updateOne(
        { _id: data.worker },
        { currentClient: data.client, currentSite: data.site },
        { session }
      );
      deployment = created;
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.assign',
      targetType: 'Deployment',
      targetId: deployment._id,
      meta: { worker: employee.fullName, client: client.companyName, site: data.site },
      ip: actor.ip,
    });
    return deployment.toObject();
  } finally {
    session.endSession();
  }
}

/**
 * Transfer the worker of an active deployment to a new client site: the old
 * deployment is Ended (reason Transferred) and a new Active one is created,
 * atomically.
 * Errors: 404 deployment/client · 400 not-active / inactive client / bad site.
 */
export async function transferDeployment(deploymentId, data, actor) {
  const current = await Deployment.findById(deploymentId).lean();
  if (!current) throw new ApiError(404, 'Deployment not found.');
  if (current.status !== 'Active') {
    throw new ApiError(400, 'Only an active deployment can be transferred.');
  }
  const client = await resolveClientSite(data.client, data.site);

  const session = await mongoose.startSession();
  try {
    let deployment;
    await session.withTransaction(async () => {
      // End the old one FIRST so the partial-unique "one active per worker"
      // index is satisfied when the new Active deployment is inserted.
      await Deployment.updateOne(
        { _id: current._id },
        { status: 'Ended', endDate: new Date(), endReason: 'Transferred' },
        { session }
      );
      const [created] = await Deployment.create(
        [
          {
            worker: current.worker,
            client: data.client,
            clientName: client.companyName,
            site: data.site,
            vehicle: data.vehicle,
            driver: data.driver,
            shift: data.shift,
            startDate: data.startDate,
            notes: data.notes,
            status: 'Active',
          },
        ],
        { session }
      );
      await Employee.updateOne(
        { _id: current.worker },
        { currentClient: data.client, currentSite: data.site },
        { session }
      );
      deployment = created;
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.transfer',
      targetType: 'Deployment',
      targetId: deployment._id,
      meta: { from: current.clientName, to: client.companyName, site: data.site },
      ip: actor.ip,
    });
    return deployment.toObject();
  } finally {
    session.endSession();
  }
}

/**
 * End an active deployment and free the worker (unassign).
 * Errors: 404 deployment · 400 already ended.
 */
export async function endDeployment(deploymentId, actor) {
  const current = await Deployment.findById(deploymentId).lean();
  if (!current) throw new ApiError(404, 'Deployment not found.');
  if (current.status !== 'Active') throw new ApiError(400, 'This deployment has already ended.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Deployment.updateOne(
        { _id: current._id },
        { status: 'Ended', endDate: new Date(), endReason: 'Unassigned' },
        { session }
      );
      await Employee.updateOne(
        { _id: current.worker },
        { currentClient: null, currentSite: null },
        { session }
      );
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.end',
      targetType: 'Deployment',
      targetId: current._id,
      meta: { client: current.clientName, site: current.site },
      ip: actor.ip,
    });
  } finally {
    session.endSession();
  }
}

// ---------------------------------------------------------------------------
// TEMPORARY — pre-production cleanup only. Remove this whole function, its
// route (deployment.routes.js), and its controller (deployment.
// controller.js's `remove`) before going live — the user asked for an
// Admin-only way to clear out dummy/test deployments while building.
// Deployments otherwise have no delete on purpose (see this file's own
// module comment: they're immutable history, and `end` is the real
// lifecycle action) — this bypasses that intentionally, temporarily.
// ---------------------------------------------------------------------------

/** Hard-deletes a Deployment outright. If it was Active, frees the worker
 *  the same way endDeployment does. Router-gated to Admin only. */
export async function deleteDeployment(id, actor) {
  const deployment = await Deployment.findById(id).lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (deployment.status === 'Active') {
        await Employee.updateOne(
          { _id: deployment.worker },
          { currentClient: null, currentSite: null },
          { session }
        );
      }
      await Deployment.deleteOne({ _id: deployment._id }, { session });
    });
  } finally {
    session.endSession();
  }

  await logAudit({
    user: actor.userId,
    action: 'deployment.delete',
    targetType: 'Deployment',
    targetId: id,
    meta: { client: deployment.clientName, site: deployment.site },
    ip: actor.ip,
  });
}

/**
 * List deployments (the register / a worker's history / a client's placements).
 * Filters: worker, client, status. Worker is populated for display.
 */
export async function listDeployments({ page, limit, worker, client, status, sortOrder }) {
  const filter = {};
  if (worker) filter.worker = worker;
  if (client) filter.client = client;
  if (status) filter.status = status;

  const sort = { startDate: sortOrder === 'asc' ? 1 : -1, _id: -1 };
  const [items, total] = await Promise.all([
    Deployment.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('worker', 'fullName employeeId')
      .lean(),
    Deployment.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getDeployment(id) {
  const deployment = await Deployment.findById(id)
    .populate('worker', 'fullName employeeId')
    .lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  return deployment;
}

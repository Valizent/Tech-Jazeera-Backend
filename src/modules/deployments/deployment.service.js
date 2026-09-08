/**
 * Deployment service — auto-create (from an Approved Mobilisation), monthly
 * client-hours/OT entry, and Release, plus the integrity rules this feature
 * rests on.
 *
 * Deployment depends on Mobilisation's MODEL directly (never its service) —
 * mobilisation.service.js is the one calling INTO this file (on approval),
 * so a dependency the other way would be a circular import between the two
 * service modules. Releasing a deployment folds in everything the old
 * Mobilisation-side `completeMobilisation` used to do (mark the source
 * Mobilisation Completed, free the worker back to standby) in one
 * transaction, for exactly this reason — see releaseDeployment below.
 *
 * Every operation that touches more than one document runs inside a MongoDB
 * transaction, so writes can never drift apart: either all land or none do.
 */
import mongoose from 'mongoose';
import Deployment from './deployment.model.js';
import Employee from '../employees/employee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthStrOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Called once by mobilisation.service.js's approveMobilisation, the moment a
 * mobilisation reaches its terminal 'Approved' state — never a route of its
 * own. `mobilisation` is the lean, already-updated Mobilisation document.
 * SupplierEmployee/Freelancer mobilisations get a Deployment too (worker
 * stays null) — this is now the universal "worker is actually placed and
 * working" record, matching Mobilisation's own worker-type scope.
 */
export async function createDeploymentFromMobilisation(mobilisation, actor) {
  const session = await mongoose.startSession();
  try {
    let deployment;
    await session.withTransaction(async () => {
      const [created] = await Deployment.create(
        [
          {
            mobilisation: mobilisation._id,
            workerType: mobilisation.workerType,
            worker: mobilisation.workerType === 'Employee' ? mobilisation.worker : null,
            workerName: mobilisation.workerName,
            client: mobilisation.client,
            clientName: mobilisation.clientName,
            site: mobilisation.site ?? null,
            subcontractor: mobilisation.subcontractor ?? null,
            subcontractorName: mobilisation.subcontractorName ?? null,
            requiredTimesheetHours: mobilisation.requiredTimesheetHours ?? null,
            startDate: mobilisation.mobilisationDate,
            status: 'Active',
          },
        ],
        { session }
      );
      if (mobilisation.workerType === 'Employee') {
        await Employee.updateOne(
          { _id: mobilisation.worker },
          { currentClient: mobilisation.client, currentSite: mobilisation.site ?? null },
          { session }
        );
      }
      deployment = created;
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.create',
      targetType: 'Deployment',
      targetId: deployment._id,
      meta: { worker: mobilisation.workerName, client: mobilisation.clientName, mobilisation: mobilisation._id },
      ip: actor.ip,
    });
    return deployment.toObject();
  } finally {
    session.endSession();
  }
}

/**
 * Add this month's actual client-timesheet hours — only for a month that has
 * fully ended (so "mobilised in September" unlocks September's entry on
 * October 1st) and no earlier than the deployment's own start month. Office
 * Secretary is a hardcoded exception to the Section Access gate (same
 * pattern as mobilisation.service.js's createMobilisation) — they aren't a
 * grantable Section Access role at all.
 */
export async function addMonthlyHours(deploymentId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to enter monthly hours.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  if (deployment.status !== 'Active') {
    throw new ApiError(400, 'Only an active deployment can have hours entered.');
  }
  if (data.month >= currentMonthStr()) {
    throw new ApiError(400, 'You can only enter hours for a month that has already ended.');
  }
  if (data.month < monthStrOf(deployment.startDate)) {
    throw new ApiError(400, 'This deployment had not started yet in that month.');
  }
  if (deployment.monthlyHours.some((m) => m.month === data.month)) {
    throw new ApiError(409, 'Hours for this month have already been entered — edit that entry instead.');
  }

  const contractHours = deployment.requiredTimesheetHours ?? 0;
  const otHours = Math.max(0, data.actualHours - contractHours);
  deployment.monthlyHours.push({
    month: data.month,
    contractHours,
    actualHours: data.actualHours,
    otHours,
    otAmount: data.otAmount ?? 0,
    notes: data.notes,
    enteredBy: actor.userId,
  });
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.add',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: { month: data.month, actualHours: data.actualHours, otHours, otAmount: data.otAmount ?? 0 },
    ip: actor.ip,
  });
  return deployment.toObject();
}

/** Correct an already-entered month (actualHours/otAmount/notes) — recomputes
 *  otHours from the same snapshot contractHours. Same access circle as adding. */
export async function updateMonthlyHours(deploymentId, entryId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to edit monthly hours.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');

  entry.actualHours = data.actualHours;
  entry.otHours = Math.max(0, data.actualHours - entry.contractHours);
  entry.otAmount = data.otAmount ?? 0;
  entry.notes = data.notes;
  entry.enteredBy = actor.userId;
  entry.enteredAt = new Date();
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.update',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: { month: entry.month, actualHours: data.actualHours, otHours: entry.otHours, otAmount: entry.otAmount },
    ip: actor.ip,
  });
  return deployment.toObject();
}

/**
 * Release: the worker is pulled off this client and goes back to standby.
 * Ends the Deployment AND completes the source Mobilisation in one
 * transaction (see this file's own module comment for why that logic lives
 * here rather than being called back into mobilisation.service.js) — the
 * worker is immediately eligible for a brand new Mobilisation afterward
 * (Mobilisation.assertNoActivePlacement only blocks Draft/PendingReview/
 * Approved, never Completed).
 */
export async function releaseDeployment(deploymentId, data, actor) {
  const deployment = await Deployment.findById(deploymentId).lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  if (deployment.status !== 'Active') throw new ApiError(400, 'This deployment has already ended.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Deployment.updateOne(
        { _id: deployment._id },
        {
          status: 'Ended',
          endDate: data.releaseDate,
          endReason: 'Released',
          releaseNote: data.releaseNote,
        },
        { session }
      );
      if (deployment.workerType === 'Employee' && deployment.worker) {
        await Employee.updateOne(
          { _id: deployment.worker },
          { currentClient: null, currentSite: null, coordinator: null },
          { session }
        );
      }
      const updatedMobilisation = await Mobilisation.findOneAndUpdate(
        { _id: deployment.mobilisation, status: 'Approved' },
        { status: 'Completed' },
        { session }
      );
      if (!updatedMobilisation) {
        throw new ApiError(409, 'The source mobilisation is no longer Approved — cannot release.');
      }
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.release',
      targetType: 'Deployment',
      targetId: deployment._id,
      meta: { worker: deployment.workerName, client: deployment.clientName, releaseDate: data.releaseDate },
      ip: actor.ip,
    });
  } finally {
    session.endSession();
  }
}

/**
 * List deployments (the register / a worker's history / a client's placements).
 * Filters: worker, client, status. Worker/mobilisation are populated for display.
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
      .populate('mobilisation', 'serialNumber')
      .lean(),
    Deployment.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getDeployment(id) {
  const deployment = await Deployment.findById(id)
    .populate('worker', 'fullName employeeId')
    .populate('mobilisation', 'serialNumber')
    .lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  return deployment;
}

// ---------------------------------------------------------------------------
// TEMPORARY — pre-production cleanup only. Remove this whole function, its
// route (deployment.routes.js), and its controller (deployment.
// controller.js's `remove`) before going live — the user asked for an
// Admin-only way to clear out dummy/test deployments while building.
// Deployments otherwise have no delete on purpose (see this file's own
// module comment: they're immutable history, and Release is the real
// lifecycle action) — this bypasses that intentionally, temporarily.
// ---------------------------------------------------------------------------

/** Hard-deletes a Deployment outright. If it was Active, frees the worker
 *  the same way a Release does (but does NOT touch the source Mobilisation —
 *  this is dummy-data cleanup, not a real lifecycle action). Router-gated to
 *  Admin only. */
export async function deleteDeployment(id, actor) {
  const deployment = await Deployment.findById(id).lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (deployment.status === 'Active' && deployment.workerType === 'Employee' && deployment.worker) {
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
    meta: { client: deployment.clientName },
    ip: actor.ip,
  });
}

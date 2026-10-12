/**
 * Subcontractor transfers (2026-10-12, milestone 5): moving a subcontractor's
 * employee to a different subcontractor, decided by the Marketing Manager.
 *
 * Who decides: nothing new to configure. The approvers are the members of the
 * approval roles on the FINAL step of the Mobilisation workflow (the Marketing
 * Manager today), plus Admin - the same people who give a mobilisation its
 * final approval, resolved through the same step-authority check.
 *
 * The employee's "record" is the outsourced register (OutsourcedEmployee, by
 * Iqama): its subcontractor is what "in our records he is with X" means, and
 * what an approved transfer changes. A person with no register entry falls
 * back to the subcontractor on their most recent mobilisation.
 */
import mongoose from 'mongoose';
import SubcontractorTransfer from './subcontractorTransfer.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import OutsourcedEmployee from '../employees/outsourcedEmployee.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { resolveStepAuthority, membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { logAudit } from '../audit/audit.service.js';
import ApiError from '../../utils/ApiError.js';

/** Role ids on the last step of the active Mobilisation workflow (none configured: Admin only). */
async function approverRoleIds() {
  const workflow = await resolveApprovalWorkflow({ approvalWorkflow: null }, 'Mobilisation');
  const steps = workflow?.steps ?? [];
  return steps.length ? steps[steps.length - 1].roles ?? [] : [];
}

export async function canDecideTransfers(actor) {
  const { authorized } = await resolveStepAuthority(actor, await approverRoleIds());
  return authorized;
}

/** User ids to tell about a new request: the members of the approver roles. */
async function approverUserIds() {
  const members = await membersOfRoles(await approverRoleIds());
  return members;
}

/**
 * The subcontractor our records hold this employee with, or null: the
 * outsourced register first, else the most recent other mobilisation of that
 * Iqama. `excludeMobilisationId` keeps a mobilisation from being its own
 * evidence when it is being edited.
 */
export async function knownSubcontractorFor(iqamaNumber, excludeMobilisationId = null) {
  if (!iqamaNumber) return null;
  const registered = await OutsourcedEmployee.findOne({ iqamaNumber }).populate('subcontractor', 'name').lean();
  if (registered?.subcontractor) return { id: String(registered.subcontractor._id), name: registered.subcontractor.name };

  const filter = { iqamaNumber, workerType: 'SupplierEmployee', subcontractor: { $ne: null }, archived: { $ne: true } };
  if (excludeMobilisationId) filter._id = { $ne: excludeMobilisationId };
  const latest = await Mobilisation.findOne(filter).sort({ createdAt: -1 }).select('subcontractor subcontractorName').lean();
  return latest ? { id: String(latest.subcontractor), name: latest.subcontractorName } : null;
}

/** Cancel any live request on a mobilisation (its subcontractor changed, or the coordinator chose not to move him). */
export async function cancelPendingTransfers(mobilisationId) {
  await SubcontractorTransfer.updateMany({ mobilisation: mobilisationId, status: 'Pending' }, { $set: { status: 'Cancelled' } });
}

/**
 * Called after a mobilisation is created or its subcontractor/choice changes.
 * `wanted` is the coordinator's answer to "change him to this subcontractor?".
 * Creates (or retargets) the one Pending request when wanted and the chosen
 * subcontractor really differs from the one on record; otherwise clears it.
 */
export async function syncTransferRequest(mobilisation, wanted, actor) {
  const isCandidate = mobilisation.workerType === 'SupplierEmployee' && mobilisation.iqamaNumber && mobilisation.subcontractor;
  if (!isCandidate || !wanted) {
    await cancelPendingTransfers(mobilisation._id);
    return null;
  }
  const known = await knownSubcontractorFor(mobilisation.iqamaNumber, mobilisation._id);
  if (!known || known.id === String(mobilisation.subcontractor)) {
    await cancelPendingTransfers(mobilisation._id);
    return null;
  }

  const payload = {
    mobilisationSerial: mobilisation.serialNumber,
    workerName: mobilisation.workerName,
    iqamaNumber: mobilisation.iqamaNumber,
    from: { subcontractor: new mongoose.Types.ObjectId(known.id), name: known.name },
    to: { subcontractor: mobilisation.subcontractor, name: mobilisation.subcontractorName },
  };
  const existing = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id, status: 'Pending' });
  if (existing) {
    const same = String(existing.to.subcontractor) === String(payload.to.subcontractor);
    Object.assign(existing, payload);
    await existing.save();
    if (same) return existing.toObject();
    await notifyApprovers(existing.toObject());
    return existing.toObject();
  }
  const created = await SubcontractorTransfer.create({ mobilisation: mobilisation._id, requestedBy: actor.userId, ...payload });
  await logAudit({
    user: actor.userId,
    action: 'subcontractorTransfer.request',
    targetType: 'SubcontractorTransfer',
    targetId: created._id,
    meta: { worker: payload.workerName, from: payload.from.name, to: payload.to.name },
    ip: actor.ip,
  });
  await notifyApprovers(created.toObject());
  return created.toObject();
}

async function notifyApprovers(transfer) {
  const ids = await approverUserIds();
  await Promise.all(
    ids.map((userId) =>
      notifyUser(userId, {
        type: 'Task',
        title: `Subcontractor transfer to approve: ${transfer.workerName}`,
        body: `${transfer.workerName} is with ${transfer.from.name}; ${transfer.mobilisationSerial} puts him with ${transfer.to.name}.`,
        url: '/subcontractor-transfers',
        dedupeKey: `subcontractorTransfer:${transfer._id}:${transfer.to.subcontractor}:${userId}`,
      })
    )
  );
}

/** A mobilisation's final approval waits while a transfer request on it is Pending. */
export async function assertNoPendingTransfer(mobilisationId) {
  const pending = await SubcontractorTransfer.findOne({ mobilisation: mobilisationId, status: 'Pending' }).lean();
  if (pending) {
    throw new ApiError(
      409,
      `Waiting for the subcontractor transfer to be approved (${pending.workerName}: ${pending.from.name} to ${pending.to.name}). It can be approved once the transfer is.`
    );
  }
}

/** The latest request on a mobilisation, for its detail screen. */
export async function transferSummaryFor(mobilisationId) {
  const latest = await SubcontractorTransfer.findOne({ mobilisation: mobilisationId }).sort({ createdAt: -1 }).lean();
  if (!latest || latest.status === 'Cancelled') return null;
  return {
    _id: latest._id,
    status: latest.status,
    fromName: latest.from.name,
    toName: latest.to.name,
    decisionNote: latest.decisionNote,
  };
}

/**
 * Deciders see every request (Pending first); anyone else sees the ones they
 * raised. `canDecide` tells the screen whether to show Approve / Reject.
 */
export async function listTransfers({ status }, actor) {
  const canDecide = await canDecideTransfers(actor);
  const filter = {};
  if (status) filter.status = status;
  if (!canDecide) filter.requestedBy = actor.userId;
  const items = await SubcontractorTransfer.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('requestedBy', 'name')
    .populate('decidedBy', 'name')
    .lean();
  return { canDecide, items };
}

export async function countPendingTransfersFor(actor) {
  if (!(await canDecideTransfers(actor))) return 0;
  return SubcontractorTransfer.countDocuments({ status: 'Pending' });
}

export async function decideTransfer(id, { decision, decisionNote }, actor) {
  if (!(await canDecideTransfers(actor))) {
    throw new ApiError(403, 'Only the Marketing Manager can decide a subcontractor transfer.');
  }
  const transfer = await SubcontractorTransfer.findById(id);
  if (!transfer) throw new ApiError(404, 'Transfer request not found.');
  if (transfer.status !== 'Pending') throw new ApiError(409, 'This transfer has already been decided or withdrawn.');

  if (decision === 'Approved') {
    // The employee's record now says he is with the new subcontractor.
    const target = await Subcontractor.findById(transfer.to.subcontractor).select('_id').lean();
    if (!target) throw new ApiError(404, 'The subcontractor this request moves him to no longer exists.');
    await OutsourcedEmployee.findOneAndUpdate(
      { iqamaNumber: transfer.iqamaNumber },
      {
        $set: { subcontractor: transfer.to.subcontractor, workerType: 'SupplierEmployee' },
        $setOnInsert: { name: transfer.workerName, createdBy: actor.userId },
      },
      { upsert: true }
    );
  }

  transfer.status = decision;
  transfer.decidedBy = actor.userId;
  transfer.decidedAt = new Date();
  transfer.decisionNote = decisionNote ?? null;
  await transfer.save();

  const mobilisation = await Mobilisation.findById(transfer.mobilisation).select('coordinators status serialNumber').lean();
  if (decision === 'Rejected' && mobilisation) {
    // Back to the coordinators with the reason. A mobilisation already in
    // review is returned in full (their Section 1 change affects the
    // subcontractor paper the first reviewer handled); a Draft just keeps
    // the note.
    const reason = `Subcontractor transfer rejected: ${decisionNote}`;
    const set = { decisionNote: reason };
    if (mobilisation.status === 'PendingReview') {
      Object.assign(set, { status: 'Rejected', rejectionTarget: 'Both', decidedBy: actor.userId, decidedAt: new Date() });
    }
    await Mobilisation.updateOne({ _id: transfer.mobilisation }, { $set: set });
  }

  await logAudit({
    user: actor.userId,
    action: `subcontractorTransfer.${decision === 'Approved' ? 'approve' : 'reject'}`,
    targetType: 'SubcontractorTransfer',
    targetId: transfer._id,
    meta: { worker: transfer.workerName, from: transfer.from.name, to: transfer.to.name, decisionNote },
    ip: actor.ip,
  });
  if (mobilisation) {
    await Promise.all(
      mobilisation.coordinators.map((c) =>
        notifyUser(c.user, {
          type: 'RequestStatus',
          title: `Subcontractor transfer ${decision.toLowerCase()}: ${transfer.workerName}`,
          body: decision === 'Rejected' ? decisionNote : `${transfer.workerName} now moves to ${transfer.to.name}.`,
          url: `/mobilisations/${transfer.mobilisation}`,
        })
      )
    );
  }
  return transfer.toObject();
}

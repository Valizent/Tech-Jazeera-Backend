/**
 * MobilisationTarget service.
 *
 * Auth gate: `canManageTargets` — Admin, Manager, or any `mobilisationTargets`
 * Section Access write-role member may set/edit/remove targets. A coordinator's
 * own target read is always allowed (no gate) so the dashboard widget works for
 * everyone who is a Coordinator.
 *
 * Progress: SUM of profitPerMonth (2026-09-22, real user correction — used to
 * be a plain COUNT) across Approved + Completed mobilisations where the
 * coordinator is listed on the `coordinators` array (any position — primary
 * or joint) and the `mobilisationDate` falls within the target month. Same
 * filter as the original count-based version, just summed instead of
 * counted — this matches the user's own confirmed rule (both primary and
 * joint coordinators count) exactly as before. A mobilisation with no
 * profitPerMonth yet set (null — see mobilisation.model.js) contributes 0,
 * never breaking the sum.
 */
import mongoose from 'mongoose';
import MobilisationTarget from './mobilisationTarget.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import User from '../auth/user.model.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/** Returns [firstDayOfMonth, firstDayOfNextMonth) as Date objects. Exported so
 *  the dashboard's Coordinator Leaderboard (dashboard.service.js) computes
 *  "this month" the exact same way a coordinator's own Target/progress does
 *  — one shared definition, not two independently-written ones that could
 *  quietly drift (e.g. UTC vs. local, inclusive vs. exclusive) and disagree
 *  on a mobilisation dated right at a month boundary. */
export function monthBounds(month) {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 1); // exclusive upper bound
  return { start, end };
}

/** Sum of profitPerMonth across a coordinator's Approved/Completed
 *  mobilisations in a month — the coordinator's real estimated monthly
 *  profit contribution, what "progress" toward a Riyal target means. */
async function sumProgress(coordinatorId, month) {
  const { start, end } = monthBounds(month);
  // Real bug found and fixed during this feature's own verification: unlike
  // find()/countDocuments(), an aggregate() $match does NOT auto-cast a
  // plain string to ObjectId — every real caller here passes a string
  // (req.user.id straight off the JWT), which silently matched ZERO
  // documents (no error, just achieved:0 for every real coordinator) until
  // this explicit cast was added. Same class of gap the 15 September
  // QA audit fixed elsewhere in this app for the same reason.
  const [row] = await Mobilisation.aggregate([
    {
      $match: {
        'coordinators.user': new mongoose.Types.ObjectId(coordinatorId),
        status: { $in: ['Approved', 'Completed'] },
        mobilisationDate: { $gte: start, $lt: end },
        archived: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$profitPerMonth', 0] } } } },
  ]);
  return row?.total ?? 0;
}

/**
 * Same figure as sumProgress, batched across MANY coordinators in one query
 * (2026-09-24, a real N+1 found while looking for further performance wins —
 * getAllProgress used to call sumProgress once PER coordinator with a target
 * that month, the exact class of per-item-aggregate pattern the 21 September
 * performance audit fixed elsewhere in this app (P3/P4) — invisible today at
 * 2 real coordinators, but the same growth-risk shape). Mirrors
 * dashboard.service.js's getCoordinatorLeaderboard, which computes the
 * identical figure company-wide via the same $unwind+$group shape.
 */
async function sumProgressBatch(coordinatorIds, month) {
  const { start, end } = monthBounds(month);
  const rows = await Mobilisation.aggregate([
    {
      $match: {
        'coordinators.user': { $in: coordinatorIds.map((id) => new mongoose.Types.ObjectId(id)) },
        status: { $in: ['Approved', 'Completed'] },
        mobilisationDate: { $gte: start, $lt: end },
        archived: { $ne: true },
      },
    },
    { $unwind: '$coordinators' },
    { $match: { 'coordinators.user': { $in: coordinatorIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$coordinators.user', total: { $sum: { $ifNull: ['$profitPerMonth', 0] } } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.total]));
}

export async function canManageTargets(actor) {
  if (actor.role === 'Admin' || actor.role === 'Manager') return true;
  return canAccessSection('mobilisationTargets', actor);
}

/**
 * Upsert a target for a coordinator+month. Creates it if none exists,
 * overwrites the existing one if it does. Only management may call this.
 */
export async function setTarget(data, actor) {
  if (!(await canManageTargets(actor))) {
    throw new ApiError(403, 'You do not have permission to manage mobilisation targets.');
  }
  const { coordinatorId, month, target, incentivePercent } = data;

  // Confirm the target user actually exists and is a Coordinator.
  const coordUser = await User.findById(coordinatorId).select('name role').lean();
  if (!coordUser) throw new ApiError(404, 'User not found.');
  if (coordUser.role !== 'Coordinator') {
    throw new ApiError(400, 'Targets can only be set for Coordinator accounts.');
  }

  const doc = await MobilisationTarget.findOneAndUpdate(
    { coordinator: coordinatorId, month },
    {
      coordinator: coordinatorId,
      month,
      target,
      incentivePercent: incentivePercent ?? 0,
      setBy: actor.userId,
    },
    { upsert: true, new: true, runValidators: true }
  ).lean();

  await logAudit({
    user: actor.userId,
    action: 'mobilisationTarget.set',
    targetType: 'MobilisationTarget',
    targetId: doc._id,
    meta: { coordinatorId, coordinatorName: coordUser.name, month, target, incentivePercent },
    ip: actor.ip,
  });

  return doc;
}

/** Remove a target. Management only. */
export async function deleteTarget(id, actor) {
  if (!(await canManageTargets(actor))) {
    throw new ApiError(403, 'You do not have permission to manage mobilisation targets.');
  }
  const doc = await MobilisationTarget.findByIdAndDelete(id).lean();
  if (!doc) throw new ApiError(404, 'Target not found.');
  await logAudit({
    user: actor.userId,
    action: 'mobilisationTarget.delete',
    targetType: 'MobilisationTarget',
    targetId: doc._id,
    meta: { coordinatorId: doc.coordinator, month: doc.month },
    ip: actor.ip,
  });
}

/**
 * The logged-in coordinator's own target + live progress for a given month.
 * Returns null if no target has been set for that month — the widget hides
 * itself in that case.
 */
export async function getMyTarget(actor, month) {
  const targetDoc = await MobilisationTarget.findOne({
    coordinator: actor.userId,
    month,
  }).lean();

  if (!targetDoc) return null;

  const achieved = await sumProgress(actor.userId, month);
  return {
    _id: targetDoc._id,
    month: targetDoc.month,
    target: targetDoc.target,
    incentivePercent: targetDoc.incentivePercent,
    achieved,
    remaining: Math.max(0, targetDoc.target - achieved),
    hit: achieved >= targetDoc.target,
  };
}

/**
 * All coordinators who have a target for the given month, with their live
 * progress counts. Management view — gated on canManageTargets.
 */
export async function getAllProgress(actor, month) {
  if (!(await canManageTargets(actor))) {
    throw new ApiError(403, 'You do not have permission to view mobilisation targets.');
  }

  const targets = await MobilisationTarget.find({ month })
    .populate('coordinator', 'name email')
    .populate('setBy', 'name')
    .lean();

  if (targets.length === 0) return [];

  // FIX (2026-09-24, a real N+1 found looking for further performance wins):
  // this used to call sumProgress once PER target (one Mobilisation.aggregate
  // per coordinator) — now one batched aggregate for every coordinator with a
  // target this month at once. See sumProgressBatch's own doc comment.
  const achievedById = await sumProgressBatch(
    targets.map((t) => t.coordinator._id),
    month
  );

  const withProgress = targets.map((t) => {
    const achieved = achievedById.get(t.coordinator._id.toString()) ?? 0;
    return {
      _id: t._id,
      coordinator: t.coordinator,
      month: t.month,
      target: t.target,
      incentivePercent: t.incentivePercent,
      setBy: t.setBy,
      achieved,
      remaining: Math.max(0, t.target - achieved),
      hit: achieved >= t.target,
    };
  });

  return withProgress.sort((a, b) => a.coordinator.name.localeCompare(b.coordinator.name));
}

/**
 * All targets (any month) — for the management list/edit modal so the MM
 * can see and edit what was already set across months.
 */
export async function listAllTargets(actor) {
  if (!(await canManageTargets(actor))) {
    throw new ApiError(403, 'You do not have permission to view mobilisation targets.');
  }
  return MobilisationTarget.find()
    .populate('coordinator', 'name email')
    .populate('setBy', 'name')
    .sort({ month: -1, 'coordinator.name': 1 })
    .lean();
}

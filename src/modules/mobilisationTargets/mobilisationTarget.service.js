/**
 * MobilisationTarget service.
 *
 * Auth gate: `canManageTargets` — Admin, Manager, or any `mobilisationTargets`
 * Section Access write-role member may set/edit/remove targets. A coordinator's
 * own target read is always allowed (no gate) so the dashboard widget works for
 * everyone who is a Coordinator.
 *
 * Progress counting: Approved + Completed mobilisations where the coordinator
 * is listed on the `coordinators` array (any position — primary or joint) and
 * the `mobilisationDate` falls within the target month. This matches the
 * user's confirmed rule: both primary and joint coordinators count.
 */
import MobilisationTarget from './mobilisationTarget.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import User from '../auth/user.model.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/** Returns [firstDayOfMonth, firstDayOfNextMonth) as Date objects. */
function monthBounds(month) {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 1); // exclusive upper bound
  return { start, end };
}

/** How many Approved/Completed mobilisations a coordinator has in a month. */
async function countProgress(coordinatorId, month) {
  const { start, end } = monthBounds(month);
  return Mobilisation.countDocuments({
    'coordinators.user': coordinatorId,
    status: { $in: ['Approved', 'Completed'] },
    mobilisationDate: { $gte: start, $lt: end },
    archived: { $ne: true },
  });
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

  const achieved = await countProgress(actor.userId, month);
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

  const withProgress = await Promise.all(
    targets.map(async (t) => {
      const achieved = await countProgress(t.coordinator._id, month);
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
    })
  );

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

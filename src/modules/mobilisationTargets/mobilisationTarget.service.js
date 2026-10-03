/**
 * MobilisationTarget service.
 *
 * Auth gate: `canManageTargets` — Admin, Manager, or any `mobilisationTargets`
 * Section Access write-role member may set/edit/remove targets. A coordinator's
 * own target read is always allowed (no gate) so the dashboard widget works for
 * everyone who is a Coordinator.
 *
 * Progress — REAL revenue (2026-09-27, replacing the original 2026-09-22
 * estimate-based version, the user's own explicit ask: a target should
 * reflect money that actually arrived, not a figure computed the moment a
 * mobilisation was approved). `achieved` is now the SUM, across every
 * Deployment.monthlyHours entry for the target month, of however much of
 * that entry's invoice has actually been paid — split by the coordinator's
 * `effectiveSharePercent` on the Deployment's source Mobilisation
 * (mobilisation.service.js — full credit if the coordinator is alone, an
 * even or admin-set split if joint).
 *
 * Same-day follow-up (2026-09-27, the user's own correction): a client
 * pays in BULK for everyone placed there, not per worker — see
 * clientPayment.service.js's own doc comment. "How much of this entry was
 * paid" is no longer a per-entry `paymentDecisionStatus`/`amountReceived`
 * a person typed in; it's this entry's own live FIFO allocation against
 * its client's real payment history (deployment.service.js's
 * getClientAllocation), computed fresh here too — never cached/pushed to a
 * separate ledger, the same "never trust a stored financial figure,
 * recompute" discipline Payroll totals already follow.
 *
 * Own-Employee exclusion (2026-09-27, real user correction): a Deployment of
 * the company's OWN staff (`workerType: 'Employee'`) never contributes to
 * this sum — a coordinator's real value to the company is bringing in
 * supplied/outsourced workers, not deploying existing employees. Own-Employee
 * mobilisations still count (and are surfaced separately, see
 * `countOwnEmployee`/`ownEmployeeCount` below) as a plain count the
 * coordinator/MM can see, just never as Riyal progress.
 */
import mongoose from 'mongoose';
import MobilisationTarget from './mobilisationTarget.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import User from '../auth/user.model.js';
import { effectiveSharePercent } from '../mobilisations/mobilisation.service.js';
import { computeMonthlyRevenueAndExpenses, getClientAllocation } from '../deployments/deployment.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';

/** Shared match fragment excluding Own-Employee mobilisations from the
 *  activity-count aggregates below (getCoordinatorLeaderboard's `count`,
 *  countOwnEmployee's own inverse) — see this file's own top doc comment. */
export const NON_OWN_EMPLOYEE_FILTER = { workerType: { $ne: 'Employee' } };

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

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Every coordinator's REAL revenue credit for one calendar month, company-
 * wide — the one shared definition sumProgress/sumProgressBatch (below) and
 * dashboard.service.js's Coordinator Leaderboard/Drill-down all read from,
 * so the three can never quietly disagree (the same reasoning monthBounds
 * is already shared for). Excludes Own-Employee Deployments (workerType)
 * and any archived Deployment. Returns Map<coordinatorIdString,
 * totalAmount>.
 *
 * One client-payment ledger walk per distinct CLIENT represented this
 * month (not per entry) — a client's FIFO allocation depends on their
 * FULL invoice history, not just this month's slice of it, so
 * getClientAllocation is the one place that math is allowed to happen;
 * this function only sums the result.
 */
export async function realRevenueByCoordinator(month) {
  const deployments = await Deployment.find({
    workerType: { $ne: 'Employee' },
    archived: { $ne: true },
    monthlyHours: { $elemMatch: { month, invoiceSentAt: { $ne: null } } },
  })
    .select('client monthlyHours mobilisation')
    .populate('mobilisation', 'coordinators')
    .lean();

  // 2026-10-03, a real perf-audit finding: these were fetched one client at a
  // time with a sequential await, turning into a full N-round-trip chain on
  // every dashboard load. Each client's allocation is independent, so fire
  // them concurrently instead — same result, no behavior change.
  const clientIds = [...new Set(deployments.map((d) => d.client.toString()))];
  const allocations = await Promise.all(clientIds.map((clientId) => getClientAllocation(clientId)));
  const allocationByEntryId = new Map();
  for (const { perEntry } of allocations) {
    for (const e of perEntry) allocationByEntryId.set(e.entryId.toString(), e.amountAllocated);
  }

  const totals = new Map();
  for (const d of deployments) {
    if (!d.mobilisation) continue;
    const entry = d.monthlyHours.find((m) => m.month === month && m.invoiceSentAt);
    if (!entry) continue;
    const amountAllocated = allocationByEntryId.get(entry._id.toString()) ?? 0;
    if (!amountAllocated) continue;
    for (const c of d.mobilisation.coordinators ?? []) {
      const uid = c.user.toString();
      const share = effectiveSharePercent(d.mobilisation, uid);
      const credited = round2(amountAllocated * (share / 100));
      totals.set(uid, round2((totals.get(uid) ?? 0) + credited));
    }
  }
  return totals;
}

/**
 * Same population as realRevenueByCoordinator, but also returns each
 * coordinator's share of the NET PROFIT behind that revenue — for the
 * semi-annual incentive (below), which is based on profit, not gross
 * revenue. Reuses deployment.service.js's own computeMonthlyRevenueAndExpenses
 * (the exact formula Deployment's own per-entry `profit` column already
 * shows) rather than re-deriving it — one definition, not two. Since
 * `achieved` is based on the entry's live allocation, never the full
 * computed `revenue` (a payment can be partial), the credited profit is
 * scaled by the same allocated/revenue ratio before being split by
 * coordinator share — a partially-paid month contributes only its
 * paid-for share of profit too. Returns { revenueTotals, profitTotals },
 * both Map<coordinatorIdString, amount>.
 */
async function realRevenueAndProfitByCoordinator(month) {
  const deployments = await Deployment.find({
    workerType: { $ne: 'Employee' },
    archived: { $ne: true },
    monthlyHours: { $elemMatch: { month, invoiceSentAt: { $ne: null } } },
  })
    .select('client monthlyHours mobilisation')
    .populate({
      path: 'mobilisation',
      select:
        'coordinators workerType clientRate clientCommission otClientRate otEmployeeRate subcontractorRate subcontractorCommission fta allowance mobilisationCost',
    })
    .lean();

  // See realRevenueByCoordinator's own 2026-10-03 comment above — same fix.
  const clientIds = [...new Set(deployments.map((d) => d.client.toString()))];
  const allocations = await Promise.all(clientIds.map((clientId) => getClientAllocation(clientId)));
  const allocationByEntryId = new Map();
  for (const { perEntry } of allocations) {
    for (const e of perEntry) allocationByEntryId.set(e.entryId.toString(), e.amountAllocated);
  }

  const revenueTotals = new Map();
  const profitTotals = new Map();
  for (const d of deployments) {
    if (!d.mobilisation) continue;
    const entry = d.monthlyHours.find((m) => m.month === month && m.invoiceSentAt);
    if (!entry) continue;
    const { revenue, profit } = computeMonthlyRevenueAndExpenses(entry, d.mobilisation, d.monthlyHours) ?? {};
    if (!revenue) continue;
    const amountAllocated = allocationByEntryId.get(entry._id.toString()) ?? 0;
    if (!amountAllocated) continue;
    // Capped at 1 — a real-world payment can exceed the computed estimate
    // (e.g. a negotiated adjustment); never credit MORE profit than the
    // entry's own computed profit.
    const receivedRatio = Math.min(1, amountAllocated / revenue);
    const receivedRevenue = round2(amountAllocated);
    const receivedProfit = round2(profit * receivedRatio);

    for (const c of d.mobilisation.coordinators ?? []) {
      const uid = c.user.toString();
      const share = effectiveSharePercent(d.mobilisation, uid) / 100;
      revenueTotals.set(uid, round2((revenueTotals.get(uid) ?? 0) + receivedRevenue * share));
      profitTotals.set(uid, round2((profitTotals.get(uid) ?? 0) + receivedProfit * share));
    }
  }
  return { revenueTotals, profitTotals };
}

/** 'YYYY-MM' strings for the 6 calendar months ending at (and including)
 *  `endMonth`, oldest first — the semi-annual tracker's rolling window. */
function last6Months(endMonth) {
  const [y, m] = endMonth.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * One coordinator's semi-annual real-revenue progress, rolling 6-month
 * window ending at `endMonth`. `semiAnnualTarget` is the SUM of each of
 * those 6 months' own individual MobilisationTarget.target (a coordinator's
 * monthly target can change month to month, so this isn't just "the latest
 * ×6"). `incentivePercent` is whichever month's `semiAnnualIncentivePercent`
 * was most recently set (see the model's own doc comment on why there's no
 * separate semi-annual document). The incentive applies ONLY to the net
 * profit behind the EXCESS over target (the user's own confirmed rule) —
 * computed by applying the whole window's own profit-to-revenue ratio to
 * just the excess revenue, since profit isn't tracked per-riyal, only
 * per-placement.
 */
export async function getMySemiAnnualProgress(actor, endMonth) {
  const months = last6Months(endMonth);
  const uid = actor.userId.toString();
  let achieved = 0;
  let netProfit = 0;
  let semiAnnualTarget = 0;
  let incentivePercent = 0;
  let hasAnyTarget = false;

  // 2026-10-03, a real perf-audit finding: this awaited one month at a time,
  // compounding realRevenueAndProfitByCoordinator's own per-client cost 6x.
  // Each month is independent (getAllSemiAnnualProgress already fetches its
  // own 6 months this way) — fetch all 6 concurrently, then fold the results
  // in the SAME oldest-to-newest order `months` already provides, so
  // `incentivePercent` still ends up as "whichever month's value was most
  // recently set," unchanged.
  const perMonth = await Promise.all(
    months.map((month) =>
      Promise.all([realRevenueAndProfitByCoordinator(month), MobilisationTarget.findOne({ coordinator: uid, month }).lean()])
    )
  );
  for (const [{ revenueTotals, profitTotals }, targetDoc] of perMonth) {
    achieved = round2(achieved + (revenueTotals.get(uid) ?? 0));
    netProfit = round2(netProfit + (profitTotals.get(uid) ?? 0));
    if (targetDoc) {
      hasAnyTarget = true;
      semiAnnualTarget += targetDoc.target;
      incentivePercent = targetDoc.semiAnnualIncentivePercent ?? 0;
    }
  }

  if (!hasAnyTarget) return null; // widget hides itself, same as getMyTarget

  const excess = Math.max(0, round2(achieved - semiAnnualTarget));
  const marginRatio = achieved > 0 ? netProfit / achieved : 0;
  const excessNetProfit = round2(excess * marginRatio);
  const incentiveAmount = round2(excessNetProfit * (incentivePercent / 100));

  return {
    windowMonths: months,
    semiAnnualTarget,
    achieved,
    netProfit,
    excess,
    excessNetProfit,
    incentivePercent,
    incentiveAmount,
    hit: semiAnnualTarget > 0 && achieved >= semiAnnualTarget,
  };
}

/**
 * Same figure as getMySemiAnnualProgress, for every coordinator who has at
 * least one target set within the window — management view. Computes each
 * month's revenue/profit/targets ONCE (not once per coordinator), same N+1
 * avoidance sumProgressBatch already established.
 */
export async function getAllSemiAnnualProgress(actor, endMonth) {
  if (!(await canManageTargets(actor))) {
    throw new ApiError(403, 'You do not have permission to view mobilisation targets.');
  }
  const months = last6Months(endMonth);

  const perMonth = await Promise.all(
    months.map(async (month) => {
      const [{ revenueTotals, profitTotals }, targets] = await Promise.all([
        realRevenueAndProfitByCoordinator(month),
        MobilisationTarget.find({ month }).lean(),
      ]);
      return { revenueTotals, profitTotals, targetByCoordinator: new Map(targets.map((t) => [t.coordinator.toString(), t])) };
    })
  );

  const coordinatorIds = new Set();
  for (const { targetByCoordinator } of perMonth) {
    for (const uid of targetByCoordinator.keys()) coordinatorIds.add(uid);
  }
  if (coordinatorIds.size === 0) return { windowMonths: months, rows: [] };

  const coordinators = await User.find({ _id: { $in: [...coordinatorIds] } })
    .select('name email')
    .lean();

  const rows = coordinators.map((c) => {
    const uid = c._id.toString();
    let achieved = 0;
    let netProfit = 0;
    let semiAnnualTarget = 0;
    let incentivePercent = 0;
    for (const { revenueTotals, profitTotals, targetByCoordinator } of perMonth) {
      achieved = round2(achieved + (revenueTotals.get(uid) ?? 0));
      netProfit = round2(netProfit + (profitTotals.get(uid) ?? 0));
      const t = targetByCoordinator.get(uid);
      if (t) {
        semiAnnualTarget += t.target;
        incentivePercent = t.semiAnnualIncentivePercent ?? 0;
      }
    }
    const excess = Math.max(0, round2(achieved - semiAnnualTarget));
    const marginRatio = achieved > 0 ? netProfit / achieved : 0;
    const excessNetProfit = round2(excess * marginRatio);
    const incentiveAmount = round2(excessNetProfit * (incentivePercent / 100));
    return {
      coordinator: c,
      semiAnnualTarget,
      achieved,
      netProfit,
      excess,
      excessNetProfit,
      incentivePercent,
      incentiveAmount,
      hit: semiAnnualTarget > 0 && achieved >= semiAnnualTarget,
    };
  });

  return { windowMonths: months, rows: rows.sort((a, b) => a.coordinator.name.localeCompare(b.coordinator.name)) };
}

/** A single coordinator's real revenue credit for one month — see
 *  realRevenueByCoordinator's own doc comment. */
async function sumProgress(coordinatorId, month) {
  const totals = await realRevenueByCoordinator(month);
  return totals.get(coordinatorId.toString()) ?? 0;
}

/** Count of a coordinator's Own-Employee mobilisations in a month — shown
 *  alongside the Riyal progress above so an Own-Employee deployment is still
 *  visible to the coordinator/MM, just never added to the target amount. */
async function countOwnEmployee(coordinatorId, month) {
  const { start, end } = monthBounds(month);
  return Mobilisation.countDocuments({
    'coordinators.user': new mongoose.Types.ObjectId(coordinatorId),
    workerType: 'Employee',
    status: { $in: ['Approved', 'Completed'] },
    mobilisationDate: { $gte: start, $lt: end },
    archived: { $ne: true },
  });
}

/** Batched version of countOwnEmployee — same N+1 avoidance as sumProgressBatch. */
async function countOwnEmployeeBatch(coordinatorIds, month) {
  const { start, end } = monthBounds(month);
  const rows = await Mobilisation.aggregate([
    {
      $match: {
        'coordinators.user': { $in: coordinatorIds.map((id) => new mongoose.Types.ObjectId(id)) },
        workerType: 'Employee',
        status: { $in: ['Approved', 'Completed'] },
        mobilisationDate: { $gte: start, $lt: end },
        archived: { $ne: true },
      },
    },
    { $unwind: '$coordinators' },
    { $match: { 'coordinators.user': { $in: coordinatorIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$coordinators.user', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

/**
 * Same figure as sumProgress, for MANY coordinators at once — just
 * realRevenueByCoordinator's own map, narrowed to the ids asked for (that
 * function already computes company-wide in one query, so there's no
 * separate N+1 to avoid here the way the old per-coordinator
 * Mobilisation.aggregate version had to).
 */
async function sumProgressBatch(coordinatorIds, month) {
  const totals = await realRevenueByCoordinator(month);
  const idSet = new Set(coordinatorIds.map((id) => id.toString()));
  const filtered = new Map();
  for (const [uid, total] of totals) {
    if (idSet.has(uid)) filtered.set(uid, total);
  }
  return filtered;
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
  const { coordinatorId, month, target, incentivePercent, semiAnnualIncentivePercent } = data;

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
      semiAnnualIncentivePercent: semiAnnualIncentivePercent ?? 0,
      setBy: actor.userId,
    },
    { upsert: true, new: true, runValidators: true }
  ).lean();

  await logAudit({
    user: actor.userId,
    action: 'mobilisationTarget.set',
    targetType: 'MobilisationTarget',
    targetId: doc._id,
    meta: { coordinatorId, coordinatorName: coordUser.name, month, target, incentivePercent, semiAnnualIncentivePercent },
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

  const [achieved, ownEmployeeCount] = await Promise.all([
    sumProgress(actor.userId, month),
    countOwnEmployee(actor.userId, month),
  ]);
  return {
    _id: targetDoc._id,
    month: targetDoc.month,
    target: targetDoc.target,
    incentivePercent: targetDoc.incentivePercent,
    achieved,
    remaining: Math.max(0, targetDoc.target - achieved),
    hit: achieved >= targetDoc.target,
    ownEmployeeCount,
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
  const [achievedById, ownEmployeeCountById] = await Promise.all([
    sumProgressBatch(targets.map((t) => t.coordinator._id), month),
    countOwnEmployeeBatch(targets.map((t) => t.coordinator._id), month),
  ]);

  const withProgress = targets.map((t) => {
    const achieved = achievedById.get(t.coordinator._id.toString()) ?? 0;
    return {
      _id: t._id,
      coordinator: t.coordinator,
      month: t.month,
      target: t.target,
      incentivePercent: t.incentivePercent,
      semiAnnualIncentivePercent: t.semiAnnualIncentivePercent,
      setBy: t.setBy,
      achieved,
      remaining: Math.max(0, t.target - achieved),
      hit: achieved >= t.target,
      ownEmployeeCount: ownEmployeeCountById.get(t.coordinator._id.toString()) ?? 0,
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

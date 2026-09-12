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
import Deployment, { DEMOBILISATION_OUTCOME, EMPLOYEE_ONLY_DEMOBILISATION_REASONS } from './deployment.model.js';
import Employee from '../employees/employee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from '../notifications/notification.service.js';

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** Every user who can decide a monthly-hours entry right now — the
 *  'deploymentsHoursDecide' Section Access grant's literal roles plus
 *  whoever's a member of any granted ApprovalRole (e.g. "Marketing
 *  Manager"). Used only to notify; the actual decide endpoint re-checks
 *  authority itself via canAccessSection, so a notification going to
 *  someone whose grant changed a moment later is a harmless staleness, not
 *  a security gap. */
async function decidersOfDeploymentsHours() {
  const settings = await getSectionAccess('deploymentsHoursDecide');
  const roleUsers = settings.writeRoles.length
    ? await User.find({ role: { $in: settings.writeRoles }, isActive: true }).select('_id').lean()
    : [];
  const approvalRoleUserIds = await membersOfRoles(settings.writeApprovalRoles);
  const ids = new Set([...roleUsers.map((u) => u._id.toString()), ...approvalRoleUserIds]);
  return [...ids];
}

/** Every user who can compute/create an EOSB settlement right now — same
 *  shape as decidersOfDeploymentsHours above, just against the 'eosb'
 *  Section Access key. Used only to proactively notify when a demobilise
 *  exits an Employee (see demobiliseDeployment) — a genuine "you may owe
 *  this person a settlement" nudge, not a permission check. */
async function decidersOfEosb() {
  const settings = await getSectionAccess('eosb');
  const roleUsers = settings.writeRoles.length
    ? await User.find({ role: { $in: settings.writeRoles }, isActive: true }).select('_id').lean()
    : [];
  const approvalRoleUserIds = await membersOfRoles(settings.writeApprovalRoles);
  const ids = new Set([...roleUsers.map((u) => u._id.toString()), ...approvalRoleUserIds]);
  return [...ids];
}

function monthStrOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Real day count for a 'YYYY-MM' string (28-31) — day 0 of the FOLLOWING
 *  month is the last day of THIS one, the standard JS Date trick. */
function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function sum(numbers) {
  return numbers.reduce((total, n) => total + n, 0);
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
  const expectedDays = daysInMonth(data.month);
  if (data.dailyHours.length !== expectedDays) {
    throw new ApiError(400, `${data.month} has ${expectedDays} days — enter hours for each one.`);
  }

  const contractHours = deployment.requiredTimesheetHours ?? 0;
  const actualHours = sum(data.dailyHours);
  const otHours = Math.max(0, actualHours - contractHours);
  deployment.monthlyHours.push({
    month: data.month,
    contractHours,
    dailyHours: data.dailyHours,
    actualHours,
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
    meta: { month: data.month, actualHours, otHours, otAmount: data.otAmount ?? 0 },
    ip: actor.ip,
  });

  const deciderIds = await decidersOfDeploymentsHours();
  await Promise.all(
    deciderIds.map((userId) =>
      notifyUser(userId, {
        type: 'RequestStatus',
        title: `${data.month} hours for ${deployment.workerName} need your review`,
        url: `/deployments/${deployment._id}`,
      })
    )
  );
  return deployment.toObject();
}

/**
 * Correct an already-entered month (actualHours/otAmount/notes) — recomputes
 * otHours from the same snapshot contractHours.
 *
 * Two different editors, two different rules:
 *  - The enterer (Office Secretary, or 'deploymentsHours' write) can edit a
 *    Pending or Rejected entry, same as before — never an Approved one.
 *    Editing a Rejected entry is an implicit resubmit (back to Pending,
 *    decision cleared) so it reappears for the decider.
 *  - Whoever can DECIDE ('deploymentsHoursDecide' write — e.g. Marketing
 *    Manager) may also correct an Approved entry directly — added
 *    2026-09-12, the user's own explicit ask ("the manager can still make
 *    changes, just log the changes"): once someone has final authority over
 *    a number, forcing them through reject→re-enter→re-approve to fix their
 *    own mistake is friction with no real integrity benefit. Status stays
 *    Approved (they're the approver correcting themselves, not someone
 *    else's work needing a fresh look) — but every such edit is logged with
 *    the full before/after (see the audit entry below), so "what changed
 *    and who changed it" is always answerable.
 */
export async function updateMonthlyHours(deploymentId, entryId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const isEnterer = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  const isDecider = await canAccessSection('deploymentsHoursDecide', actor);
  if (!isEnterer && !isDecider) throw new ApiError(403, 'You do not have permission to edit monthly hours.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');
  if (entry.status === 'Approved' && !isDecider) {
    throw new ApiError(400, 'This month is already approved and can no longer be edited.');
  }
  const expectedDays = daysInMonth(entry.month);
  if (data.dailyHours.length !== expectedDays) {
    throw new ApiError(400, `${entry.month} has ${expectedDays} days — enter hours for each one.`);
  }
  const wasRejected = entry.status === 'Rejected';
  const wasApproved = entry.status === 'Approved';
  const before = { actualHours: entry.actualHours, otAmount: entry.otAmount, notes: entry.notes };
  const previousEnteredBy = entry.enteredBy.toString();

  const actualHours = sum(data.dailyHours);
  entry.dailyHours = data.dailyHours;
  entry.actualHours = actualHours;
  entry.otHours = Math.max(0, actualHours - entry.contractHours);
  entry.otAmount = data.otAmount ?? 0;
  entry.notes = data.notes;
  entry.enteredBy = actor.userId;
  entry.enteredAt = new Date();
  // Editing a Rejected entry is an implicit resubmit — back to Pending,
  // decision cleared, so it reappears for the decider rather than sitting
  // rejected forever. An Approved entry stays Approved (see doc comment).
  if (wasRejected) {
    entry.status = 'Pending';
    entry.decidedBy = null;
    entry.decidedAt = null;
    entry.decisionNote = null;
  }
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: wasApproved ? 'deployment.monthlyHours.correctApproved' : 'deployment.monthlyHours.update',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: {
      month: entry.month,
      before,
      after: { actualHours: entry.actualHours, otAmount: entry.otAmount, notes: entry.notes },
      otHours: entry.otHours,
    },
    ip: actor.ip,
  });

  // Only a genuine resubmit (was Rejected) re-notifies the decider — a
  // routine edit of an already-Pending entry doesn't need to ping anyone
  // again, they already have it in their queue.
  if (wasRejected) {
    const deciderIds = await decidersOfDeploymentsHours();
    await Promise.all(
      deciderIds.map((userId) =>
        notifyUser(userId, {
          type: 'RequestStatus',
          title: `${entry.month} hours for ${deployment.workerName} resubmitted for review`,
          url: `/deployments/${deployment._id}`,
        })
      )
    );
  }
  // A post-approval correction is the one other case worth a proactive
  // notification — the original enterer should know an already-approved
  // figure they submitted was changed, even though it needs no action from
  // them (unlike self-correcting their own entry, silently, below).
  if (wasApproved && previousEnteredBy !== actor.userId) {
    await notifyUser(previousEnteredBy, {
      type: 'RequestStatus',
      title: `${entry.month} hours for ${deployment.workerName} were corrected after approval`,
      url: `/deployments/${deployment._id}`,
    });
  }
  return deployment.toObject();
}

/** Approve or Reject one month's entry — the review half of the flow
 *  above. Authority is checked entirely at the route (canDecideHours in
 *  deployment.routes.js, no Office-Secretary-style bypass needed here) —
 *  same posture as releaseDeployment below, not re-checked here. Only a
 *  Pending entry can be decided (an Approved one is locked; a Rejected one
 *  must go back to Pending via updateMonthlyHours first — re-deciding it
 *  directly would bypass the enterer ever seeing/fixing whatever was
 *  wrong). Notifies whoever entered it either way. */
export async function decideMonthlyHours(deploymentId, entryId, data, actor) {
  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');
  if (entry.status !== 'Pending') {
    throw new ApiError(400, 'Only a pending entry can be decided.');
  }

  entry.status = data.decision;
  entry.decidedBy = actor.userId;
  entry.decidedAt = new Date();
  entry.decisionNote = data.note || null;
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.decide',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: { month: entry.month, decision: data.decision },
    ip: actor.ip,
  });

  await notifyUser(entry.enteredBy.toString(), {
    type: 'RequestStatus',
    title:
      data.decision === 'Approved'
        ? `${entry.month} hours for ${deployment.workerName} approved`
        : `${entry.month} hours for ${deployment.workerName} rejected`,
    body: data.note || undefined,
    url: `/deployments/${deployment._id}`,
  });
  return deployment.toObject();
}

/**
 * Demobilise (formerly Release): ends this one placement. What happens to
 * the worker next depends on the reason (see deployment.model.js's
 * DEMOBILISATION_OUTCOME):
 *  - Standby (the default, 'ClientAssignmentEnded'): pulled off this client,
 *    same as the old unconditional Release — free for a brand new
 *    Mobilisation right away (Mobilisation.assertNoActivePlacement only
 *    blocks Draft/PendingReview/Approved, never Completed).
 *  - Exit ('TerminatedByCompany'/'Resigned'/'TransferredToAnotherCompany',
 *    or 'Other' with exitOutcome:true — Employee only): also sets
 *    Employee.status='Exited', the one new piece of state this feature
 *    adds. Every filter that already excludes Exited employees (Payroll,
 *    the dashboard's active headcount, expiry alerts) picks this up for
 *    free — no other code needed to "connect" it. mobilisation.service.js's
 *    createMobilisation separately refuses to mobilise an Exited employee
 *    again, so this is a real dead end, not cosmetic.
 * Still ends the Deployment AND completes the source Mobilisation in one
 * transaction (see this file's own module comment for why that logic lives
 * here rather than being called back into mobilisation.service.js).
 */
export async function demobiliseDeployment(deploymentId, data, actor) {
  const deployment = await Deployment.findById(deploymentId).lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  if (deployment.status !== 'Active') throw new ApiError(400, 'This deployment has already ended.');

  const isEmployeeOnlyReason = EMPLOYEE_ONLY_DEMOBILISATION_REASONS.includes(data.reason);
  if (isEmployeeOnlyReason && deployment.workerType !== 'Employee') {
    throw new ApiError(400, 'This reason only applies to a real Employee — this worker has no employment relationship with the company to end.');
  }
  const isExitOutcome =
    deployment.workerType === 'Employee' &&
    (data.reason === 'Other' ? Boolean(data.exitOutcome) : DEMOBILISATION_OUTCOME[data.reason] === 'Exit');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Deployment.updateOne(
        { _id: deployment._id },
        {
          status: 'Ended',
          endDate: data.releaseDate,
          endReason: data.reason,
          demobilisationOutcome: isExitOutcome ? 'Exit' : 'Standby',
          releaseNote: data.releaseNote,
        },
        { session }
      );
      if (deployment.workerType === 'Employee' && deployment.worker) {
        const employeeUpdate = { currentClient: null, currentSite: null, coordinator: null };
        if (isExitOutcome) employeeUpdate.status = 'Exited';
        await Employee.updateOne({ _id: deployment.worker }, employeeUpdate, { session });
      }
      const updatedMobilisation = await Mobilisation.findOneAndUpdate(
        { _id: deployment.mobilisation, status: 'Approved' },
        { status: 'Completed' },
        { session }
      );
      if (!updatedMobilisation) {
        throw new ApiError(409, 'The source mobilisation is no longer Approved — cannot demobilise.');
      }
    });
    await logAudit({
      user: actor.userId,
      action: 'deployment.release',
      targetType: 'Deployment',
      targetId: deployment._id,
      meta: {
        worker: deployment.workerName,
        client: deployment.clientName,
        releaseDate: data.releaseDate,
        reason: data.reason,
        outcome: isExitOutcome ? 'Exit' : 'Standby',
      },
      ip: actor.ip,
    });
  } finally {
    session.endSession();
  }

  // Non-blocking nudge — whoever can compute an EOSB settlement should know
  // one may now be due, even if the person who demobilised this worker
  // never opens the follow-up prompt the client shows. See this file's own
  // module comment on why this notification lives here rather than in
  // mobilisation.service.js: this IS the moment the exit is decided.
  if (isExitOutcome) {
    const deciderIds = await decidersOfEosb();
    await Promise.all(
      deciderIds.map((userId) =>
        notifyUser(userId, {
          type: 'RequestStatus',
          title: `${deployment.workerName} has exited the company — an EOSB settlement may be due`,
          url: `/eosb/new?employee=${deployment.worker}`,
        })
      )
    );
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

/**
 * Real profit for one already-entered month — same shape as Mobilisation's
 * own computeProfitFields (server/src/modules/mobilisations/
 * mobilisation.service.js), just applied recurringly per real month instead
 * of once at commercial-details time. Deployment has no rate fields of its
 * own (see the model's doc comment — identity/commercial context lives on
 * the source Mobilisation), so the caller must pass the populated one.
 * Never stored — recomputed on every read, matching this app's "recompute
 * financials server-side, always" rule (see money()'s sibling in
 * mobilisation.service.js).
 */
function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function computeMonthlyProfit(entry, mobilisation) {
  if (!mobilisation) return null;
  const isSupplier = mobilisation.workerType === 'SupplierEmployee';
  const clientSide = (mobilisation.clientRate ?? 0) - (mobilisation.clientCommission ?? 0);
  const subSide = isSupplier ? (mobilisation.subcontractorRate ?? 0) + (mobilisation.subcontractorCommission ?? 0) : 0;
  const profitPerHour = clientSide - subSide;

  const otClientSide = (mobilisation.otClientRate ?? 0) - (mobilisation.otClientCommission ?? 0);
  const otSubSide = isSupplier
    ? (mobilisation.otSubcontractorRate ?? 0) + (mobilisation.otSubcontractorCommission ?? 0)
    : 0;
  const otProfitPerHour = otClientSide - otSubSide;
  const otProfitTotal = money(otProfitPerHour * entry.otHours);

  return money(profitPerHour * entry.contractHours - (mobilisation.fta ?? 0) - (mobilisation.allowance ?? 0) + otProfitTotal);
}

const PROFIT_RATE_FIELDS =
  'serialNumber workerType clientRate clientCommission subcontractorRate subcontractorCommission ' +
  'otClientRate otClientCommission otSubcontractorRate otSubcontractorCommission fta allowance';

export async function getDeployment(id, actor) {
  const deployment = await Deployment.findById(id)
    .populate('worker', 'fullName employeeId')
    .populate('mobilisation', PROFIT_RATE_FIELDS)
    .lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');

  // Profit is commercial data, same sensitivity class as Mobilisation's own
  // COMMERCIAL_FIELDS — restricted to whoever can decide this section
  // (Admin always passes canAccessSection) rather than the broader
  // deploymentsRelease/deploymentsHours circles that can merely view or
  // enter hours. Computed either way (cheap, no extra query — the
  // Mobilisation rate fields are already populated above), then stripped,
  // matching "never trust the client, and never even SEND what an
  // unauthorized viewer shouldn't have" rather than just hiding it in the UI.
  const canSeeProfit = actor ? await canAccessSection('deploymentsHoursDecide', actor) : false;
  deployment.monthlyHours = deployment.monthlyHours.map((entry) => {
    const profit = computeMonthlyProfit(entry, deployment.mobilisation);
    return canSeeProfit ? { ...entry, profit } : entry;
  });
  if (canSeeProfit) {
    const withProfit = deployment.monthlyHours.filter((e) => e.profit != null);
    deployment.totalProfit = withProfit.length ? money(withProfit.reduce((sum, e) => sum + e.profit, 0)) : null;
  }
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

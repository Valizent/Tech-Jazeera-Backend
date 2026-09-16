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
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** Every user who can decide a monthly-hours entry right now — whoever's a
 *  member of any ApprovalRole granted write on the 'deploymentsHoursDecide'
 *  Section Access key (e.g. "Marketing Manager"). Used only to notify; the
 *  actual decide endpoint re-checks authority itself via canAccessSection,
 *  so a notification going to someone whose grant changed a moment later is
 *  a harmless staleness, not a security gap. */
async function decidersOfDeploymentsHours() {
  const settings = await getSectionAccess('deploymentsHoursDecide');
  return membersOfRoles(settings.writeApprovalRoles);
}

/** Every user who can compute/create an EOSB settlement right now — same
 *  shape as decidersOfDeploymentsHours above, just against the 'eosb'
 *  Section Access key. Used only to proactively notify when a demobilise
 *  exits an Employee (see demobiliseDeployment) — a genuine "you may owe
 *  this person a settlement" nudge, not a permission check. */
async function decidersOfEosb() {
  const settings = await getSectionAccess('eosb');
  return membersOfRoles(settings.writeApprovalRoles);
}

/** The OT amount billed for one month — otHours × the source Mobilisation's
 *  `otClientRate` (the OT rate/hour quoted to the client, set on the
 *  Mobilisation at creation — see mobilisation.service.js). Always
 *  server-computed, never client-submitted (see deployment.validation.js) —
 *  same "recompute financials server-side" rule as every other derived
 *  figure in this app. Commercial data — see getDeployment/listDeployments
 *  for where it's stripped from a non-decider's response. */
async function computeOtAmount(mobilisationId, otHours) {
  const mobilisation = await Mobilisation.findById(mobilisationId).select('otClientRate').lean();
  return money(otHours * (mobilisation?.otClientRate ?? 0));
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

/** Only a 'Worked' day contributes hours — Off/Sick/Absent are explicitly
 *  non-working days (see deployment.model.js's DAILY_ENTRY_STATUSES). */
function sumWorkedHours(dailyHours) {
  return dailyHours.reduce((total, d) => total + (d.status === 'Worked' ? d.hours ?? 0 : 0), 0);
}

/** A 'Worked' day must fall within the deployment's ACTUAL placement dates
 *  — fixed 2026-09-15, a real QA-audit-found gap — F6: the checks above
 *  only ever bound the whole MONTH (e.g. `data.month <= endMonth` for an
 *  Ended deployment), never individual days within a partial start/end
 *  month, so a deployment demobilised mid-month could still have every
 *  remaining day of that calendar month billed as Worked hours. `endDate`
 *  is the inclusive last real day (the demobilisation date itself is still
 *  a placement day). Only 'Worked' is checked — Off/Sick/Absent don't bill
 *  anything and aren't a claim about a day the worker was actually placed
 *  there. */
function assertWorkedDaysWithinPlacement(deployment, month, dailyHours) {
  const total = daysInMonth(month);
  const firstDay = month === monthStrOf(deployment.startDate) ? new Date(deployment.startDate).getDate() : 1;
  const lastDay =
    deployment.endDate && month === monthStrOf(deployment.endDate) ? new Date(deployment.endDate).getDate() : total;
  dailyHours.forEach((day, i) => {
    const dayOfMonth = i + 1;
    if (day.status === 'Worked' && (dayOfMonth < firstDay || dayOfMonth > lastDay)) {
      throw new ApiError(400, `Day ${dayOfMonth} of ${month} falls outside this deployment's actual placement dates.`);
    }
  });
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
 * Secretary is a hardcoded OR-bypass alongside the real Section Access gate
 * (same pattern as mobilisation.service.js's createMobilisation) — a genuine
 * business rule, not a Section Access limitation: since the 2026-09-13 "full
 * staff floor" change, Office Secretary CAN also be granted 'deploymentsHours'
 * like any other role via ApprovalRole membership, so this bypass is now a
 * standing convenience on top of that, not the only path in.
 */
export async function addMonthlyHours(deploymentId, data, actor) {
  const isOfficeSecretary = actor.role === 'Office Secretary';
  const allowed = isOfficeSecretary || (await canAccessSection('deploymentsHours', actor));
  if (!allowed) throw new ApiError(403, 'You do not have permission to enter monthly hours.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: this endpoint only
  // ever checked the Section Access grant, never whether the deployment's
  // worker is actually this Coordinator's own — the same team-ownership
  // check getDeployment already enforces for a single read (a no-op for
  // any non-Coordinator role).
  await assertEmployeeVisibleToActor(deployment.worker, actor);
  // An Ended deployment can still get its own FINAL month entered, as long
  // as that month is one it was actually active for — fixed 2026-09-14, a
  // real QA-audit-found gap — F5: a placement that ends mid-month (e.g.
  // demobilised August 15th, before anyone entered August's hours) could
  // never have its first-and-only August entry made at all, since the
  // blanket `status !== 'Active'` check ran before the ordinary "wait for
  // the month to end" flow ever got a chance. `endDate`'s own month is the
  // real upper bound for an Ended deployment — a month AFTER that is still
  // correctly refused (the worker genuinely wasn't there), unchanged.
  if (deployment.status !== 'Active') {
    const endMonth = deployment.endDate ? monthStrOf(deployment.endDate) : null;
    if (deployment.status !== 'Ended' || !endMonth || data.month > endMonth) {
      throw new ApiError(400, 'Only an active deployment — or an ended one, for a month within its actual placement dates — can have hours entered.');
    }
  }
  if (data.month >= currentMonthStr()) {
    throw new ApiError(400, 'You can only enter hours for a month that has already ended.');
  }
  if (data.month < monthStrOf(deployment.startDate)) {
    throw new ApiError(400, 'This deployment had not started yet in that month.');
  }
  const expectedDays = daysInMonth(data.month);
  if (data.dailyHours.length !== expectedDays) {
    throw new ApiError(400, `${data.month} has ${expectedDays} days — enter hours for each one.`);
  }
  assertWorkedDaysWithinPlacement(deployment, data.month, data.dailyHours);

  const contractHours = deployment.requiredTimesheetHours ?? 0;
  const actualHours = sumWorkedHours(data.dailyHours);
  const otHours = Math.max(0, actualHours - contractHours);
  const otAmount = await computeOtAmount(deployment.mobilisation, otHours);
  const newEntry = {
    month: data.month,
    contractHours,
    dailyHours: data.dailyHours,
    actualHours,
    otHours,
    otAmount,
    deductionAmount: data.deductionAmount ?? 0,
    notes: data.notes,
    enteredBy: actor.userId,
  };

  // Atomic push, not read-.some()-then-push-then-save (fixed 2026-09-14, a
  // real QA-audit-found race — F2): two concurrent submissions for the same
  // month could both pass an in-memory `.some()` check against the same
  // stale read, then both push, leaving duplicate entries for one month.
  // `'monthlyHours.month': { $ne: data.month }` is re-checked by MongoDB
  // against the CURRENT document at write time — only the first of two
  // concurrent requests can match it; the loser gets `null` back.
  const updated = await Deployment.findOneAndUpdate(
    { _id: deployment._id, 'monthlyHours.month': { $ne: data.month } },
    { $push: { monthlyHours: newEntry } },
    { new: true }
  );
  if (!updated) {
    throw new ApiError(409, 'Hours for this month have already been entered — edit that entry instead.');
  }

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.add',
    targetType: 'Deployment',
    targetId: updated._id,
    meta: { month: data.month, actualHours, otHours, otAmount },
    ip: actor.ip,
  });

  const deciderIds = await decidersOfDeploymentsHours();
  await Promise.all(
    deciderIds.map((userId) =>
      notifyUser(userId, {
        type: 'RequestStatus',
        title: `${data.month} hours for ${updated.workerName} need your review`,
        url: `/deployments/${updated._id}`,
      })
    )
  );
  // 'read' (fixed 2026-09-15, the user's own ask — a Coordinator/Manager/HR
  // cost-and-profit view): visibility no longer requires the WRITE grant
  // that also carries decide power — a Read-only grant on this same key now
  // suffices to see the figure. `hasWrite` still implies `hasRead` in
  // canAccessSection, so an existing decider's access is unaffected.
  const canSeeCommercial = await canAccessSection('deploymentsHoursDecide', actor, 'read');
  return stripCommercialMonthlyHours(updated.toObject(), canSeeCommercial);
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
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: same missing
  // team-ownership check as addMonthlyHours above.
  await assertEmployeeVisibleToActor(deployment.worker, actor);
  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');
  if (entry.status === 'Approved' && !isDecider) {
    throw new ApiError(400, 'This month is already approved and can no longer be edited.');
  }
  const expectedDays = daysInMonth(entry.month);
  if (data.dailyHours.length !== expectedDays) {
    throw new ApiError(400, `${entry.month} has ${expectedDays} days — enter hours for each one.`);
  }
  assertWorkedDaysWithinPlacement(deployment, entry.month, data.dailyHours);
  const wasRejected = entry.status === 'Rejected';
  const wasApproved = entry.status === 'Approved';
  const before = { actualHours: entry.actualHours, otAmount: entry.otAmount, deductionAmount: entry.deductionAmount, notes: entry.notes };
  const previousEnteredBy = entry.enteredBy.toString();

  const actualHours = sumWorkedHours(data.dailyHours);
  entry.dailyHours = data.dailyHours;
  entry.actualHours = actualHours;
  entry.otHours = Math.max(0, actualHours - entry.contractHours);
  entry.otAmount = await computeOtAmount(deployment.mobilisation, entry.otHours);
  entry.deductionAmount = data.deductionAmount ?? 0;
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
      after: { actualHours: entry.actualHours, otAmount: entry.otAmount, deductionAmount: entry.deductionAmount, notes: entry.notes },
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
  return stripCommercialMonthlyHours(deployment.toObject(), isDecider);
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
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: 'deploymentsRelease'
  // write defaults to ['Coordinator', 'Manager'] (see deployment.routes.js),
  // so without this check ANY Coordinator could demobilise — and, for an
  // Exit-outcome reason, mark Exited — an employee on a completely
  // different team, out of the box, no extra grant required. Same
  // team-ownership check as the read-side getDeployment already enforces.
  await assertEmployeeVisibleToActor(deployment.worker, actor);
  if (deployment.status !== 'Active') throw new ApiError(400, 'This deployment has already ended.');
  // Fixed 2026-09-15, a real QA-audit-found gap — F6: nothing stopped a
  // demobilisation date before the deployment's own start date — physically
  // impossible (a placement can't end before it began), same bug class as
  // the cross-mobilisation date-overlap gap fixed in mobilisation.service.js
  // 2026-09-13.
  if (data.releaseDate < deployment.startDate) {
    throw new ApiError(400, 'Demobilisation date cannot be before this deployment started.');
  }

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
 * Standby workforce — everyone who was placed with a client at some point
 * and isn't right now, in two genuinely different shapes (2026-09-14, a
 * real user ask — "where can I see the standby list", followed by
 * clarifying which population it should cover):
 *
 *  - `ownEmployees`: an 'Own'-type Employee with a real Worker-role login —
 *    the only population ever placed via `Mobilisation.workerType:
 *    'Employee'` (see mobilisation.service.js's own worker-candidate
 *    filter) and so the only one with a live `currentClient` field to read
 *    off directly. A simple, accurate field lookup.
 *  - `subcontractedWorkers`: a SupplierEmployee/Freelancer mobilisation has
 *    no Employee record and no `currentClient` at all — identity is only
 *    ever a typed-in Iqama number snapshot on the Mobilisation itself, with
 *    no persisted "are they free right now" flag anywhere. This half is
 *    DERIVED, not read off a field: group every non-Employee Mobilisation
 *    by Iqama, take the most recent one per worker, and treat 'Completed'
 *    (their last placement actually ended, with nothing newer since) as
 *    "available again." A Draft/PendingReview/Rejected most-recent record
 *    was never a real placement, so that worker doesn't appear here at all
 *    — a known, deliberate simplification for a first version, not a
 *    lookup failure: a worker whose newest record is Rejected genuinely IS
 *    free, but re-deriving "the next most recent Completed one" for that
 *    case is a real second query per rejected worker, not a one-line
 *    addition — left for a follow-up if it turns out to matter in
 *    practice.
 */
export async function getStandbyWorkforce() {
  const workerLoginEmployeeIds = await User.find({ role: 'Worker', employee: { $ne: null } }).distinct('employee');
  const ownEmployees = await Employee.find({
    _id: { $in: workerLoginEmployeeIds },
    type: 'Own',
    status: { $ne: 'Exited' },
    currentClient: null,
  })
    .select('fullName employeeId designation mobile nationality')
    .sort({ fullName: 1 })
    .lean();

  const latestPerWorker = await Mobilisation.aggregate([
    { $match: { workerType: { $ne: 'Employee' }, iqamaNumber: { $ne: null } } },
    { $sort: { mobilisationDate: -1, createdAt: -1 } },
    { $group: { _id: '$iqamaNumber', latest: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$latest' } },
    { $match: { status: 'Completed' } },
    { $sort: { mobilisationDate: -1 } },
  ]);

  // The authoritative "last day worked"/reason is the real ENDED Deployment
  // this mobilisation produced (set by demobiliseDeployment), not
  // Mobilisation's own unrelated `checkoutDate` field.
  const endedDeployments = await Deployment.find({ mobilisation: { $in: latestPerWorker.map((m) => m._id) } })
    .select('mobilisation endDate endReason')
    .lean();
  const endedByMobilisation = new Map(endedDeployments.map((d) => [String(d.mobilisation), d]));

  const subcontractedWorkers = latestPerWorker.map((m) => {
    const ended = endedByMobilisation.get(String(m._id));
    return {
      workerType: m.workerType,
      workerName: m.workerName,
      iqamaNumber: m.iqamaNumber,
      nationality: m.nationality ?? null,
      phone: m.phone ?? null,
      subcontractorName: m.subcontractorName ?? null,
      lastClientName: m.clientName,
      lastEndDate: ended?.endDate ?? null,
      lastEndReason: ended?.endReason ?? null,
    };
  });

  return { ownEmployees, subcontractedWorkers };
}

/**
 * List deployments (the register / a worker's history / a client's placements).
 * Filters: worker, client, status. Worker/mobilisation are populated for display.
 */
export async function listDeployments({ page, limit, worker, client, status, sortOrder }, actor) {
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: `?worker=` accepted
  // any employee id with no ownership check, unlike the single-record read
  // right below (getDeployment) — a Coordinator could pull a foreign
  // employee's whole placement history through the list filter even though
  // opening one of those deployments directly correctly 403s. A no-op for
  // any non-Coordinator role.
  if (worker) await assertEmployeeVisibleToActor(worker, actor);
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
  // otAmount is commercial (see getDeployment's own doc comment) — this list
  // isn't currently rendered anywhere on the client, but never send it to a
  // non-decider regardless, same "never even send it" rule as the
  // single-record read.
  // 'read' — see the sibling comment in updateMonthlyHours above.
  const canSeeCommercial = actor ? await canAccessSection('deploymentsHoursDecide', actor, 'read') : false;
  const strippedItems = canSeeCommercial
    ? items
    : items.map((d) => ({ ...d, monthlyHours: d.monthlyHours.map(({ otAmount, ...rest }) => rest) }));
  return { items: strippedItems, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
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

  const otProfitPerHour = (mobilisation.otClientRate ?? 0) - (mobilisation.otEmployeeRate ?? 0);
  const otProfitTotal = money(otProfitPerHour * entry.otHours);

  return money(
    profitPerHour * entry.contractHours -
      (mobilisation.fta ?? 0) -
      (mobilisation.allowance ?? 0) +
      otProfitTotal -
      (entry.deductionAmount ?? 0)
  );
}

/**
 * Every client-timesheet deduction (see deployment.model.js's own doc
 * comment on `deductionAmount`) a real Employee had for one calendar month,
 * across every Deployment they've ever had — for Payroll to fold into that
 * employee's PayrollRun line as an `otherDeductions` entry (see
 * payroll.service.js's createPayrollRun). Only an Approved entry counts —
 * an unapproved (possibly disputed) figure must never reach a real
 * paycheck. Payroll depends on THIS module's model, one level removed from
 * its service, the same one-directional pattern this file itself uses for
 * Mobilisation — no circularity risk, Deployment has no reason to ever call
 * into Payroll.
 *
 * Deliberately snapshot-at-read, same as every other Payroll figure this
 * app computes at PayrollRun creation time (approvedHours, overtimeHours,
 * sickLeaveDeduction) — a deduction entered or approved AFTER that month's
 * run already exists is NOT retroactively pulled in; HR/Accounts can still
 * add it by hand via the run's own existing otherDeductions editing, same
 * fallback GOSI already relies on, but only while the run is still Draft.
 */
export async function deductionsForEmployeeMonth(employeeId, monthStr) {
  const deployments = await Deployment.find({
    worker: employeeId,
    monthlyHours: { $elemMatch: { month: monthStr, deductionAmount: { $gt: 0 }, status: 'Approved' } },
  })
    .select('clientName monthlyHours')
    .lean();

  const deductions = [];
  for (const deployment of deployments) {
    const entry = deployment.monthlyHours.find(
      (m) => m.month === monthStr && m.deductionAmount > 0 && m.status === 'Approved'
    );
    if (entry) {
      deductions.push({ label: `Client deduction — ${deployment.clientName} (${monthStr})`, amount: entry.deductionAmount });
    }
  }
  return deductions;
}

/**
 * Strip `otAmount` from every monthlyHours entry for a non-decider — the
 * same redaction getDeployment already applied on read, now shared with
 * addMonthlyHours/updateMonthlyHours (fixed 2026-09-14, a real QA-audit
 * finding: both mutation endpoints returned the raw `deployment.toObject()`
 * with `otAmount` intact regardless of who called them — someone with only
 * 'deploymentsHours' write, e.g. Office Secretary, could read the
 * confidential OT rate straight off her own entry-submission response even
 * though the GET endpoint correctly hid it). Never trust the client, and
 * never even SEND what an unauthorized viewer shouldn't have.
 */
function stripCommercialMonthlyHours(deployment, canSeeCommercial) {
  if (canSeeCommercial) return deployment;
  deployment.monthlyHours = deployment.monthlyHours.map(({ otAmount, ...rest }) => rest);
  return deployment;
}

const PROFIT_RATE_FIELDS =
  'serialNumber workerType clientRate clientCommission subcontractorRate subcontractorCommission ' +
  'otClientRate otEmployeeRate fta allowance';

export async function getDeployment(id, actor) {
  const deployment = await Deployment.findById(id)
    .populate('worker', 'fullName employeeId')
    .populate('mobilisation', PROFIT_RATE_FIELDS)
    .lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  // Coordinator team-scoping (2026-09-14, a real QA-audit-found gap): a
  // SupplierEmployee/Freelancer deployment has no linked Employee `worker`
  // at all, so there's nothing to scope — same reasoning Documents/Assets/
  // EOSB use for a record with no Employee owner.
  if (deployment.worker) {
    await assertEmployeeVisibleToActor(deployment.worker._id, actor);
  }

  // Profit and OT amount (added 2026-09-13, see the model's doc comment) are
  // both commercial data, same sensitivity class as Mobilisation's own
  // COMMERCIAL_FIELDS — restricted to whoever can decide this section
  // (Admin always passes canAccessSection) rather than the broader
  // deploymentsRelease/deploymentsHours circles that can merely view or
  // enter hours. Profit is computed either way (cheap, no extra query — the
  // Mobilisation rate fields are already populated above) then only attached
  // for a decider; otAmount is stripped the other way (it's already stored
  // on the entry). Non-deciders also lose the raw rate fields off
  // `mobilisation` itself, not just the figures derived from them — matching
  // "never trust the client, and never even SEND what an unauthorized viewer
  // shouldn't have" rather than just hiding it in the UI. `serialNumber` is
  // kept regardless — the "View mobilisation" link needs it and it's not
  // commercial.
  // 'read' — see the sibling comment in updateMonthlyHours above.
  const canSeeCommercial = actor ? await canAccessSection('deploymentsHoursDecide', actor, 'read') : false;
  deployment.monthlyHours = deployment.monthlyHours.map((entry) => {
    if (canSeeCommercial) return { ...entry, profit: computeMonthlyProfit(entry, deployment.mobilisation) };
    const { otAmount, ...rest } = entry;
    return rest;
  });
  if (canSeeCommercial) {
    const withProfit = deployment.monthlyHours.filter((e) => e.profit != null);
    deployment.totalProfit = withProfit.length ? money(withProfit.reduce((sum, e) => sum + e.profit, 0)) : null;
  } else if (deployment.mobilisation) {
    deployment.mobilisation = { _id: deployment.mobilisation._id, serialNumber: deployment.mobilisation.serialNumber };
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

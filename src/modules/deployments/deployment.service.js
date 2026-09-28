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
import Client from '../clients/client.model.js';
import Expense from '../expenses/expense.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';
import { signedDownloadUrl } from '../../middleware/upload.js';
import { allocateClientPayments, getClientPaymentHistory } from './clientPayment.service.js';

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

/**
 * All Pending monthly-hours entries across every deployment the caller can
 * see — the manager's approval queue. Gated by 'deploymentsHoursDecide'
 * write access (same as decideMonthlyHours); returns enriched rows ready
 * for the front-end review table (workerName, clientName, site, month, hours
 * summary, deployment id, entry id so the decider can Approve/Reject in one
 * click without opening the full detail page first).
 */
export async function getPendingHoursQueue(actor) {
  const allowed = await canAccessSection('deploymentsHoursDecide', actor);
  if (!allowed && actor.role !== 'Admin') {
    throw new ApiError(403, 'You do not have permission to view the hours approval queue.');
  }
  const deployments = await Deployment.find({
    'monthlyHours.status': 'Pending',
  })
    .select('workerName clientName site workerType monthlyHours mobilisation')
    .populate('mobilisation')
    .lean();

  const rows = [];
  for (const dep of deployments) {
    for (const entry of dep.monthlyHours) {
      if (entry.status !== 'Pending') continue;
      
      const revExp = computeMonthlyRevenueAndExpenses(entry, dep.mobilisation, dep.monthlyHours);
      
      rows.push({
        deploymentId: dep._id,
        entryId: entry._id,
        workerName: dep.workerName,
        clientName: dep.clientName,
        site: dep.site,
        workerType: dep.workerType,
        month: entry.month,
        contractHours: entry.contractHours,
        actualHours: entry.actualHours,
        supplierHours: entry.supplierHours,
        otHours: entry.otHours,
        otAmount: entry.otAmount,
        deductionAmount: entry.deductionAmount,
        notes: entry.notes,
        enteredAt: entry.createdAt,
        revenue: revExp ? revExp.revenue : null,
        profit: revExp ? revExp.profit : null,
        profitBreakdown: revExp ? revExp.breakdown : null,
      });
    }
  }
  // Newest entry first
  rows.sort((a, b) => new Date(b.enteredAt) - new Date(a.enteredAt));
  return rows;
}

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

/** OT hours — the real formula depends on worker type (2026-09-19, the
 *  user's own ask): a SupplierEmployee deployment has a real subcontractor
 *  keeping their OWN timesheet, which can legitimately differ from the
 *  client's (`actualHours`), so OT there is Client hours minus Supplier
 *  hours, floored at 0 (same safety net the original formula already had —
 *  never a negative OT figure). Employee/Freelancer have no such second
 *  timesheet at all, so they keep the original formula against the
 *  deployment's own contracted hours, unchanged. */
function computeOtHours(workerType, actualHours, supplierHours, contractHours) {
  if (workerType === 'SupplierEmployee') {
    return Math.max(0, actualHours - (supplierHours ?? 0));
  }
  return Math.max(0, actualHours - contractHours);
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

/** How many real calendar days of `month` this deployment actually
 *  covered — accounts for a deployment that started or ended mid-month
 *  (`endDate` is the inclusive last real day: the demobilisation date
 *  itself is still a placement day). Reused by the days-worked sanity
 *  check below. */
function realPlacementDaysInMonth(deployment, month) {
  const total = daysInMonth(month);
  const firstDay = month === monthStrOf(deployment.startDate) ? new Date(deployment.startDate).getDate() : 1;
  const lastDay =
    deployment.endDate && month === monthStrOf(deployment.endDate) ? new Date(deployment.endDate).getDate() : total;
  return lastDay - firstDay + 1;
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
 * Correct a deployment's own recorded details (2026-09-16, the user's own
 * ask) — gated by the 'deploymentsEdit' Section Access key (Admin-only until
 * granted; MM granted write immediately per the user's own instruction, see
 * src/scripts/grant-deployments-edit.js). No Office Secretary bypass here —
 * unlike hours entry, this was never one of her hardcoded business-rule
 * exceptions; access is purely through the Section Access grant.
 *
 * Scope is deliberately narrow — see updateDeploymentSchema's own doc
 * comment for exactly which fields this can and can't touch and why. Works
 * regardless of `status` (Active or Ended) — fixing a typo on an already-
 * ended placement is just as legitimate as on a live one, and this never
 * touches the lifecycle fields Demobilise owns.
 */
export async function updateDeployment(deploymentId, data, actor) {
  const allowed = await canAccessSection('deploymentsEdit', actor);
  if (!allowed) throw new ApiError(403, 'You do not have permission to edit this deployment.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  await assertEmployeeVisibleToActor(deployment.worker, actor);

  const before = {
    site: deployment.site,
    workerName: deployment.workerName,
    requiredTimesheetHours: deployment.requiredTimesheetHours,
    notes: deployment.notes,
  };
  if (data.site !== undefined) deployment.site = data.site;
  if (data.workerName !== undefined) deployment.workerName = data.workerName;
  if (data.requiredTimesheetHours !== undefined) deployment.requiredTimesheetHours = data.requiredTimesheetHours;
  if (data.notes !== undefined) deployment.notes = data.notes;
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: 'deployment.update',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: {
      before,
      after: {
        site: deployment.site,
        workerName: deployment.workerName,
        requiredTimesheetHours: deployment.requiredTimesheetHours,
        notes: deployment.notes,
      },
    },
    ip: actor.ip,
  });
  return deployment.toObject();
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
  // Fixed 2026-09-16 (the user's own ask): waiting for the real calendar
  // month to elapse only makes sense for a worker STILL mobilised that
  // month — an Ended deployment is already history, so every month from
  // its start through its own real end is fair game immediately, even the
  // current still-in-progress calendar month. (Originally fixed
  // 2026-09-14 — F5 — to at least allow the FINAL month once it had
  // elapsed; this widens that to not need elapsing at all once Ended.)
  if (deployment.status === 'Active') {
    if (data.month >= currentMonthStr()) {
      throw new ApiError(400, 'You can only enter hours for a month that has already ended.');
    }
  } else {
    const endMonth = deployment.endDate ? monthStrOf(deployment.endDate) : null;
    if (!endMonth || data.month > endMonth) {
      throw new ApiError(400, "Only a month within this deployment's actual placement dates can have hours entered.");
    }
  }
  if (data.month < monthStrOf(deployment.startDate)) {
    throw new ApiError(400, 'This deployment had not started yet in that month.');
  }
  // Supplier timesheet hours are required for a SupplierEmployee deployment
  // (the new OT formula needs them) and simply not applicable otherwise —
  // see computeOtHours/deployment.model.js's own doc comment.
  if (deployment.workerType === 'SupplierEmployee' && data.supplierHours == null) {
    throw new ApiError(400, 'Enter the supplier timesheet hours.');
  }

  const contractHours = deployment.requiredTimesheetHours ?? 0;
  const actualHours = data.actualHours;
  const supplierHours = deployment.workerType === 'SupplierEmployee' ? data.supplierHours : null;
  const otHours = computeOtHours(deployment.workerType, actualHours, supplierHours, contractHours);
  const otAmount = await computeOtAmount(deployment.mobilisation, otHours);
  const newEntry = {
    month: data.month,
    contractHours,
    actualHours,
    supplierHours,
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
  const isAdmin = actor.role === 'Admin';
  if (entry.status === 'Approved' && !isAdmin) {
    throw new ApiError(400, 'This month is already approved and can no longer be edited by non-administrators.');
  }
  if (deployment.workerType === 'SupplierEmployee' && data.supplierHours == null) {
    throw new ApiError(400, 'Enter the supplier timesheet hours.');
  }
  const wasRejected = entry.status === 'Rejected';
  const wasApproved = entry.status === 'Approved';
  const before = {
    actualHours: entry.actualHours,
    supplierHours: entry.supplierHours,
    otAmount: entry.otAmount,
    deductionAmount: entry.deductionAmount,
    notes: entry.notes,
  };
  const previousEnteredBy = entry.enteredBy.toString();

  const actualHours = data.actualHours;
  const supplierHours = deployment.workerType === 'SupplierEmployee' ? data.supplierHours : null;
  // A legacy entry's own real dailyHours breakdown (see deployment.model.js)
  // stays visible exactly as originally entered UNTIL it's actually
  // corrected — the moment someone edits it, the new totals-only shape
  // (2026-09-16, the user's own ask) is now the entry's real data, so the
  // old per-day array is cleared rather than left stale/inconsistent next
  // to numbers that no longer match it.
  entry.dailyHours = [];
  entry.actualHours = actualHours;
  entry.supplierHours = supplierHours;
  entry.otHours = computeOtHours(deployment.workerType, actualHours, supplierHours, entry.contractHours);
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
      after: {
        actualHours: entry.actualHours,
        supplierHours: entry.supplierHours,
        otAmount: entry.otAmount,
        deductionAmount: entry.deductionAmount,
        notes: entry.notes,
      },
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
  // Fixed 2026-09-17, a follow-up QA-audit gap: addMonthlyHours/
  // updateMonthlyHours both already carry this same team-ownership check
  // (see their own 2026-09-15 fix comments) — this sibling was missed, so a
  // Coordinator granted 'deploymentsHoursDecide' could decide a foreign
  // team's entry. A no-op for any non-Coordinator role.
  await assertEmployeeVisibleToActor(deployment.worker, actor);
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

  // 2026-09-27 follow-up, the user's own ask: the Clerk shouldn't have to go
  // looking for newly-Approved months to invoice — notify the moment hours
  // clear this step.
  if (data.decision === 'Approved') {
    const clerks = await decidersOfDeploymentsInvoicing();
    for (const userId of clerks) {
      await notifyUser(userId, {
        type: 'RequestStatus',
        title: `${entry.month} hours ready to invoice for ${deployment.workerName}`,
        body: `${deployment.clientName} — approved and ready for a client invoice.`,
        url: `/deployments/${deployment._id}`,
      });
    }
  }
  return deployment.toObject();
}

const INVOICE_DUE_DAYS = 50;

/** Same shape, against 'deploymentsInvoicing' — the "Clerk" circle. */
async function decidersOfDeploymentsInvoicing() {
  const settings = await getSectionAccess('deploymentsInvoicing');
  return membersOfRoles(settings.writeApprovalRoles);
}

/**
 * Who should see/be nudged about an invoiced-but-not-yet-paid month:
 * every coordinator on the source Mobilisation (they own the client
 * relationship — "mainly coordinators", the user's own words) plus whoever
 * holds 'mobilisationsViewer' write (this company's real MM already does —
 * reused rather than a new Section Access key just for this, same
 * broad-visibility circle management already sees commercial data through).
 */
async function paymentTrackingAudience(mobilisationId) {
  const [mobilisation, mmSettings] = await Promise.all([
    Mobilisation.findById(mobilisationId).select('coordinators').lean(),
    getSectionAccess('mobilisationsViewer'),
  ]);
  const coordinatorIds = (mobilisation?.coordinators ?? []).map((c) => c.user.toString());
  const mmIds = await membersOfRoles(mmSettings.writeApprovalRoles);
  return [...new Set([...coordinatorIds, ...mmIds.map((id) => id.toString())])];
}

function invoiceFileFromUpload(file) {
  return {
    fileName: file.filename, // Cloudinary public_id, set by uploadSingle
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

/**
 * Mark a month's Approved hours entry as invoiced to the client — the
 * "Clerk" step of the real billing process the user described. Records the
 * real invoice's own identity (number/date, typed off the actual document
 * ERPNext generates) plus a reference copy of the PDF — this app never
 * generates the invoice itself. No separate "billed amount" field — see the
 * model's own doc comment on why there's no stored copy of that number.
 */
export async function sendInvoice(deploymentId, entryId, data, file, actor) {
  const allowed = await canAccessSection('deploymentsInvoicing', actor);
  if (!allowed) throw new ApiError(403, 'You do not have permission to send a client invoice.');
  if (!file) throw new ApiError(400, 'A copy of the invoice PDF is required.');

  const deployment = await Deployment.findById(deploymentId);
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  await assertEmployeeVisibleToActor(deployment.worker, actor);
  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');
  if (entry.status !== 'Approved') {
    throw new ApiError(400, 'Only hours already approved can be invoiced.');
  }
  if (entry.invoiceSentAt) {
    throw new ApiError(400, 'This month has already been invoiced.');
  }

  const now = new Date();
  entry.invoiceSentAt = now;
  entry.invoiceSentBy = actor.userId;
  entry.invoiceDueAt = new Date(now.getTime() + INVOICE_DUE_DAYS * 86_400_000);
  entry.invoiceNumber = data.invoiceNumber;
  entry.invoiceDate = data.invoiceDate;
  entry.invoiceFile = invoiceFileFromUpload(file);
  await deployment.save();

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.invoiceSent',
    targetType: 'Deployment',
    targetId: deployment._id,
    meta: { month: entry.month, invoiceNumber: data.invoiceNumber },
    ip: actor.ip,
  });

  const audience = await paymentTrackingAudience(deployment.mobilisation);
  for (const userId of audience) {
    await notifyUser(userId, {
      type: 'RequestStatus',
      title: `Invoice ${data.invoiceNumber} sent for ${deployment.workerName} (${entry.month})`,
      body: `${deployment.clientName} — payment due by ${entry.invoiceDueAt.toDateString()}.`,
      url: `/deployments/payments-due`,
    });
  }
  return deployment.toObject();
}

/** The uploaded invoice-copy file for one entry — a signed, time-limited
 *  download URL, same pattern as reimbursement.service.js's getReceiptFile. */
export async function getInvoiceFile(deploymentId, entryId, actor) {
  const deployment = await Deployment.findById(deploymentId).lean();
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  await assertEmployeeVisibleToActor(deployment.worker, actor);
  const entry = deployment.monthlyHours.find((m) => m._id.toString() === entryId);
  if (!entry || !entry.invoiceFile) throw new ApiError(404, 'No invoice file for this month.');
  return {
    url: signedDownloadUrl(entry.invoiceFile.fileName, entry.invoiceFile.resourceType),
    mimeType: entry.invoiceFile.mimeType,
    originalName: entry.invoiceFile.originalName,
  };
}

/**
 * Every invoiced monthly-hours entry for one client, across every
 * Deployment they have, priced (via computeMonthlyRevenueAndExpenses) but
 * NOT yet matched against payments — the raw material
 * clientPayment.service.js's allocateClientPayments needs. Kept private:
 * every real caller below wants the ALLOCATED result, not this raw list on
 * its own.
 */
async function gatherClientInvoicedItems(clientId) {
  const deployments = await Deployment.find({ client: clientId, archived: { $ne: true } })
    .select('workerName subcontractorName monthlyHours mobilisation')
    .populate('mobilisation', PROFIT_RATE_FIELDS)
    .lean();

  const items = [];
  for (const dep of deployments) {
    if (!dep.mobilisation) continue;
    for (const entry of dep.monthlyHours) {
      if (!entry.invoiceSentAt) continue;
      const result = computeMonthlyRevenueAndExpenses(entry, dep.mobilisation, dep.monthlyHours);
      if (!result) continue;
      items.push({
        deploymentId: dep._id,
        entryId: entry._id,
        workerName: dep.workerName,
        subcontractorName: dep.subcontractorName,
        month: entry.month,
        invoiceNumber: entry.invoiceNumber,
        invoiceDate: entry.invoiceDate,
        invoiceSentAt: entry.invoiceSentAt,
        invoiceDueAt: entry.invoiceDueAt,
        revenue: result.revenue,
      });
    }
  }
  return items;
}

/** Gather + allocate in one call — every real caller below wants both.
 *  Exported for mobilisationTarget.service.js's own real-revenue crediting
 *  (an existing one-directional dependency, unchanged direction — that
 *  module already imports computeMonthlyRevenueAndExpenses from here). */
export async function getClientAllocation(clientId) {
  const items = await gatherClientInvoicedItems(clientId);
  return allocateClientPayments(clientId, items);
}

/**
 * The "Payments Due" list, one row per CLIENT with at least one outstanding
 * invoice (2026-09-27 redesign, the user's own correction: a client pays in
 * bulk for everyone placed there, never per worker — see
 * clientPayment.service.js's own doc comment for the full reasoning).
 * Visibility: a Coordinator sees only clients where they coordinate at
 * least one of the deployments behind an outstanding invoice; anyone with
 * 'mobilisationsViewer' read (this company's real MM already holds it,
 * plus Admin) sees every client. `subcontractorNames` is a display filter
 * only (the client-side "filter by supplier" ask) — the bulk payment
 * itself is always client-scoped, confirmed with the user directly; it is
 * NOT a second aggregation level. Sorted soonest-due first.
 */
export async function getClientsPaymentSummary(actor) {
  const canViewAll = await canAccessSection('mobilisationsViewer', actor, 'read');

  const deployments = await Deployment.find({
    archived: { $ne: true },
    monthlyHours: { $elemMatch: { invoiceSentAt: { $ne: null } } },
  })
    .select('client clientName subcontractorName mobilisation')
    .populate('mobilisation', 'coordinators')
    .lean();

  const byClient = new Map();
  for (const dep of deployments) {
    if (!dep.mobilisation) continue;
    const isMine = dep.mobilisation.coordinators?.some((c) => c.user.toString() === actor.userId.toString());
    if (!canViewAll && !isMine) continue;
    const key = dep.client.toString();
    if (!byClient.has(key)) byClient.set(key, { clientId: dep.client, clientName: dep.clientName, subcontractorNames: new Set() });
    if (dep.subcontractorName) byClient.get(key).subcontractorNames.add(dep.subcontractorName);
  }

  const rows = [];
  for (const [, info] of byClient) {
    const { perEntry } = await getClientAllocation(info.clientId);
    const outstanding = perEntry.filter((e) => e.balanceDue > 0);
    if (outstanding.length === 0) continue;
    const oldestDueAt = outstanding.reduce(
      (min, e) => (!min || new Date(e.invoiceDueAt) < new Date(min) ? e.invoiceDueAt : min),
      null
    );
    rows.push({
      clientId: info.clientId,
      clientName: info.clientName,
      subcontractorNames: [...info.subcontractorNames],
      totalOutstanding: money(outstanding.reduce((sum, e) => sum + e.balanceDue, 0)),
      outstandingCount: outstanding.length,
      oldestDueAt,
      daysRemaining: oldestDueAt ? Math.ceil((new Date(oldestDueAt).getTime() - Date.now()) / 86_400_000) : null,
    });
  }
  return rows.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
}

/**
 * The dashboard's "Payments due soon" row (same visibility as
 * getClientsPaymentSummary above, reused rather than duplicated) — "soon"
 * mirrors deploymentBilling.job.js's own PRE_DUE_MILESTONES window
 * (escalation reminders start at 10 days remaining), so this count only
 * ever moves in step with when a coordinator/MM actually starts getting
 * nagged about it.
 */
export async function countPaymentsDueSoon(actor) {
  const rows = await getClientsPaymentSummary(actor);
  return rows.filter((r) => r.daysRemaining != null && r.daysRemaining <= 10).length;
}

/**
 * One client's full billing picture for the Payments Due page's drill-down
 * — every outstanding (and already-settled) invoice with its real
 * allocation, plus the client's real payment history
 * (Pending/Approved/Rejected). Same visibility rule as
 * getClientsPaymentSummary, enforced per-client here since this is reached
 * directly by id, not just filtered out of a list.
 */
export async function getClientPaymentDetail(clientId, actor) {
  const canViewAll = await canAccessSection('mobilisationsViewer', actor, 'read');
  if (!canViewAll) {
    const deployments = await Deployment.find({ client: clientId, archived: { $ne: true } })
      .select('mobilisation')
      .populate('mobilisation', 'coordinators')
      .lean();
    const isMine = deployments.some((dep) => dep.mobilisation?.coordinators?.some((c) => c.user.toString() === actor.userId.toString()));
    if (!isMine) throw new ApiError(403, 'You do not have permission to view this client’s payments.');
  }

  const client = await Client.findById(clientId).select('companyName').lean();
  if (!client) throw new ApiError(404, 'Client not found.');

  const [{ perEntry, creditBalance }, payments] = await Promise.all([
    getClientAllocation(clientId),
    getClientPaymentHistory(clientId),
  ]);

  return {
    clientId,
    clientName: client.companyName,
    creditBalance,
    invoices: perEntry.sort((a, b) => new Date(b.invoiceSentAt) - new Date(a.invoiceSentAt)),
    payments,
  };
}

/**
 * Every Approved-but-not-yet-invoiced monthly-hours entry across every
 * Deployment — the Clerk's own "Ready to Invoice" queue (2026-09-27, moved
 * out of hunting through individual Deployment detail pages into its own
 * home under Financial, the user's own ask). Visibility is deliberately
 * different from getClientsPaymentSummary's own coordinator-own/
 * mobilisationsViewer split: a coordinator never invoices their own
 * placements, so they get no view here at all — only whoever holds
 * `deploymentsInvoicing` read (the
 * Clerk) or `mobilisationsViewer` read (MM/Admin oversight), the people who
 * actually act on this queue. Sorted oldest-approved-first, so the month
 * that's been waiting longest leads.
 */
export async function getReadyToInvoice(actor) {
  const allowed =
    (await canAccessSection('deploymentsInvoicing', actor, 'read')) ||
    (await canAccessSection('mobilisationsViewer', actor, 'read'));
  if (!allowed) return [];

  const deployments = await Deployment.find({
    archived: { $ne: true },
    monthlyHours: { $elemMatch: { status: 'Approved', invoiceSentAt: null } },
  })
    .select('workerName clientName mobilisation monthlyHours')
    .populate('mobilisation', 'serialNumber')
    .lean();

  const rows = [];
  for (const dep of deployments) {
    for (const entry of dep.monthlyHours) {
      if (entry.status !== 'Approved' || entry.invoiceSentAt) continue;
      rows.push({
        deploymentId: dep._id,
        entryId: entry._id,
        mobilisationSerial: dep.mobilisation?.serialNumber,
        workerName: dep.workerName,
        clientName: dep.clientName,
        month: entry.month,
        actualHours: entry.actualHours,
        hoursApprovedAt: entry.decidedAt,
      });
    }
  }
  return rows.sort((a, b) => new Date(a.hoursApprovedAt) - new Date(b.hoursApprovedAt));
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
    { $match: { workerType: { $ne: 'Employee' }, iqamaNumber: { $ne: null }, archived: { $ne: true } } },
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
      subcontractor: m.subcontractor ?? null,
      subcontractorName: m.subcontractorName ?? null,
      lastClientName: m.clientName,
      lastEndDate: ended?.endDate ?? null,
      lastEndReason: ended?.endReason ?? null,
    };
  });

  return { ownEmployees, subcontractedWorkers };
}

// Every Mobilisation field the Overview modal/Excel export show
// (2026-09-17, the user's own ask — "need every single data entered in
// mobilisation" surfaced in the register's own Overview, not just this
// deployment's own snapshot fields). Mirrors mobilisation.export.js's own
// WORKER_COLUMNS + RATE_COLUMNS field list exactly — the set that module
// already treats as export-worthy — MINUS whatever's a pure duplicate of a
// field Deployment already snapshots (workerName/workerType/clientName/
// subcontractorName/site/requiredTimesheetHours/mobilisationDate, the last
// being byte-for-byte Deployment.startDate — see deployment.model.js's own
// doc comment). `coordinators`/`documents`/the quotation-PO reference fields/
// `remark` are deliberately left out too — mobilisation.export.js's own
// established column list already excludes them, so this stays consistent
// with what THIS app already calls "the exportable mobilisation data",
// rather than inventing a broader definition just for this view.
const MOBILISATION_OVERVIEW_FIELDS =
  'serialNumber jobTitle iqamaNumber nationality phone checkoutDate fta ftaType allowance allowanceRemark ' +
  'clientRate clientCommission mobilisationCost subcontractorRate subcontractorCommission ' +
  'otClientRate otEmployeeRate profitPerHour profitPerMonth otProfitPerHour';

// The commercial subset of the above — stripped from the populated
// `mobilisation` sub-object for anyone without 'deploymentsHoursDecide' read
// access, same sensitivity class and same gate as otAmount/profit elsewhere
// in this file (see stripCommercialMonthlyHours/getDeployment). Never trust
// the client, and never even send what an unauthorized viewer shouldn't have.
const MOBILISATION_COMMERCIAL_KEYS = [
  'clientRate',
  'clientCommission',
  'mobilisationCost',
  'subcontractorRate',
  'subcontractorCommission',
  'otClientRate',
  'otEmployeeRate',
  'profitPerHour',
  'profitPerMonth',
  'otProfitPerHour',
];

function stripMobilisationCommercial(mobilisation) {
  if (!mobilisation) return mobilisation;
  const clean = { ...mobilisation };
  for (const key of MOBILISATION_COMMERCIAL_KEYS) delete clean[key];
  return clean;
}

/** Shared by listDeployments and exportDeployments — the actual filter/
 *  visibility/commercial-stripping logic neither should duplicate, same
 *  "one real query builder, callers just differ on pagination" convention
 *  mobilisation.service.js's own findVisibleMobilisations already follows. */
async function findDeployments({ worker, client, site, status, sortBy = 'startDate', sortOrder }, actor, { skip, limit } = {}) {
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: `?worker=` accepted
  // any employee id with no ownership check, unlike the single-record read
  // right below (getDeployment) — a Coordinator could pull a foreign
  // employee's whole placement history through the list filter even though
  // opening one of those deployments directly correctly 403s. A no-op for
  // any non-Coordinator role.
  if (worker) await assertEmployeeVisibleToActor(worker, actor);
  const filter = { archived: { $ne: true } };
  if (worker) filter.worker = worker;
  if (client) filter.client = client;
  if (status) filter.status = status;
  if (site) filter.site = { $regex: site, $options: 'i' };
  // Fixed 2026-09-17, a follow-up QA-audit gap: the check above only ever
  // fired when the caller explicitly passed `?worker=`. The plain,
  // unfiltered list/export (the normal way the register page is opened)
  // built no ownership condition at all, so a Coordinator saw every team's
  // deployments.
  //
  // Scoped by `Mobilisation.coordinators.user` (2026-09-21), not
  // `Employee.coordinator` — confirmed correct, not a regression, on review
  // 2026-09-22: `Employee.coordinator` is itself now fully DERIVED from
  // Mobilisation state (see mobilisation.service.js's own doc comment on
  // `primaryIsCoordinator`) and only ever holds the PRIMARY coordinator of
  // whichever mobilisation most recently claimed that employee — so scoping
  // here by the deployment's own originating mobilisation is strictly more
  // correct: it includes every JOINT coordinator (Employee.coordinator never
  // did), and a coordinator keeps seeing a past deployment they actually
  // worked even after the employee is later reassigned to someone else.
  // This is also what finally gives a SupplierEmployee/Freelancer deployment
  // (no linked Employee, so `Employee.coordinator` could never scope it at
  // all) real scoping instead of being unconditionally visible to every
  // Coordinator, which is what the removed `{ worker: null }` branch used to
  // paper over.
  if (actor?.role === 'Coordinator') {
    const Mobilisation = (await import('../mobilisations/mobilisation.model.js')).default;
    const myMobIds = await Mobilisation.find({ 'coordinators.user': actor.userId }).distinct('_id');
    filter.mobilisation = { $in: myMobIds };
  }

  // Map UI sort-field names to real Mongo field names.
  const SORT_FIELD_MAP = { startDate: 'startDate', workerName: 'workerName', clientName: 'clientName', site: 'site', status: 'status' };
  const sortField = SORT_FIELD_MAP[sortBy] ?? 'startDate';
  const dir = sortOrder === 'asc' ? 1 : -1;
  const sort = { [sortField]: dir, _id: -1 };
  let query = Deployment.find(filter).sort(sort);
  if (skip) query = query.skip(skip);
  if (limit) query = query.limit(limit);
  const [items, total] = await Promise.all([
    query
      .populate('worker', 'fullName employeeId')
      .populate('mobilisation', MOBILISATION_OVERVIEW_FIELDS)
      .lean(),
    Deployment.countDocuments(filter),
  ]);
  // otAmount/mobilisation's own commercial fields are both commercial data
  // (see getDeployment's own doc comment) — this list isn't currently
  // rendered anywhere but the Overview modal/Excel export, but never send
  // either to a non-decider regardless, same "never even send it" rule as
  // the single-record read.
  // 'read' — see the sibling comment in updateMonthlyHours above.
  const canSeeCommercial = actor ? await canAccessSection('deploymentsHoursDecide', actor, 'read') : false;
  const strippedItems = canSeeCommercial
    ? items
    : items.map((d) => ({
        ...d,
        monthlyHours: d.monthlyHours.map(({ otAmount, ...rest }) => rest),
        mobilisation: stripMobilisationCommercial(d.mobilisation),
      }));
  return { items: strippedItems, total };
}

/**
 * List deployments (the register / a worker's history / a client's placements).
 * Filters: worker, client, status. Worker/mobilisation are populated for display.
 */
export async function listDeployments({ page, limit, ...filters }, actor) {
  const { items, total } = await findDeployments(filters, actor, { skip: (page - 1) * limit, limit });
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

// A sanity bound, not a real pagination need at this company's actual
// scale — same value/reasoning as mobilisation.service.js's own
// EXPORT_MAX_ROWS.
const DEPLOYMENT_EXPORT_MAX_ROWS = 5000;

/** Every deployment matching the caller's current filters/visibility, one
 *  row each, no pagination — for the downloadable Excel workbook
 *  (deployment.export.js). */
export async function exportDeployments(filters, actor) {
  const { items } = await findDeployments(filters, actor, { limit: DEPLOYMENT_EXPORT_MAX_ROWS });
  return items;
}

/**
 * Real revenue/expenses/profit for one already-entered month — same shape as
 * Mobilisation's own computeProfitFields (server/src/modules/mobilisations/
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
/** The one-time Mobilisation.mobilisationCost (2026-09-19, the user's own
 *  ask) is deducted exactly once per deployment — from whichever monthly
 *  entry is chronologically the FIRST one actually APPROVED (by
 *  `decidedAt`), not necessarily calendar month 1 or the first one entered:
 *  backlog data can be entered/approved out of month order, and this must
 *  never double-deduct or land on the wrong month just because of entry
 *  order. Returns null when nothing is Approved yet — nothing to anchor the
 *  one-time deduction to. */
function firstApprovedEntryId(entries) {
  const approved = entries.filter((e) => e.status === 'Approved' && e.decidedAt);
  if (!approved.length) return null;
  return approved.reduce((earliest, e) => (new Date(e.decidedAt) < new Date(earliest.decidedAt) ? e : earliest))._id?.toString();
}

/**
 * Renamed from computeMonthlyProfit (2026-09-24, a real user ask — the
 * dashboard's new "Actual Performance" section needs real Revenue/Expenses,
 * not just their already-netted difference) — this is a DECOMPOSITION, not a
 * new formula: `profit` below is algebraically identical to the original
 * function's own return value (verified against real dev data — see
 * docs/DEPLOYMENT-notes.md's 2026-09-24 follow-up), just now built from two
 * named parts instead of one combined expression, so both this module's
 * existing per-entry profit display (getDeployment, below — reads `.profit`
 * only, unchanged behavior) and the new dashboard aggregate
 * (getActualPerformanceSummary — reads `.revenue`/`.expenses`) share the
 * exact same formula. No caller may ever compute Revenue/Expenses a second,
 * independent way — that's how a figure like this quietly drifts.
 *
 *   revenue  = clientRate × contractHours + otClientRate × otHours — the pure
 *              amount billed to the client, never netted against any cost.
 *   expenses = clientCommission × contractHours
 *            + (SupplierEmployee only) (subcontractorRate + subcontractorCommission) × contractHours
 *            + fta + allowance
 *            + otEmployeeRate × otHours
 *            + entry.deductionAmount
 *            + (this deployment's chronologically-first-Approved entry only) mobilisationCost
 *   profit   = revenue − expenses, always.
 */
export function computeMonthlyRevenueAndExpenses(entry, mobilisation, allEntries) {
  if (!mobilisation) return null;
  const isSupplier = mobilisation.workerType === 'SupplierEmployee';

  // The regular hours billed to the client is the total actual hours minus any OT hours.
  const regularClientHours = Math.max(0, entry.actualHours - entry.otHours);
  const clientInvoiceAmount = money(
    (mobilisation.clientRate ?? 0) * regularClientHours + 
    (mobilisation.otClientRate ?? 0) * entry.otHours
  );

  const revenue = clientInvoiceAmount;

  // The regular hours billed by the subcontractor is their timesheet minus the worker's OT hours
  // (Since OT is handled separately at otEmployeeRate).
  const regularSupplierHours = isSupplier ? Math.max(0, (entry.supplierHours ?? 0) - entry.otHours) : 0;
  const subSide = isSupplier ? (mobilisation.subcontractorRate ?? 0) + (mobilisation.subcontractorCommission ?? 0) : 0;
  
  const subContractorInvoiceAmount = isSupplier ? money(subSide * regularSupplierHours) : 0;

  const isFirstApprovedEntry =
    Array.isArray(allEntries) && entry.status === 'Approved' && entry._id?.toString() === firstApprovedEntryId(allEntries);
  const mobilisationCostDeduction = isFirstApprovedEntry ? mobilisation.mobilisationCost ?? 0 : 0;

  const expenseClientCommission = money((mobilisation.clientCommission ?? 0) * regularClientHours);
  const expenseFta = money(mobilisation.fta ?? 0);
  const expenseAllowance = money(mobilisation.allowance ?? 0);
  const otCalculations = money((mobilisation.otEmployeeRate ?? 0) * entry.otHours);
  const expenseDeduction = money(entry.deductionAmount ?? 0);
  
  const expenses = money(
    expenseClientCommission +
      subContractorInvoiceAmount +
      expenseFta +
      expenseAllowance +
      otCalculations +
      expenseDeduction +
      mobilisationCostDeduction
  );

  const breakdown = {
    clientInvoiceAmount,
    subContractorInvoiceAmount,
    otCalculations,
    expenseClientCommission,
    expenseFta,
    expenseAllowance,
    expenseDeduction,
    expenseMobilisationCost: mobilisationCostDeduction,
  };

  return { revenue, expenses, profit: money(revenue - expenses), breakdown };
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
  const byEmployee = await deductionsForEmployeesMonth([employeeId], monthStr);
  return byEmployee.get(String(employeeId)) ?? [];
}

/**
 * The batched form of deductionsForEmployeeMonth above — every eligible
 * employee's deductions for one month in ONE query instead of one query per
 * employee (2026-09-22, a real QA-audit finding — P4: reproduced at 494ms/10
 * employees and 4.7s/100 employees, entirely from three per-employee reads,
 * including this one, run sequentially). payroll.service.js's
 * createPayrollRun is the real caller — deductionsForEmployeeMonth above
 * stays as the single-employee convenience form (a $in of one id costs
 * nothing extra), kept for any future single-employee use.
 * Returns a Map keyed by employee id (string) → that employee's deduction
 * list (possibly empty — never a missing key, so a caller can `.get(id) ??
 * []` without a fallback check).
 */
export async function deductionsForEmployeesMonth(employeeIds, monthStr) {
  const deployments = await Deployment.find({
    worker: { $in: employeeIds },
    monthlyHours: { $elemMatch: { month: monthStr, deductionAmount: { $gt: 0 }, status: 'Approved' } },
  })
    .select('worker clientName monthlyHours')
    .lean();

  const byEmployee = new Map(employeeIds.map((id) => [String(id), []]));
  for (const deployment of deployments) {
    const entry = deployment.monthlyHours.find(
      (m) => m.month === monthStr && m.deductionAmount > 0 && m.status === 'Approved'
    );
    if (entry) {
      byEmployee.get(String(deployment.worker))?.push({ label: `Client deduction — ${deployment.clientName} (${monthStr})`, amount: entry.deductionAmount });
    }
  }
  return byEmployee;
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

export const PROFIT_RATE_FIELDS =
  'serialNumber workerType clientRate clientCommission subcontractorRate subcontractorCommission ' +
  'otClientRate otEmployeeRate fta allowance mobilisationCost';

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
  // How much of THIS entry's invoice has actually been paid (2026-09-27
  // bulk-payment redesign) — same visibility tier `amountReceived` had
  // before this redesign (never commercial-gated: whoever can see billing
  // at all, e.g. Office Secretary/Clerk, needs to know a balance without
  // needing deploymentsHoursDecide). Computed once per read, only when
  // there's actually an invoiced entry to allocate against.
  const hasInvoiced = deployment.monthlyHours.some((e) => e.invoiceSentAt);
  const allocationByEntryId = new Map();
  if (hasInvoiced) {
    const { perEntry } = await getClientAllocation(deployment.client);
    for (const e of perEntry) allocationByEntryId.set(e.entryId.toString(), e);
  }
  deployment.monthlyHours = deployment.monthlyHours.map((entry) => {
    const alloc = entry.invoiceSentAt ? allocationByEntryId.get(entry._id.toString()) : null;
    const withBilling = alloc
      ? { ...entry, amountAllocated: alloc.amountAllocated, balanceDue: alloc.balanceDue, fullyPaid: alloc.fullyPaid }
      : entry;
    if (canSeeCommercial) {
      // .revenue/.expenses added 2026-09-24 alongside .profit (unchanged) — for
      // the new per-Deployment Expenses section's own Revenue/Expenses/Profit
      // summary (see DeploymentDetailPage.jsx's own doc comment).
      const revExp = computeMonthlyRevenueAndExpenses(entry, deployment.mobilisation, deployment.monthlyHours);
      return { ...withBilling, profit: revExp ? revExp.profit : null, revenue: revExp ? revExp.revenue : null, expenses: revExp ? revExp.expenses : null };
    }
    const { otAmount, ...rest } = withBilling;
    return rest;
  });
  if (canSeeCommercial) {
    const withProfit = deployment.monthlyHours.filter((e) => e.profit != null);
    // Deliberately UNCHANGED scope (2026-09-24): totalProfit/totalRevenue/
    // totalExpenses sum every entry with a computable figure, any status —
    // same as this field's own pre-existing behavior (byte-identical to the
    // original totalProfit computation), which DeploymentDetailPage.jsx's
    // Monthly Hours section already relies on as a running "everything entered
    // so far" total, not an Approved-only one. The new per-Deployment Expenses
    // section (below, client-side) computes its OWN separate Approved-only
    // figure — plus the linked ad-hoc Expense ledger — rather than silently
    // redefining what this established field means.
    deployment.totalProfit = withProfit.length ? money(withProfit.reduce((sum, e) => sum + e.profit, 0)) : null;
    deployment.totalRevenue = withProfit.length ? money(withProfit.reduce((sum, e) => sum + e.revenue, 0)) : null;
    deployment.totalExpenses = withProfit.length ? money(withProfit.reduce((sum, e) => sum + e.expenses, 0)) : null;
  } else if (deployment.mobilisation) {
    deployment.mobilisation = { _id: deployment.mobilisation._id, serialNumber: deployment.mobilisation.serialNumber };
  }
  return deployment;
}

/** (year, month 1-12) shifted back by `n` months, wrapping across years. */
function shiftMonth(year, month, n) {
  const d = new Date(year, month - 1 - n, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
const monthKeyOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
/** [firstDayOfMonth, firstDayOfNextMonth) as real Dates, for the Expense-ledger
 *  side of getActualPerformanceSummary (Expense.date is a real Date, unlike
 *  Deployment.monthlyHours' plain 'YYYY-MM' string). */
function monthDateBounds(year, month) {
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}
/** Sum of Expense.amount for deployment-linked entries dated within one window
 *  — a plain, separate aggregate per window (not one combined query bucketing
 *  in JS): real data volume here is tiny, and four small, independently
 *  readable queries are far less error-prone than one clever overlapping-range
 *  aggregate — same "don't over-engineer for scale that doesn't exist yet"
 *  call this app's own performance work has made repeatedly. */
async function sumDeploymentExpenses(range) {
  if (!range) return 0;
  const [row] = await Expense.aggregate([
    { $match: { deployment: { $ne: null }, date: { $gte: range.start, $lt: range.end } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row?.total ?? 0;
}
/** null when there's nothing real to compare against — the user's own explicit
 *  ask ("if there is no last year data then do not show anything"). Mirrors
 *  ActiveRevenueWidget.jsx's own already-shipped convention for exactly this
 *  (treating a zero/absent prior value as "nothing to compare"), not a new rule. */
function pctDelta(current, prior) {
  return prior ? Math.round(((current - prior) / prior) * 100) : null;
}

/**
 * "Actual Performance" — real, closed-book Revenue/Expenses/Net Profit built
 * only from APPROVED Deployment monthly-hours entries (never an estimate —
 * see computeMonthlyRevenueAndExpenses's own doc comment), for the dashboard's
 * new section below the existing (estimate-based) Active Mobilisation Revenue
 * card (2026-09-24, a real user ask — see docs/DEPLOYMENT-notes.md's own
 * 2026-09-24 follow-up for the full derivation this mirrors).
 *
 * Two periods, each with a real delta against a real prior baseline:
 *   - "last month" (the most recently fully-elapsed calendar month) vs. the
 *     month before it — same delta convention the existing Active Revenue
 *     card's sparkline already uses.
 *   - "this year" (every closed month so far this calendar year — naturally
 *     excludes the still-open current month, since an entry for it can't
 *     exist yet per the model's own rule) vs. the same relative months of
 *     last year — a fair like-for-like comparison, not a full prior-year total.
 *
 * Expenses = everything computeMonthlyRevenueAndExpenses already treats as a
 * cost, PLUS this deployment's own linked Expense-ledger entries dated in the
 * same window (2026-09-24, the user's own ask for real per-deployment expense
 * tracking — see expense.model.js's pre-existing `deployment` field).
 *
 * Gate: `dashboardProfit` — the SAME Section Access key the existing
 * company-wide (Invoice-based) profit figure already requires, not a new
 * permission tier. Checked by the CALLER (dashboard.service.js's own already-
 * batched `mySectionAccess`/`canSeeProfit`), not here — this file's own
 * sibling functions (computeActiveMobilisationRevenue/-Trend) follow the same
 * convention, and a redundant internal `canAccessSection` call here would
 * reintroduce the exact per-function-read-gate pattern the 2026-09-22 P3 fix
 * removed everywhere else on the dashboard (see dashboard.service.js's own
 * top-of-file doc comment).
 *
 * Batched: one Deployment fetch across the whole date window needed (at most
 * ~2 years of month keys) plus four small Expense sums — not one query per
 * deployment, matching this file's own established performance discipline.
 */
export async function getActualPerformanceSummary() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthNum = now.getMonth() + 1;

  const lastMonth = shiftMonth(currentYear, currentMonthNum, 1);
  const monthBeforeLast = shiftMonth(currentYear, currentMonthNum, 2);
  const lastMonthKey = monthKeyOf(lastMonth.year, lastMonth.month);
  const monthBeforeLastKey = monthKeyOf(monthBeforeLast.year, monthBeforeLast.month);

  // Every CLOSED month so far this calendar year — empty in January (no closed
  // month in the current year exists yet), never includes the still-open
  // current month.
  const thisYearMonths = [];
  for (let m = 1; m < currentMonthNum; m++) thisYearMonths.push(monthKeyOf(currentYear, m));
  const sameMonthsLastYear = thisYearMonths.map((mk) => {
    const [y, m] = mk.split('-').map(Number);
    return monthKeyOf(y - 1, m);
  });

  const relevantMonthKeys = new Set([lastMonthKey, monthBeforeLastKey, ...thisYearMonths, ...sameMonthsLastYear]);

  const [deployments, lastMonthExp, monthBeforeLastExp, thisYearExp, sameMonthsLastYearExp] = await Promise.all([
    Deployment.find({ monthlyHours: { $elemMatch: { status: 'Approved', month: { $in: [...relevantMonthKeys] } } } })
      .select('client monthlyHours mobilisation')
      .populate('mobilisation', PROFIT_RATE_FIELDS)
      .lean(),
    sumDeploymentExpenses(monthDateBounds(lastMonth.year, lastMonth.month)),
    sumDeploymentExpenses(monthDateBounds(monthBeforeLast.year, monthBeforeLast.month)),
    thisYearMonths.length
      ? sumDeploymentExpenses({ start: new Date(currentYear, 0, 1), end: monthDateBounds(currentYear, currentMonthNum - 1).end })
      : 0,
    thisYearMonths.length
      ? sumDeploymentExpenses({ start: new Date(currentYear - 1, 0, 1), end: monthDateBounds(currentYear - 1, currentMonthNum - 1).end })
      : 0,
  ]);

  // 2026-09-27, the user's own redesign: Expenses is a real cost the company
  // incurred (unchanged basis — every Approved entry regardless of payment
  // status, same as before), shown as its own standalone figure rather than
  // netted against a computed-revenue estimate. "Received" is real money a
  // client has actually paid AND a Financial Manager has verified — since
  // the same-day bulk-payment redesign, that's no longer a per-entry typed
  // amount; it's this entry's own live-computed FIFO allocation (see
  // getClientAllocation above / clientPayment.service.js), summed one
  // client at a time so a client's payment history is only ever walked
  // once per client, not once per one of their entries. `netProfit` =
  // amountReceived − expenses (a real cash-in-minus-cost-out figure).
  const zeroBucket = () => ({ expenses: 0, amountReceived: 0 });
  const buckets = { lastMonth: zeroBucket(), monthBeforeLast: zeroBucket(), thisYear: zeroBucket(), sameMonthsLastYear: zeroBucket() };
  const addTo = (bucket, expenses, received) => {
    bucket.expenses += expenses;
    bucket.amountReceived += received;
  };

  const clientIds = [...new Set(deployments.filter((d) => d.mobilisation).map((d) => d.client.toString()))];
  const allocationByClient = new Map(
    await Promise.all(clientIds.map(async (id) => [id, await getClientAllocation(id)]))
  );
  const allocatedByEntryId = new Map();
  for (const { perEntry } of allocationByClient.values()) {
    for (const e of perEntry) allocatedByEntryId.set(e.entryId.toString(), e.amountAllocated);
  }

  for (const dep of deployments) {
    if (!dep.mobilisation) continue;
    for (const entry of dep.monthlyHours) {
      if (entry.status !== 'Approved' || !relevantMonthKeys.has(entry.month)) continue;
      const result = computeMonthlyRevenueAndExpenses(entry, dep.mobilisation, dep.monthlyHours);
      if (!result) continue;
      const received = entry.invoiceSentAt ? allocatedByEntryId.get(entry._id.toString()) ?? 0 : 0;
      if (entry.month === lastMonthKey) addTo(buckets.lastMonth, 0, received);
      if (entry.month === monthBeforeLastKey) addTo(buckets.monthBeforeLast, 0, received);
      if (thisYearMonths.includes(entry.month)) addTo(buckets.thisYear, 0, received);
      if (sameMonthsLastYear.includes(entry.month)) addTo(buckets.sameMonthsLastYear, 0, received);
    }
  }

  buckets.lastMonth.expenses += lastMonthExp;
  buckets.monthBeforeLast.expenses += monthBeforeLastExp;
  buckets.thisYear.expenses += thisYearExp;
  buckets.sameMonthsLastYear.expenses += sameMonthsLastYearExp;

  const netProfitOf = (b) => money(b.amountReceived - b.expenses);

  const lastMonthNetProfit = netProfitOf(buckets.lastMonth);
  const monthBeforeLastNetProfit = netProfitOf(buckets.monthBeforeLast);
  const thisYearNetProfit = netProfitOf(buckets.thisYear);
  const sameMonthsLastYearNetProfit = netProfitOf(buckets.sameMonthsLastYear);

  return {
    lastMonth: {
      month: lastMonthKey,
      expenses: money(buckets.lastMonth.expenses),
      expensesDeltaPct: pctDelta(buckets.lastMonth.expenses, buckets.monthBeforeLast.expenses),
      amountReceived: money(buckets.lastMonth.amountReceived),
      amountReceivedDeltaPct: pctDelta(buckets.lastMonth.amountReceived, buckets.monthBeforeLast.amountReceived),
      netProfit: lastMonthNetProfit,
      netProfitDeltaPct: pctDelta(lastMonthNetProfit, monthBeforeLastNetProfit),
    },
    thisYear: {
      year: currentYear,
      expenses: money(buckets.thisYear.expenses),
      expensesDeltaPct: pctDelta(buckets.thisYear.expenses, buckets.sameMonthsLastYear.expenses),
      amountReceived: money(buckets.thisYear.amountReceived),
      amountReceivedDeltaPct: pctDelta(buckets.thisYear.amountReceived, buckets.sameMonthsLastYear.amountReceived),
      netProfit: thisYearNetProfit,
      netProfitDeltaPct: pctDelta(thisYearNetProfit, sameMonthsLastYearNetProfit),
    },
  };
}

/**
 * Shared multi-step "decide" engine for every request type that can be
 * governed by an ApprovalWorkflow (Leave today; SalaryAdvance,
 * Reimbursement, Timesheet reuse this unchanged in later milestones). See
 * approvalWorkflow.model.js for the "pool of roles per step" model this
 * walks.
 *
 * `doc.workflow == null` means no workflow governs this request — the
 * ORIGINAL single-level flow each module shipped with (Phase 2/3) runs
 * completely unchanged in that case, so no employee is affected until an
 * Admin opts them into a workflow (Employee.approvalWorkflow, or a
 * company-wide default via ApprovalWorkflow.appliesTo).
 */
import ApprovalRole from './approvalRole.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import { logAudit } from '../audit/audit.service.js';
import { notifyUser, notifyEmployeeUser } from '../notifications/notification.service.js';

/**
 * Never let a notification failure abort the business transition that
 * already committed above it (fixed 2026-09-15, a real QA-audit-found gap
 * — F2): `notifyFinal`/`notifyUser` used to be awaited inline with nothing
 * catching a throw, so e.g. a `Notification.create` failure inside
 * `decideApprovalStep`'s terminal Approved branch propagated straight out
 * — meaning the CALLER's own post-decision code never ran at all, even
 * though the decision itself had already been durably persisted just
 * above. Concretely: mobilisation.service.js's `approveMobilisation` never
 * reached its `createDeploymentFromMobilisation` call, since the
 * `decideApprovalStep(...)` call it was awaiting never returned — leaving
 * an Approved mobilisation with no Deployment and no normal retry path
 * (the existing compensating rollback there only catches a
 * Deployment-creation failure, not one that happened before that code was
 * ever reached). Notifications are inherently best-effort — logged, never
 * allowed to silently swallow an error either.
 */
async function notifyBestEffort(fn) {
  try {
    await fn();
  } catch (err) {
    logger.error(`[approvalEngine] notification dispatch failed: ${err.message}`);
  }
}

/**
 * Is `actor` allowed to decide a step whose pool is `stepRoleIds`? Admin is
 * always a hardcoded override (consistent with Admin's superuser status
 * elsewhere in this app — see rbac.js/STAFF_ROLES and the Coordinator-team
 * scoping bypass). `viaAdminOverride` distinguishes "decided via real role
 * membership" from "decided via the Admin override" so the Approval Log can
 * show it transparently.
 */
// isActive: true (2026-09-14 QA-audit fix): a step's `roles` snapshot
// references a role by id forever (roles are deactivated, never deleted),
// but a DISABLED role must stop granting real decide authority the moment
// it's disabled, not just stop appearing in new workflow configuration.
export async function resolveStepAuthority(actor, stepRoleIds) {
  if (stepRoleIds?.length) {
    const matchedRole = await ApprovalRole.findOne({ _id: { $in: stepRoleIds }, members: actor.userId, isActive: true })
      .select('_id')
      .lean();
    if (matchedRole) return { authorized: true, roleId: matchedRole._id, viaAdminOverride: false };
  }
  if (actor.role === 'Admin') return { authorized: true, roleId: null, viaAdminOverride: true };
  return { authorized: false, roleId: null, viaAdminOverride: false };
}

/** The role ids `annotateCanDecide` would need to check membership of for
 *  ONE module's items — extracted so a caller juggling several modules
 *  (getMyPendingActions) can union them across all of its calls first and
 *  resolve membership once, instead of once per module. */
export function roleIdsNeededAcross(items, pendingStatus) {
  const roleIdsNeeded = new Set();
  for (const item of items) {
    if (item.status === pendingStatus && item.workflow) {
      const step = item.steps?.[item.currentStep];
      for (const roleId of step?.roles ?? []) roleIdsNeeded.add((roleId._id ?? roleId).toString());
    }
  }
  return roleIdsNeeded;
}

/**
 * Annotate a list of requests (already scoped/filtered by the caller — e.g.
 * a Coordinator's own team) with `canDecideCurrentStep`: a real,
 * server-computed hint so a review-queue UI only renders Approve/Reject for
 * viewers actually eligible to act, without duplicating the engine's
 * authorization logic on the client. This is convenience only — the decide
 * endpoint itself remains the real gate.
 *
 * Batches ApprovalRole membership into ONE query for the whole page rather
 * than one query per row.
 *
 * @param {object[]} items          lean documents (already status/scope filtered)
 * @param {{userId:string, role:string}} actor
 * @param {string} pendingStatus    status value meaning "awaiting decision"
 * @param {string[]} legacyAllowedRoles  same list passed to decideApprovalStep
 * @param {Set<string>} [memberRoleIds]  ALREADY-resolved "which role ids is
 *   this actor an active member of" (2026-09-22, a real QA-audit finding —
 *   P3: "batch approval-role membership checks"). Every existing caller
 *   still gets its own single query exactly as before by leaving this out —
 *   it exists for a caller like getMyPendingActions that calls this
 *   function once per module and would otherwise pay for the same "which
 *   roles is this actor in" question up to once per module. Computed with
 *   roleIdsNeededAcross(), below, over the UNION of every module's items.
 */
export async function annotateCanDecide(items, actor, { pendingStatus, legacyAllowedRoles, memberRoleIds: providedMemberRoleIds } = {}) {
  let memberRoleIds = providedMemberRoleIds;
  if (!memberRoleIds) {
    const roleIdsNeeded = roleIdsNeededAcross(items, pendingStatus);
    memberRoleIds = new Set();
    if (roleIdsNeeded.size > 0) {
      const roles = await ApprovalRole.find({ _id: { $in: [...roleIdsNeeded] }, members: actor.userId, isActive: true })
        .select('_id')
        .lean();
      memberRoleIds = new Set(roles.map((r) => r._id.toString()));
    }
  }

  return items.map((item) => {
    if (item.status !== pendingStatus) return { ...item, canDecideCurrentStep: false };
    if (!item.workflow) {
      return { ...item, canDecideCurrentStep: legacyAllowedRoles.includes(actor.role) };
    }
    const step = item.steps?.[item.currentStep];
    const stepRoleIds = (step?.roles ?? []).map((roleId) => (roleId._id ?? roleId).toString());
    const isMember = stepRoleIds.some((id) => memberRoleIds.has(id));
    return { ...item, canDecideCurrentStep: isMember || actor.role === 'Admin' };
  });
}

/** Every distinct User id holding any of `roleIds` — for next-step
 *  notifications. `isActive: true` (2026-09-14 QA-audit fix): a disabled
 *  role's members shouldn't be proactively notified as if they still held
 *  real decide authority. */
export async function membersOfRoles(roleIds) {
  if (!roleIds?.length) return [];
  const roles = await ApprovalRole.find({ _id: { $in: roleIds }, isActive: true }).select('members').lean();
  const ids = new Set();
  for (const role of roles) for (const memberId of role.members) ids.add(memberId.toString());
  return [...ids];
}

/**
 * Notify whoever should review a request the moment it's SUBMITTED — the
 * missing counterpart to decideApprovalStep's step-advancement notification.
 * That one only ever fires when an intermediate step approves and hands off
 * to the next step's pool; nothing told the very first reviewer(s) — the
 * common case, most requests have exactly one step — that a new request
 * existed at all. A requester's already-open review queue had no way to
 * learn about it short of a manual refresh landing after enough time had
 * passed for the page's own cache to go stale.
 *
 * @param {object} doc                  the just-created/just-resubmitted request (workflow fields already set, or null)
 * @param {(doc:object, stepIndex:number) => {type:string,title:string,body?:string,url?:string}} buildStepNotification  same builder decideApprovalStep's step-advancement path uses — reuse it rather than writing the text twice
 * @param {string[]} legacyAllowedRoles User.role values eligible to decide when doc.workflow is null
 * @param {string[]} [extraUserIds]     additional specific users to notify on the legacy path — e.g. Leave's employee.coordinator, who isn't reachable by role alone (only THEIR own coordinator may decide, not every Coordinator company-wide)
 */
export async function notifySubmission(doc, buildStepNotification, legacyAllowedRoles, extraUserIds = []) {
  if (!buildStepNotification) return;
  const stepIndex = doc.currentStep ?? 0;
  const notification = buildStepNotification(doc, stepIndex);

  let userIds;
  if (doc.workflow) {
    userIds = await membersOfRoles(doc.steps?.[stepIndex]?.roles);
  } else {
    const roleUsers = legacyAllowedRoles?.length
      ? await User.find({ role: { $in: legacyAllowedRoles }, isActive: true }).select('_id').lean()
      : [];
    const ids = new Set(roleUsers.map((u) => u._id.toString()));
    for (const id of extraUserIds) ids.add(id.toString());
    userIds = [...ids];
  }

  // Best-effort, same reasoning as decideApprovalStep's own notifyBestEffort
  // above (2026-09-15, F2's sibling case): the request itself is already
  // persisted by the time a caller reaches this call — a notification
  // failure here must not turn an already-successful submission into a
  // 500 response for the caller (or worse, invite an accidental duplicate
  // resubmit).
  await notifyBestEffort(() => Promise.all(userIds.map((userId) => notifyUser(userId, notification))));
}

/**
 * Decide one step of a request that may or may not be governed by a
 * workflow. Callers (leave.service.js's decideLeaveRequest etc.) supply the
 * Model plus the handful of things that legitimately differ per request
 * type; everything else (authorization, the atomic step transition, audit,
 * notifications) lives here exactly once.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} id
 * @param {'Approved'|'Rejected'} decision
 * @param {string} [note]
 * @param {{userId:string, role:string, ip:string}} actor
 * @param {string} pendingStatus        status value meaning "awaiting decision" (e.g. 'PendingReview')
 * @param {string[]} legacyAllowedRoles User.role values allowed to decide when doc.workflow is null — the ORIGINAL role gate for this request type, preserved exactly so nothing regresses for an employee not yet on a workflow
 * @param {(actor:object, employeeId:string) => Promise<void>} [assertScope]  extra legacy-path check (e.g. Leave's Coordinator-team scoping) — never run on the workflow path, where step-role membership IS the scope
 * @param {string} notFoundMessage
 * @param {string} auditAction          dot-namespaced prefix, e.g. 'leave.request'
 * @param {(doc:object) => {type:string,title:string,body?:string,url?:string}} buildFinalNotification  sent to the requester once the request reaches a terminal state (Approved/Rejected)
 * @param {(doc:object, stepIndex:number) => {type:string,title:string,body?:string,url?:string}} [buildStepNotification]  sent to every member of the NEXT step's role pool
 * @param {(doc:object, notification:object) => Promise<void>} [notifyFinal]  how to deliver buildFinalNotification's result — defaults to notifyEmployeeUser(doc.employee, ...), the shape every existing caller (Leave/SalaryAdvance/Reimbursement/Timesheet) uses. Override for a request type whose "who submitted this" isn't an Employee login — e.g. Mobilisation, whose `coordinators[]` are Users directly, not an Employee to resolve through.
 */
export async function decideApprovalStep({
  Model,
  id,
  decision,
  note,
  actor,
  pendingStatus,
  legacyAllowedRoles,
  assertScope,
  notFoundMessage,
  auditAction,
  buildFinalNotification,
  buildStepNotification,
  notifyFinal = (doc, notification) => notifyEmployeeUser(doc.employee, notification),
}) {
  const doc = await Model.findById(id);
  if (!doc) throw new ApiError(404, notFoundMessage);

  // Deliberately NOT throwing here on `doc.status !== pendingStatus` (fixed
  // 2026-09-22, a real QA-audit finding — F1's own flaky test, reconciled).
  // A stale advisory check like that against this READ raced against every
  // branch's own atomic conditional update below (all of which already,
  // consistently, return 409 on a lost race — the `findOneAndUpdate`
  // filters two lines down are the real, single source of truth for "is
  // this still decidable"). Depending on exactly how two concurrent
  // decisions interleaved, the loser could either lose HERE (this doc read
  // landing after the winner's write already committed → 400) or lose AT
  // the atomic update (this read landing before the winner's write → 409)
  // — the same request, the same two racing actors, two different status
  // codes purely from scheduling. The intended contract is simpler and now
  // deterministic: 409 Conflict, always, for "this request is not pending
  // review anymore" — whether that's because someone else decided it a
  // millisecond ago in a live race or three days ago from a stale-open UI
  // tab. (Authorization below still runs against this doc regardless of
  // its status, which is correct — a non-authorized actor gets 403 rather
  // than being told anything about the request's current state.)

  // ---- Legacy path: no workflow governs this request — today's original,
  // single-level behavior. ----
  if (!doc.workflow) {
    if (assertScope) await assertScope(actor, doc.employee);
    if (!legacyAllowedRoles.includes(actor.role)) {
      throw new ApiError(403, 'You do not have permission to perform this action.');
    }
    // Atomic update, not read-then-save (fixed 2026-09-15, a real QA-audit-
    // found race — F1): two concurrent decisions (even a contradictory
    // Approved + Rejected pair) could both pass the `doc.status !==
    // pendingStatus` check above against the same stale read, then both
    // `.save()` — both returning 200 with their own decision, whichever
    // write landed last silently overwriting the other's, audit log and
    // notification included for both. This is the exact same class of race
    // the WORKFLOW path just below already atomically guards (its own
    // `findOneAndUpdate({status, currentStep}, ...)`) — this legacy branch
    // predates that fix and was never brought in line with it. The filter
    // re-checks `status: pendingStatus` against the CURRENT document at
    // write time; only the first of two concurrent requests can match it —
    // the loser gets `null` back instead of silently succeeding.
    const updated = await Model.findOneAndUpdate(
      { _id: id, status: pendingStatus },
      { $set: { status: decision, decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note } },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.${decision.toLowerCase()}`,
      targetType: Model.modelName,
      targetId: updated._id,
      meta: { decisionNote: note },
      ip: actor.ip,
    });
    await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated)));
    return updated;
  }

  // ---- Workflow path ----
  const stepIndex = doc.currentStep;
  const step = doc.steps[stepIndex];
  const stepRoleIds = step?.roles ?? [];
  const { authorized, roleId, viaAdminOverride } = await resolveStepAuthority(actor, stepRoleIds);
  if (!authorized) {
    throw new ApiError(403, 'You are not an approver for the current step of this request.');
  }

  const trailEntry = {
    step: stepIndex,
    approvalRole: roleId,
    viaAdminOverride,
    approvedBy: actor.userId,
    decision,
    note,
    decidedAt: new Date(),
  };

  // Reject at any step → immediate overall rejection, chain stops.
  if (decision === 'Rejected') {
    // Atomic guard on {status, currentStep} closes the race between two pool
    // members deciding the same step at once — the loser gets a clean 409
    // instead of silently overwriting the winner's decision.
    const updated = await Model.findOneAndUpdate(
      { _id: id, status: pendingStatus, currentStep: stepIndex },
      {
        $push: { approvalTrail: trailEntry },
        $set: { status: 'Rejected', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note },
      },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.rejected`,
      targetType: Model.modelName,
      targetId: id,
      meta: { decisionNote: note, step: stepIndex, viaAdminOverride },
      ip: actor.ip,
    });
    await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated)));
    return updated;
  }

  const isLastStep = stepIndex >= doc.steps.length - 1;

  // Approve, not the last step → advance to the next step and notify it.
  if (!isLastStep) {
    const updated = await Model.findOneAndUpdate(
      { _id: id, status: pendingStatus, currentStep: stepIndex },
      { $push: { approvalTrail: trailEntry }, $inc: { currentStep: 1 } },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.step_approved`,
      targetType: Model.modelName,
      targetId: id,
      meta: { decisionNote: note, step: stepIndex, viaAdminOverride },
      ip: actor.ip,
    });
    if (buildStepNotification) {
      const nextStep = updated.steps[updated.currentStep];
      const memberIds = await membersOfRoles(nextStep?.roles);
      const notification = buildStepNotification(updated, updated.currentStep);
      await notifyBestEffort(() => Promise.all(memberIds.map((userId) => notifyUser(userId, notification))));
    }
    return updated;
  }

  // Approve, last step → terminal Approved.
  const updated = await Model.findOneAndUpdate(
    { _id: id, status: pendingStatus, currentStep: stepIndex },
    {
      $push: { approvalTrail: trailEntry },
      $set: { status: 'Approved', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note },
    },
    { new: true }
  ).lean();
  if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

  await logAudit({
    user: actor.userId,
    action: `${auditAction}.approved`,
    targetType: Model.modelName,
    targetId: id,
    meta: { decisionNote: note, step: stepIndex, viaAdminOverride },
    ip: actor.ip,
  });
  await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated)));
  return updated;
}

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
export function roleIdsNeededAcross(items, pendingStatus, statusField = 'status') {
  const roleIdsNeeded = new Set();
  for (const item of items) {
    if (item[statusField] === pendingStatus && item.workflow) {
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
/**
 * The population every list that shows a request's approval stages needs: step role names, and who decided
 * each step. The own-request lists ("My requests") use it so the requester sees the same stages a reviewer does.
 */
export function withApprovalTrail(query) {
  return query
    .populate('steps.roles', 'name')
    .populate('approvalTrail.approvalRole', 'name')
    .populate('approvalTrail.approvedBy', 'name role');
}

export async function annotateCanDecide(
  items,
  actor,
  { pendingStatus, legacyAllowedRoles, memberRoleIds: providedMemberRoleIds, isInLegacyScope, legacyCanDecide, statusField = 'status' } = {}
) {
  let memberRoleIds = providedMemberRoleIds;
  if (!memberRoleIds) {
    const roleIdsNeeded = roleIdsNeededAcross(items, pendingStatus, statusField);
    memberRoleIds = new Set();
    if (roleIdsNeeded.size > 0) {
      const roles = await ApprovalRole.find({ _id: { $in: [...roleIdsNeeded] }, members: actor.userId, isActive: true })
        .select('_id')
        .lean();
      memberRoleIds = new Set(roles.map((r) => r._id.toString()));
    }
  }

  return items.map((item) => {
    if (item[statusField] !== pendingStatus) return { ...item, canDecideCurrentStep: false };
    if (!item.workflow) {
      // Fixed 2026-09-29, a real audit finding: this had no way to apply the
      // same per-item scope check `decideApprovalStep`'s own legacy path
      // enforces via its `assertScope` parameter (e.g. Leave's Coordinator-
      // team check) — a role-list match alone let this flag say "you can
      // decide this" for an item the real decide call would actually 403 on
      // (a Coordinator's own self-submitted request, or another team's
      // request), including inflating a "waiting on you" count with items
      // that were never actually theirs to decide. `isInLegacyScope` is
      // never consulted on the workflow branch below, same reasoning
      // `assertScope` itself documents — step-role membership IS the scope
      // there.
      // `legacyCanDecide` (a boolean worked out once by the caller) is for a request whose original rule is a
      // Section Access grant rather than a role list.
      const roleOk = legacyCanDecide ?? legacyAllowedRoles.includes(actor.role);
      const scopeOk = isInLegacyScope ? isInLegacyScope(item) : true;
      return { ...item, canDecideCurrentStep: roleOk && scopeOk };
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
 * @param {(doc:object) => Promise<void>} [onApproved]  awaited right after a request becomes Approved and BEFORE the requester is told — for a request type whose approval must do more work to take effect (Mobilisation creates its Deployment). If it throws, the error propagates and nobody is notified, so a success message is never left behind for an approval that did not complete (2026-10-10, QA audit V2-F07). The hook owns any compensation of its own.
 * @param {(doc:object, notification:object) => Promise<void>} [notifyFinal]  how to deliver buildFinalNotification's result — defaults to notifyEmployeeUser(doc.employee, ...), the shape every existing caller (Leave/SalaryAdvance/Reimbursement/Timesheet) uses. Override for a request type whose "who submitted this" isn't an Employee login — e.g. Mobilisation, whose `coordinators[]` are Users directly, not an Employee to resolve through.
 * @param {string} [statusField]  the field holding the request's status (default 'status'; a Client uses 'approvalStatus', a payment 'decisionStatus')
 * @param {{path:string, id:string}} [subdocument]  decide one element of an array on the parent document (a deployment's monthly-hours entry) instead of the document itself; `id` is the parent, `subdocument.id` the element
 * @param {(actor:object, doc:object) => Promise<void>} [authorizeLegacy]  replaces the legacy role-list + assertScope check when the original rule is not a role list (a Section Access grant); throws a 403 itself
 */
export async function decideApprovalStep({
  Model,
  id,
  decision,
  note,
  actor,
  pendingStatus,
  legacyAllowedRoles = [],
  assertScope,
  authorizeLegacy,
  statusField = 'status',
  subdocument = null,
  notFoundMessage,
  auditAction,
  buildFinalNotification,
  buildStepNotification,
  onApproved,
  notifyFinal = (doc, notification) => notifyEmployeeUser(doc.employee, notification),
}) {
  const parent = await Model.findById(id);
  if (!parent) throw new ApiError(404, notFoundMessage);
  const doc = subdocument ? parent[subdocument.path]?.id(subdocument.id) : parent;
  if (!doc) throw new ApiError(404, notFoundMessage);

  // Where the request's own fields live: on the document, or inside one element of an array on it.
  const field = (name) => (subdocument ? `${subdocument.path}.$.${name}` : name);
  const match = (extra = {}) =>
    subdocument
      ? { _id: id, [subdocument.path]: { $elemMatch: { _id: subdocument.id, [statusField]: pendingStatus, ...extra } } }
      : { _id: id, [statusField]: pendingStatus, ...extra };
  const pick = (updatedParent) => (subdocument ? updatedParent?.[subdocument.path]?.find((e) => String(e._id) === String(subdocument.id)) : updatedParent);

  // Deliberately NOT throwing here on `doc[statusField] !== pendingStatus` (fixed 2026-09-22, a real QA-audit
  // finding): the atomic conditional updates below are the single source of truth for "is this still
  // decidable", and always answer 409 for a request that is not pending anymore.

  // ---- Legacy path: no workflow governs this request — today's original, single-level behavior. ----
  if (!doc.workflow) {
    if (authorizeLegacy) {
      await authorizeLegacy(actor, doc);
    } else {
      if (assertScope) await assertScope(actor, doc.employee, doc);
      if (!legacyAllowedRoles.includes(actor.role)) {
        throw new ApiError(403, 'You do not have permission to perform this action.');
      }
    }
    // Atomic update, not read-then-save (fixed 2026-09-15, F1): only the first of two concurrent decisions matches.
    const updatedParent = await Model.findOneAndUpdate(
      match(),
      { $set: { [field(statusField)]: decision, [field('decidedBy')]: actor.userId, [field('decidedAt')]: new Date(), [field('decisionNote')]: note } },
      { new: true }
    ).lean();
    const updated = pick(updatedParent);
    if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.${decision.toLowerCase()}`,
      targetType: Model.modelName,
      targetId: updatedParent._id,
      meta: { decisionNote: note },
      ip: actor.ip,
    });
    if (decision === 'Approved' && onApproved) await onApproved(updated, updatedParent);
    await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated, updatedParent), updatedParent));
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
  const atThisStep = match({ currentStep: stepIndex });

  // Reject at any step → immediate overall rejection, chain stops. The atomic guard on {status, currentStep}
  // closes the race between two pool members deciding the same step at once.
  if (decision === 'Rejected') {
    const updatedParent = await Model.findOneAndUpdate(
      atThisStep,
      {
        $push: { [field('approvalTrail')]: trailEntry },
        $set: { [field(statusField)]: 'Rejected', [field('decidedBy')]: actor.userId, [field('decidedAt')]: new Date(), [field('decisionNote')]: note },
      },
      { new: true }
    ).lean();
    const updated = pick(updatedParent);
    if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.rejected`,
      targetType: Model.modelName,
      targetId: id,
      meta: { decisionNote: note, step: stepIndex, viaAdminOverride },
      ip: actor.ip,
    });
    await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated, updatedParent), updatedParent));
    return updated;
  }

  const isLastStep = stepIndex >= doc.steps.length - 1;

  // Approve, not the last step → advance to the next step and notify it.
  if (!isLastStep) {
    const updatedParent = await Model.findOneAndUpdate(
      atThisStep,
      { $push: { [field('approvalTrail')]: trailEntry }, $inc: { [field('currentStep')]: 1 } },
      { new: true }
    ).lean();
    const updated = pick(updatedParent);
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
      const notification = buildStepNotification(updated, updated.currentStep, updatedParent);
      await notifyBestEffort(() => Promise.all(memberIds.map((userId) => notifyUser(userId, notification))));
    }
    return updated;
  }

  // Approve, last step → terminal Approved.
  const updatedParent = await Model.findOneAndUpdate(
    atThisStep,
    {
      $push: { [field('approvalTrail')]: trailEntry },
      $set: { [field(statusField)]: 'Approved', [field('decidedBy')]: actor.userId, [field('decidedAt')]: new Date(), [field('decisionNote')]: note },
    },
    { new: true }
  ).lean();
  const updated = pick(updatedParent);
  if (!updated) throw new ApiError(409, 'This request was already decided by someone else.');

  await logAudit({
    user: actor.userId,
    action: `${auditAction}.approved`,
    targetType: Model.modelName,
    targetId: id,
    meta: { decisionNote: note, step: stepIndex, viaAdminOverride },
    ip: actor.ip,
  });
  if (onApproved) await onApproved(updated, updatedParent);
  await notifyBestEffort(() => notifyFinal(updated, buildFinalNotification(updated, updatedParent), updatedParent));
  return updated;
}

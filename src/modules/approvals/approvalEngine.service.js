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
import { logAudit } from '../audit/audit.service.js';
import { notifyUser, notifyEmployeeUser } from '../notifications/notification.service.js';

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
 */
export async function annotateCanDecide(items, actor, { pendingStatus, legacyAllowedRoles }) {
  const roleIdsNeeded = new Set();
  for (const item of items) {
    if (item.status === pendingStatus && item.workflow) {
      const step = item.steps?.[item.currentStep];
      for (const roleId of step?.roles ?? []) roleIdsNeeded.add((roleId._id ?? roleId).toString());
    }
  }

  let memberRoleIds = new Set();
  if (roleIdsNeeded.size > 0) {
    const roles = await ApprovalRole.find({ _id: { $in: [...roleIdsNeeded] }, members: actor.userId, isActive: true })
      .select('_id')
      .lean();
    memberRoleIds = new Set(roles.map((r) => r._id.toString()));
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

  await Promise.all(userIds.map((userId) => notifyUser(userId, notification)));
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
  if (doc.status !== pendingStatus) {
    throw new ApiError(400, `Only requests pending review can be decided.`);
  }

  // ---- Legacy path: no workflow governs this request — today's original,
  // untouched single-level behavior. ----
  if (!doc.workflow) {
    if (assertScope) await assertScope(actor, doc.employee);
    if (!legacyAllowedRoles.includes(actor.role)) {
      throw new ApiError(403, 'You do not have permission to perform this action.');
    }
    doc.status = decision;
    doc.decidedBy = actor.userId;
    doc.decidedAt = new Date();
    doc.decisionNote = note;
    await doc.save();

    await logAudit({
      user: actor.userId,
      action: `${auditAction}.${decision.toLowerCase()}`,
      targetType: Model.modelName,
      targetId: doc._id,
      meta: { decisionNote: note },
      ip: actor.ip,
    });
    const plain = doc.toObject();
    await notifyFinal(plain, buildFinalNotification(plain));
    return plain;
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
    await notifyFinal(updated, buildFinalNotification(updated));
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
      await Promise.all(memberIds.map((userId) => notifyUser(userId, notification)));
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
  await notifyFinal(updated, buildFinalNotification(updated));
  return updated;
}

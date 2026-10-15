/**
 * approvalEscalation.job.js - the escalation matrix: a workflow step can carry up to three levels, each "after N
 * calendar days at this step, tell the step's approver / the members of a role". Daily (server.js), it walks every
 * request still waiting on a hierarchy and sends each level that has been reached. Inform only: it never changes
 * who can decide, and it never decides anything.
 *
 * Each level is sent once per visit to a step: the dedupeKey carries the moment the request reached the step, so
 * a request that moves on (or is resubmitted) starts counting again. A request filed before escalation existed has
 * no levels in its frozen step; it falls back to the live workflow's step at the same position (only while that
 * workflow is active and still has the same number of steps), so levels set today also chase what is waiting.
 */
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import { listApprovalLog } from '../approvals/approvals.service.js';
import { membersOfRoles, recipientsOfStep } from '../approvals/approvalEngine.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const DAY = 86_400_000;

/** Where each request type is handled (the link in the notification). */
const PAGE_FOR_TYPE = {
  Leave: '/leave',
  AnnualVacation: '/annual-vacation',
  Timesheet: '/timesheets',
  SalaryAdvance: '/financial-requests',
  Reimbursement: '/financial-requests',
  ExitReentry: '/exit-documents',
  Certificate: '/exit-documents',
  ClientApproval: '/clients',
  SubcontractorApproval: '/subcontractors',
  ClientPayment: '/financial/payments-review',
  SubcontractorPayment: '/financial/sub-payments-review',
  SubcontractorTransfer: '/subcontractor-transfers',
  MonthlyHours: '/deployments/hours-review',
  Mobilisation: '/mobilisations',
};

const typeLabel = (type) => type.replace(/([a-z])([A-Z])/g, '$1 $2');
const idOf = (ref) => String(ref?._id ?? ref);

/** When the request reached its current step: the stored moment, else its last decided step, else when it was filed. */
export function stepEnteredAt(item) {
  if (item.currentStepEnteredAt) return new Date(item.currentStepEnteredAt);
  const trail = item.approvalTrail ?? [];
  const last = trail.length ? trail[trail.length - 1].decidedAt : null;
  return new Date(last ?? item.enteredAt ?? item.createdAt);
}

/** The levels whose day has been reached after `daysWaiting` calendar days, each with its position. */
export function reachedLevels(levels, daysWaiting) {
  return (levels ?? []).map((level, index) => ({ ...level, index })).filter((level) => daysWaiting >= level.afterDays);
}

export async function runApprovalEscalationCheck() {
  const [{ items }, mobilisations] = await Promise.all([
    listApprovalLog({ status: 'Pending', page: 1, limit: 100_000 }),
    Mobilisation.find({ status: 'PendingReview', workflow: { $ne: null } })
      .select('workerName clientName workflow workflowName steps currentStep currentStepEnteredAt approvalTrail createdAt updatedAt')
      .populate('steps.roles', 'name')
      .lean(),
  ]);
  const waiting = [
    ...items,
    ...mobilisations.map((m) => ({
      ...m,
      requestType: 'Mobilisation',
      subject: m.workerName,
      subjectRef: m.clientName,
      createdAt: m.currentStepEnteredAt ?? m.updatedAt ?? m.createdAt,
    })),
  ];

  const liveWorkflows = new Map();
  async function liveWorkflow(id) {
    if (!liveWorkflows.has(id)) liveWorkflows.set(id, await ApprovalWorkflow.findOne({ _id: id, isActive: true }).lean());
    return liveWorkflows.get(id);
  }

  let itemsEscalated = 0;
  let notificationsSent = 0;
  for (const item of waiting) {
    const step = item.steps?.[item.currentStep];
    if (!step || !item.workflow) continue;

    let levels = step.escalation;
    if (!levels?.length) {
      const live = await liveWorkflow(idOf(item.workflow));
      const liveStep = live && live.steps.length === item.steps.length ? live.steps[item.currentStep] : null;
      levels = liveStep?.escalation ?? [];
    }
    if (!levels.length) continue;

    const enteredAt = stepEnteredAt(item);
    const daysWaiting = Math.floor((Date.now() - enteredAt.getTime()) / DAY);
    const due = reachedLevels(levels, daysWaiting);
    if (due.length === 0) continue;

    const stepWithIds = { ...step, roles: (step.roles ?? []).map(idOf) };
    const title = `${typeLabel(item.requestType)} waiting ${daysWaiting} day(s) at ${step.label || 'its current step'}`;
    const body = [item.subject, item.subjectRef].filter(Boolean).join(' · ') || undefined;
    let sentForItem = 0;
    for (const level of due) {
      const recipients = level.notify === 'role' ? await membersOfRoles([idOf(level.role)]) : await recipientsOfStep(stepWithIds);
      for (const userId of new Set(recipients)) {
        const result = await notifyUser(userId, {
          type: 'RequestStatus',
          title,
          body,
          url: PAGE_FOR_TYPE[item.requestType],
          dedupeKey: `escalation:${item.requestType}:${item._id}:${item.currentStep}:${enteredAt.getTime()}:${level.index}:${userId}`,
        });
        if (result.wasNew) sentForItem += 1;
      }
    }
    if (sentForItem > 0) itemsEscalated += 1;
    notificationsSent += sentForItem;
  }

  logger.info(`[approvalEscalationJob] ${itemsEscalated} request(s) escalated, ${notificationsSent} notification(s) sent.`);
  return { itemsFound: waiting.length, itemsEscalated, notificationsSent };
}

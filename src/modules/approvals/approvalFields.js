/**
 * The approval-engine fields every request that can sit on an ApprovalWorkflow carries (the same shape
 * leaveRequest/advance/... declare inline), plus the helpers that start and restart them. Used by the
 * decisions brought onto the hierarchy on 2026-10-14 (client approval, client and subcontractor payments,
 * monthly hours, subcontractor transfers); the older request models keep their own copy. A model file imports
 * this one (pure); `startApproval` lives in approvals.service.js.
 *
 * `decidedBy` / `decidedAt` / `decisionNote` are the FINAL decision only once a workflow governs the request;
 * the per-step record is `approvalTrail`.
 */
import mongoose from 'mongoose';

/** One escalation level of a workflow step: after `afterDays` calendar days at the step, tell the step's approver
 *  (`notify: 'approver'`) or the members of `role`. Inform only: it never changes who can decide. */
export const ESCALATION_NOTIFY = ['approver', 'role'];
export const MAX_ESCALATION_LEVELS = 3;

/** A fresh copy per schema (mongoose schemas must not share one field-definition object). */
export function escalationLevelsField() {
  return [
    {
      afterDays: { type: Number, min: 1, max: 90 },
      notify: { type: String, enum: ESCALATION_NOTIFY },
      role: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole', default: null },
      _id: false,
    },
  ];
}

/** A fresh copy per schema (mongoose schemas must not share one field-definition object). */
export function approvalFields() {
  return {
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    workflowName: { type: String, default: null },
    steps: {
      type: [
        {
          label: String,
          roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
          assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          escalation: escalationLevelsField(),
          _id: false,
        },
      ],
      default: undefined,
    },
    currentStep: { type: Number, default: 0 },
    // When the request reached its current step: the clock the escalation levels count from.
    currentStepEnteredAt: { type: Date, default: null },
    approvalTrail: {
      type: [
        {
          step: Number,
          approvalRole: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole', default: null },
          viaAdminOverride: Boolean,
          approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          decision: { type: String, enum: ['Approved', 'Rejected'] },
          note: String,
          decidedAt: Date,
          _id: false,
        },
      ],
      default: undefined,
    },
  };
}

/** The population a list needs so each request's stages and approvers show (names, not ids). */
export function populateTrail(path = '') {
  const p = path ? `${path}.` : '';
  return [
    { path: `${p}steps.roles`, select: 'name' },
    { path: `${p}steps.assignee`, select: 'name' },
    { path: `${p}approvalTrail.approvalRole`, select: 'name' },
    { path: `${p}approvalTrail.approvedBy`, select: 'name role' },
  ];
}

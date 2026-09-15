/**
 * Zod schemas for the Approvals module: ApprovalRole and ApprovalWorkflow
 * configuration (Admin-only — see approvals.routes.js).
 */
import { z } from 'zod';
import { APPROVAL_REQUEST_TYPES } from './approvalWorkflow.model.js';

const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const objectId = (label) => z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`);

export const createApprovalRoleSchema = z.object({
  name: z.string().trim().min(2, 'Name is required.').max(60),
  description: z.preprocess(emptyToUndef, z.string().trim().max(300).optional()),
  members: z.array(objectId('user')).default([]),
  isActive: z.boolean().default(true),
});

export const updateApprovalRoleSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.preprocess(emptyToUndef, z.string().trim().max(300).optional()),
  members: z.array(objectId('user')).optional(),
  isActive: z.boolean().optional(),
});

export const approvalRoleIdParamSchema = z.object({ id: objectId('approval role') });

const workflowStepSchema = z.object({
  label: z.preprocess(emptyToUndef, z.string().trim().max(60).optional()),
  roles: z.array(objectId('approval role')).min(1, 'Each step needs at least one role.'),
});

export const createApprovalWorkflowSchema = z.object({
  name: z.string().trim().min(2, 'Name is required.').max(60),
  steps: z.array(workflowStepSchema).min(1, 'A workflow needs at least one step.'),
  appliesTo: z.array(z.enum(APPROVAL_REQUEST_TYPES)).default([]),
  isActive: z.boolean().default(true),
});

export const updateApprovalWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  steps: z.array(workflowStepSchema).min(1).optional(),
  appliesTo: z.array(z.enum(APPROVAL_REQUEST_TYPES)).optional(),
  isActive: z.boolean().optional(),
});

export const approvalWorkflowIdParamSchema = z.object({ id: objectId('approval workflow') });

// Fixed 2026-09-15, a real QA-audit-found gap — F9: this hardcoded
// 'PendingReview' — Leave's own literal pending status — as THE pending
// value for every source type in the log, even though Timesheet's real
// pending status is 'Submitted' and Certificate/ExitReentry/SalaryAdvance/
// Reimbursement's is 'Pending'. `status=PendingReview` silently returned
// zero results for those types; asking for a type's own real pending
// status (e.g. `status=Submitted`) 400'd outright, since it wasn't even in
// this enum. 'Pending' is now a normalized value approvals.service.js's
// listApprovalLog translates per source type — see LOG_SOURCES there.
// 'Approved'/'Rejected' need no translation: every source type's model
// uses those exact literal strings for its own terminal states.
export const approvalLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.preprocess(emptyToUndef, z.enum(APPROVAL_REQUEST_TYPES).optional()),
  status: z.preprocess(emptyToUndef, z.enum(['Pending', 'Approved', 'Rejected']).optional()),
  employee: z.preprocess(emptyToUndef, objectId('employee').optional()),
  from: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  to: z.preprocess(emptyToUndef, z.coerce.date().optional()),
});

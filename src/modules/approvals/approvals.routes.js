/**
 * Approvals routes. WRITE (create/edit roles and workflows) is Section
 * Access key 'approvalHierarchy' at 'write', default [] — matches today's
 * Admin-only behavior exactly until an Admin grants someone else. READ
 * (list) is the same key at 'read' — its default now mirrors write ([],
 * Admin-only) per the user's explicit "no exceptions" instruction for this
 * change, even though this key's read WAS deliberately wide open before:
 * EmployeeForm's approval-workflow override picker and every request-decide
 * screen's approval-trail display read role/workflow NAMES from here, and
 * will need an explicit Read grant (or will 403) once this ships — flagged
 * clearly, not silently worked around. Deciding a step happens on each
 * request module's own decide route (leave.routes.js etc.), via the shared
 * approvalEngine — this router owns configuration only. The Approval Log
 * (`/log`) is untouched — already dynamically gated (Admin, or a real
 * ApprovalRole member) inside the controller itself.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff, requireStaffOrExecutive } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createApprovalRoleSchema,
  updateApprovalRoleSchema,
  approvalRoleIdParamSchema,
  createApprovalWorkflowSchema,
  updateApprovalWorkflowSchema,
  approvalWorkflowIdParamSchema,
  approvalLogQuerySchema,
} from './approvals.validation.js';
import * as approvalsController from './approvals.controller.js';

const router = Router();

router.use(requireAuth);

const canReadApprovalHierarchy = requireSectionAccess('approvalHierarchy', 'read');
const canManageApprovalHierarchy = requireSectionAccess('approvalHierarchy', 'write');

router.get('/roles', requireStaff, canReadApprovalHierarchy, asyncHandler(approvalsController.listRoles));
router.post(
  '/roles',
  canManageApprovalHierarchy,
  validate({ body: createApprovalRoleSchema }),
  asyncHandler(approvalsController.createRole)
);
router.patch(
  '/roles/:id',
  canManageApprovalHierarchy,
  validate({ params: approvalRoleIdParamSchema, body: updateApprovalRoleSchema }),
  asyncHandler(approvalsController.updateRole)
);

router.get('/workflows', requireStaff, canReadApprovalHierarchy, asyncHandler(approvalsController.listWorkflows));
router.post(
  '/workflows',
  canManageApprovalHierarchy,
  validate({ body: createApprovalWorkflowSchema }),
  asyncHandler(approvalsController.createWorkflow)
);
router.patch(
  '/workflows/:id',
  canManageApprovalHierarchy,
  validate({ params: approvalWorkflowIdParamSchema, body: updateApprovalWorkflowSchema }),
  asyncHandler(approvalsController.updateWorkflow)
);

// Open to any staff member (or Executive) — the controller applies the
// real, dynamic "Admin or an actual ApprovalRole member" gate itself.
router.get('/log', requireStaffOrExecutive, validate({ query: approvalLogQuerySchema }), asyncHandler(approvalsController.log));

export default router;

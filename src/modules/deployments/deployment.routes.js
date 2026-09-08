/**
 * Deployment routes.
 *
 * Router-level `requireStaffOrOfficeSecretary` (not plain `requireStaff`) so
 * Office Secretary can reach the monthly-hours endpoint at all — Office
 * Secretary is otherwise deny-by-default (see rbac.js), and is a hardcoded
 * exception INSIDE addMonthlyHours/updateMonthlyHours rather than a Section
 * Access grant (same pattern mobilisation.service.js's createMobilisation
 * uses — Office Secretary isn't a grantable Section Access role at all).
 *
 * Roles: everyone (staff or Office Secretary) may READ the register/history.
 * Monthly hours entry is gated inside the service (Office Secretary, or
 * Section Access key 'deploymentsHours'). Release is Section Access key
 * 'deploymentsRelease', default ['Coordinator', 'Manager'] — Office
 * Secretary never releases. Deployments have no create/edit route at all —
 * they're born automatically from an Approved Mobilisation (see
 * mobilisation.service.js's approveMobilisation) — EXCEPT for a TEMPORARY
 * Admin-only DELETE added for pre-production cleanup; remove it before
 * going live (see the note on that route below).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaffOrOfficeSecretary, requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  listDeploymentsSchema,
  deploymentIdParamSchema,
  monthlyHoursEntryParamSchema,
  addMonthlyHoursSchema,
  updateMonthlyHoursSchema,
  releaseDeploymentSchema,
} from './deployment.validation.js';
import * as deploymentController from './deployment.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaffOrOfficeSecretary);

const canRelease = requireSectionAccess('deploymentsRelease');

router.get('/', validate({ query: listDeploymentsSchema }), asyncHandler(deploymentController.list));
router.get(
  '/:id',
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.get)
);
router.post(
  '/:id/monthly-hours',
  validate({ params: deploymentIdParamSchema, body: addMonthlyHoursSchema }),
  asyncHandler(deploymentController.addMonthlyHours)
);
router.patch(
  '/:id/monthly-hours/:entryId',
  validate({ params: monthlyHoursEntryParamSchema, body: updateMonthlyHoursSchema }),
  asyncHandler(deploymentController.updateMonthlyHours)
);
router.post(
  '/:id/release',
  canRelease,
  validate({ params: deploymentIdParamSchema, body: releaseDeploymentSchema }),
  asyncHandler(deploymentController.release)
);
// TEMPORARY — pre-production cleanup only, Admin-only hard delete. Remove
// this route (and deployment.controller.js's `remove` / deployment.
// service.js's `deleteDeployment`) before going live.
router.delete(
  '/:id',
  requireRoles('Admin'),
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.remove)
);

export default router;

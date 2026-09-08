/**
 * Deployment routes.
 *
 * Roles: everyone authenticated may READ the register/history. Assigning,
 * transferring and ending are Section Access key 'deploymentsManage',
 * default ['Manager'] — matches today's Admin/Manager circle exactly.
 * Deployments are otherwise immutable history — the "end" action is how an
 * active placement is closed — EXCEPT for a TEMPORARY Admin-only DELETE
 * added for pre-production cleanup; remove it before going live (see the
 * note on that route below).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff, requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  assignSchema,
  transferSchema,
  listDeploymentsSchema,
  deploymentIdParamSchema,
} from './deployment.validation.js';
import * as deploymentController from './deployment.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff); // staff-only module; Workers use the ESS portal (P2-M2)

const canWrite = requireSectionAccess('deploymentsManage');

router.get('/', validate({ query: listDeploymentsSchema }), asyncHandler(deploymentController.list));
router.get(
  '/:id',
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.get)
);
router.post('/', canWrite, validate({ body: assignSchema }), asyncHandler(deploymentController.assign));
router.post(
  '/:id/transfer',
  canWrite,
  validate({ params: deploymentIdParamSchema, body: transferSchema }),
  asyncHandler(deploymentController.transfer)
);
router.post(
  '/:id/end',
  canWrite,
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.end)
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

/**
 * MobilisationTarget routes.
 *
 * Read own: any staff (a Coordinator needs this for their own dashboard widget).
 * Read all / write: management-gated in the service (Admin, Manager, or
 * mobilisationTargets Section Access write-role member).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  setTargetSchema,
  getProgressSchema,
  getMyTargetSchema,
  getSemiAnnualSchema,
  targetIdParamSchema,
} from './mobilisationTarget.validation.js';
import * as targetController from './mobilisationTarget.controller.js';

const router = Router();

router.use(requireAuth, requireStaff);

// Coordinator-own read — must be before the param routes.
router.get('/my', validate({ query: getMyTargetSchema }), asyncHandler(targetController.getMy));
router.get('/semi-annual/my', validate({ query: getSemiAnnualSchema }), asyncHandler(targetController.getMySemiAnnual));
router.get('/monthly-window/my', validate({ query: getSemiAnnualSchema }), asyncHandler(targetController.getMyMonthlyWindow));

// Management reads.
router.get('/progress', validate({ query: getProgressSchema }), asyncHandler(targetController.getProgress));
router.get('/semi-annual', validate({ query: getSemiAnnualSchema }), asyncHandler(targetController.getSemiAnnual));
router.get('/monthly-window', validate({ query: getSemiAnnualSchema }), asyncHandler(targetController.getMonthlyWindow));
router.get('/', asyncHandler(targetController.listAll));

// Management writes.
router.post('/', validate({ body: setTargetSchema }), asyncHandler(targetController.set));
router.delete('/:id', validate({ params: targetIdParamSchema }), asyncHandler(targetController.remove));

export default router;

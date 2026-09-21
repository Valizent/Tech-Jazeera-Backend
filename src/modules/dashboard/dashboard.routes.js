/**
 * Dashboard route. Read-only, available to any authenticated STAFF user — it's
 * the staff landing page, so a Worker (P2-M1) is excluded (requireStaff);
 * their own landing is the ESS portal (P2-M2). Every figure a Coordinator
 * receives is scoped to their own team by the service, not by this route —
 * see dashboard.service.js's getDashboard() doc comment.
 *
 * requireStaffOrExecutive (not plain requireStaff): this is exactly the
 * "just needs to see data" screen an Executive (GM/COO) login is for.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaffOrExecutive } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { dashboardQuerySchema } from './dashboard.validation.js';
import * as dashboardController from './dashboard.controller.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  requireStaffOrExecutive,
  validate({ query: dashboardQuerySchema }),
  asyncHandler(dashboardController.overview)
);

router.get(
  '/standby-analysis',
  requireAuth,
  requireStaffOrExecutive,
  asyncHandler(dashboardController.standbyAnalysis)
);

// We need a validation schema for the coordinator ID, let's reuse a standard param id validator if it exists, or just do it in the controller/service.
import { z } from 'zod';
const idParamSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.') });

router.get(
  '/coordinator-drill-down/:id',
  requireAuth,
  requireStaffOrExecutive,
  validate({ params: idParamSchema }),
  asyncHandler(dashboardController.coordinatorDrillDown)
);

export default router;

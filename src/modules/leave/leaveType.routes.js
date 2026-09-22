/**
 * Leave type routes (P2-M2) — company leave policy configuration.
 *
 * Split out of the old combined `leave.routes.js` (2026-09-22, a real
 * QA-audit finding — P2): that router sat at the bare `/api` prefix with its
 * own unconditional `requireAuth`, so EVERY request for a module mounted
 * after it in app.js (notifications, EOSB, financial requests, assets, exit
 * documents, timesheets, and anything mounted later) authenticated twice —
 * once falling through this router's blanket middleware, once again in its
 * own router. Reproduced: a notification GET made two `User.findById` calls
 * instead of one. Mounted here at its own real prefix (`/api/leave-types`),
 * this router can no longer intercept anything that isn't actually its own.
 *
 * Readable by anyone authenticated (a Worker needs this list to submit a
 * leave request); only Admin/HR shape the policy — this is company leave
 * policy configuration, not a day-to-day operational manager's job.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { createLeaveTypeSchema, updateLeaveTypeSchema, listLeaveTypesSchema, leaveTypeIdParamSchema } from './leave.validation.js';
import * as leaveController from './leave.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', validate({ query: listLeaveTypesSchema }), asyncHandler(leaveController.listTypes));
router.post('/', requireRoles('Admin', 'HR'), validate({ body: createLeaveTypeSchema }), asyncHandler(leaveController.createType));
router.patch(
  '/:id',
  requireRoles('Admin', 'HR'),
  validate({ params: leaveTypeIdParamSchema, body: updateLeaveTypeSchema }),
  asyncHandler(leaveController.updateType)
);

export default router;

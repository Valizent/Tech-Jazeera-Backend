/**
 * Daily Updates routes.
 *
 * Deliberately NO per-route requireSectionAccess gate: this module is governed
 * by TWO Section Access keys at two tiers (`dailyUpdatesOwn`/`dailyUpdatesTeam`,
 * Read/Write each), and which one applies depends on the entry being touched
 * (your own to-do vs a manager-assigned task vs another coordinator's log) —
 * a route-level gate can only ask one question up front. The service resolves
 * the caller's access once per request and enforces it per action, the same
 * "authorization lives in the service" shape mobilisation.service.js already
 * uses for its per-record rules. requireStaff is still the floor: Worker/Staff
 * logins never reach this module.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createDailyUpdateSchema,
  updateDailyUpdateSchema,
  setStatusSchema,
  listDailyUpdatesSchema,
  dailyUpdateIdParamSchema,
} from './dailyUpdate.validation.js';
import * as dailyUpdateController from './dailyUpdate.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

// Before the /:id routes, or "coordinators" is read as an entry id.
router.get('/coordinators', asyncHandler(dailyUpdateController.coordinators));
router.get('/', validate({ query: listDailyUpdatesSchema }), asyncHandler(dailyUpdateController.list));
router.post('/', validate({ body: createDailyUpdateSchema }), asyncHandler(dailyUpdateController.create));
router.patch(
  '/:id',
  validate({ params: dailyUpdateIdParamSchema, body: updateDailyUpdateSchema }),
  asyncHandler(dailyUpdateController.update)
);
router.patch(
  '/:id/status',
  validate({ params: dailyUpdateIdParamSchema, body: setStatusSchema }),
  asyncHandler(dailyUpdateController.setStatus)
);
router.delete('/:id', validate({ params: dailyUpdateIdParamSchema }), asyncHandler(dailyUpdateController.remove));

export default router;

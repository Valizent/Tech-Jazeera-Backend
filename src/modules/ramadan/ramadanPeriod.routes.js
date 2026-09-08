/**
 * RamadanPeriod routes (P3-E). Read is Section Access key 'ramadanManage'
 * at 'read' (default mirrors write). Confirmed safe to gate: no ESS/Worker
 * client code calls this route directly — the Ramadan-aware overtime
 * calculation (timesheet.service.js) reads the RamadanPeriod model
 * server-side directly, never through this HTTP route, so gating it here
 * cannot break Worker self-service. Write (create/update/delete, one
 * circle — there was never a stricter delete-only tier here) is the same
 * key at 'write', default ['Manager','HR'] — matches today's
 * Admin/Manager/HR circle exactly.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createRamadanPeriodSchema,
  updateRamadanPeriodSchema,
  listRamadanPeriodsSchema,
  ramadanPeriodIdParamSchema,
} from './ramadanPeriod.validation.js';
import * as ramadanPeriodController from './ramadanPeriod.controller.js';

const router = Router();

router.use(requireAuth);

const canReadRamadan = requireSectionAccess('ramadanManage', 'read');
const canManageRamadan = requireSectionAccess('ramadanManage', 'write');

router.get('/', canReadRamadan, validate({ query: listRamadanPeriodsSchema }), asyncHandler(ramadanPeriodController.list));
router.post(
  '/',
  canManageRamadan,
  validate({ body: createRamadanPeriodSchema }),
  asyncHandler(ramadanPeriodController.create)
);
router.patch(
  '/:id',
  canManageRamadan,
  validate({ params: ramadanPeriodIdParamSchema, body: updateRamadanPeriodSchema }),
  asyncHandler(ramadanPeriodController.update)
);
router.delete(
  '/:id',
  canManageRamadan,
  validate({ params: ramadanPeriodIdParamSchema }),
  asyncHandler(ramadanPeriodController.remove)
);

export default router;

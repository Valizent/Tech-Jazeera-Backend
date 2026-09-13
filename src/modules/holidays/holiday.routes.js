/**
 * Holiday routes (P3-B). Section Access key 'holidays' is Write-only (added
 * 2026-09-13, alongside the Section Access page's own module-grid redesign):
 * GET stays open to any authenticated user with no gate at all — Workers
 * included, since the ESS Leave page shows the upcoming-holidays list off
 * this exact route — only create/edit/delete is admin-configurable now,
 * replacing the previous hardcoded Admin/HR check.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createHolidaySchema,
  updateHolidaySchema,
  listHolidaysSchema,
  holidayIdParamSchema,
} from './holiday.validation.js';
import * as holidayController from './holiday.controller.js';

const router = Router();

router.use(requireAuth);

const canManageHolidays = requireSectionAccess('holidays', 'write');

router.get('/', validate({ query: listHolidaysSchema }), asyncHandler(holidayController.list));
router.post('/', canManageHolidays, validate({ body: createHolidaySchema }), asyncHandler(holidayController.create));
router.patch(
  '/:id',
  canManageHolidays,
  validate({ params: holidayIdParamSchema, body: updateHolidaySchema }),
  asyncHandler(holidayController.update)
);
router.delete(
  '/:id',
  canManageHolidays,
  validate({ params: holidayIdParamSchema }),
  asyncHandler(holidayController.remove)
);

export default router;

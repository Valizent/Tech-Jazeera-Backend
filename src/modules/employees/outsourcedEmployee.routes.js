import { Router } from 'express';
import * as controller from './outsourcedEmployee.controller.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';

const router = Router();

router.use(requireAuth);

// Fixed 2026-09-30: 'employees' is not a real Section Access key (see
// sectionAccess.model.js's SECTION_KEYS) — canAccessSection silently found
// no grants for it and fell through to Admin-only forever, while the
// client's own route guard (router.jsx) already correctly gates this whole
// page on 'employeeCreate', the real key the rest of the Employees module
// uses. Aligned to match.
router.get('/', asyncHandler(controller.list));
router.post('/', requireSectionAccess('employeeCreate', 'write'), asyncHandler(controller.create));
router.get('/:id', asyncHandler(controller.get));
router.patch('/:id', requireSectionAccess('employeeCreate', 'write'), asyncHandler(controller.update));
router.delete('/:id', requireSectionAccess('employeeCreate', 'write'), asyncHandler(controller.remove));

export default router;

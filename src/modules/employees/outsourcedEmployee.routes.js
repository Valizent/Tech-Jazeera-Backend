import { Router } from 'express';
import * as controller from './outsourcedEmployee.controller.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(controller.list));
router.post('/', requireSectionAccess('employees', 'write'), asyncHandler(controller.create));
router.get('/:id', asyncHandler(controller.get));
router.patch('/:id', requireSectionAccess('employees', 'write'), asyncHandler(controller.update));
router.delete('/:id', requireSectionAccess('employees', 'write'), asyncHandler(controller.remove));

export default router;

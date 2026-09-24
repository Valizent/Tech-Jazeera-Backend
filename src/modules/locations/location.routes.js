/**
 * Location routes — the shared "site / location" picklist.
 *
 * Read/Create: any staff (every Requirement/Mobilisation coordinator needs
 * this to populate its picker and add a new one inline). Delete: Admin only
 * (2026-09-24, the user's own explicit ask — stricter than JobTitle's
 * Admin/Manager/ApprovalRole delete circle, since removing a location from
 * the shared list is the one operation here that could surprise someone
 * else mid-typing).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff, requireRoles } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { createLocationSchema, locationIdParamSchema } from './location.validation.js';
import * as locationController from './location.controller.js';

const router = Router();

router.use(requireAuth, requireStaff);

router.get('/', asyncHandler(locationController.list));
router.post('/', validate({ body: createLocationSchema }), asyncHandler(locationController.create));
router.delete('/:id', requireRoles('Admin'), validate({ params: locationIdParamSchema }), asyncHandler(locationController.remove));

export default router;

/**
 * Standalone "my profile" routes for the full staff panel (Manager, HR,
 * Accounts, Coordinator, Executive, Office Secretary) — everyone else
 * already has an equivalent: Worker/Staff via the ESS me.routes.js router,
 * Admin excluded since Admin has no linked Employee record at all to edit.
 *
 * Deliberately just the profile GET/PATCH, not the rest of the ESS surface
 * (leave/attendance/advances/reimbursements/etc) — those roles already have
 * their own staff-side submission paths for that business logic; handing
 * them the ESS versions too would be a confusing duplicate route. Reuses
 * me.controller.js / me.service.js / me.validation.js verbatim — same
 * self-service guarantee (resolves against req.user.employee only, never a
 * client-supplied id) and the exact same editable field set (mobile,
 * contact email, accommodation, emergency contact).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { updateMyProfileSchema } from './me.validation.js';
import * as meController from './me.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireRoles('Manager', 'HR', 'Accounts', 'Coordinator', 'Executive', 'Office Secretary'));

router.get('/', asyncHandler(meController.getProfile));
router.patch('/', validate({ body: updateMyProfileSchema }), asyncHandler(meController.updateProfile));

export default router;

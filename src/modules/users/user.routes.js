/**
 * Staff-user routes (P2-M2).
 *
 * Role design: only Admin edits staff logins — account management is the
 * smallest, most sensitive circle in the app; update/reset-password/delete
 * stay hardcoded Admin-only, deliberately not moved onto Section Access.
 * LIST (to pick a Coordinator, or an Employee's manager, in a picker) is
 * Section Access key 'team' at the 'read' level, default ['Manager','HR']
 * — matches today's circle exactly. This key has no write tier at all
 * (its write default is permanently empty — see sectionAccess.service.js) —
 * account management staying hardcoded-Admin-only above is exactly why.
 * Creation lives on the employees module (every login starts from an
 * Employee record) — see employee.routes.js's POST /:id/user.
 * Every route is staff-only by definition (it manages staff accounts), so
 * requireStaff isn't needed on top of the explicit roles.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { updateStaffUserSchema, listStaffUsersSchema, userIdParamSchema } from './user.validation.js';
import * as userController from './user.controller.js';

const router = Router();

router.use(requireAuth);

router.get(
  '/',
  requireSectionAccess('team', 'read'),
  validate({ query: listStaffUsersSchema }),
  asyncHandler(userController.list)
);
router.patch(
  '/:id',
  requireRoles('Admin'),
  validate({ params: userIdParamSchema, body: updateStaffUserSchema }),
  asyncHandler(userController.update)
);
router.post(
  '/:id/reset-password',
  requireRoles('Admin'),
  validate({ params: userIdParamSchema }),
  asyncHandler(userController.resetPassword)
);
router.delete(
  '/:id',
  requireRoles('Admin'),
  validate({ params: userIdParamSchema }),
  asyncHandler(userController.remove)
);

export default router;

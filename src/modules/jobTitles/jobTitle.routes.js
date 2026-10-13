/**
 * JobTitle routes.
 *
 * Read: any staff (every mobilisation-creating Coordinator needs this list
 * to populate the picker). Write: Admin/Manager/any ApprovalRole member —
 * a dynamic check the controller runs itself (see canManageJobTitles).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaff } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createJobTitleSchema,
  updateJobTitleSchema,
  listJobTitlesSchema,
  jobTitleIdParamSchema,
} from './jobTitle.validation.js';
import * as jobTitleController from './jobTitle.controller.js';

const router = Router();

router.use(requireAuth, requireStaff);

router.get('/', validate({ query: listJobTitlesSchema }), asyncHandler(jobTitleController.list));
router.post('/', validate({ body: createJobTitleSchema }), asyncHandler(jobTitleController.create));
router.patch(
  '/:id',
  validate({ params: jobTitleIdParamSchema, body: updateJobTitleSchema }),
  asyncHandler(jobTitleController.update)
);
// 2026-10-13 (Section Access redesign): deleting a record is Admin only in every module.
router.delete('/:id', requireRoles('Admin'), validate({ params: jobTitleIdParamSchema }), asyncHandler(jobTitleController.remove));

export default router;

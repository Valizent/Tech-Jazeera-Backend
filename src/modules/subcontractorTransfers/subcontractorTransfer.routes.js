/**
 * Subcontractor transfer routes (2026-10-12). Any staff login may list (a
 * non-decider only sees the requests they raised); deciding is checked in the
 * service against the Mobilisation workflow's final-step approvers.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { listTransfersSchema, transferIdParamSchema, decideTransferSchema } from './subcontractorTransfer.validation.js';
import * as transferController from './subcontractorTransfer.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

router.get('/', validate({ query: listTransfersSchema }), asyncHandler(transferController.list));
router.patch(
  '/:id/decide',
  validate({ params: transferIdParamSchema, body: decideTransferSchema }),
  asyncHandler(transferController.decide)
);

export default router;

/**
 * Subcontractor routes.
 *
 * Role design: READ is Section Access key 'subcontractorsManage' at the
 * 'read' level (default mirrors write — Coordinators need it for the
 * mobilisation-create picker). WRITE/DELETE is the same key at 'write',
 * default ['Manager'] — matches today's Admin/Manager circle exactly.
 * Delete is folded into the same key rather than kept separately
 * hardcoded, since it was already the same tier as create/update here (no
 * stricter delete-only circle to preserve as an extra safety rail) — same
 * reasoning as EOSB's collapse.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createSubcontractorSchema,
  updateSubcontractorSchema,
  listSubcontractorsSchema,
  subcontractorIdParamSchema,
} from './subcontractor.validation.js';
import * as subcontractorController from './subcontractor.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

const canRead = requireSectionAccess('subcontractorsManage', 'read');
const canWrite = requireSectionAccess('subcontractorsManage', 'write');

router.get('/', canRead, validate({ query: listSubcontractorsSchema }), asyncHandler(subcontractorController.list));
router.get('/:id', canRead, validate({ params: subcontractorIdParamSchema }), asyncHandler(subcontractorController.get));
router.post(
  '/',
  canWrite,
  validate({ body: createSubcontractorSchema }),
  asyncHandler(subcontractorController.create)
);
router.patch(
  '/:id',
  canWrite,
  validate({ params: subcontractorIdParamSchema, body: updateSubcontractorSchema }),
  asyncHandler(subcontractorController.update)
);
router.delete(
  '/:id',
  canWrite,
  validate({ params: subcontractorIdParamSchema }),
  asyncHandler(subcontractorController.remove)
);

export default router;

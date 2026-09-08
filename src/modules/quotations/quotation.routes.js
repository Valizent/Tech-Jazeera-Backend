/**
 * Quotation routes.
 *
 * Roles: quotations are commercial documents. Read/PDF is Section Access key
 * 'quotationsManage' at the 'read' level (default mirrors write — see
 * sectionAccess.service.js); create/update/duplicate is the same key at
 * 'write', default ['Manager','Accounts'] — matches today's circle exactly;
 * delete stays hardcoded Admin/Manager only, an extra safety rail.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createQuotationSchema,
  updateQuotationSchema,
  listQuotationsSchema,
  quotationIdParamSchema,
} from './quotation.validation.js';
import * as quotationController from './quotation.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff); // staff-only module; Workers use the ESS portal (P2-M2)

const canRead = requireSectionAccess('quotationsManage', 'read');
const canWrite = requireSectionAccess('quotationsManage', 'write');
const canDelete = requireRoles('Admin', 'Manager');

router.get('/', canRead, validate({ query: listQuotationsSchema }), asyncHandler(quotationController.list));
router.get('/:id', canRead, validate({ params: quotationIdParamSchema }), asyncHandler(quotationController.get));
router.get(
  '/:id/pdf',
  canRead,
  validate({ params: quotationIdParamSchema }),
  asyncHandler(quotationController.pdf)
);
router.post('/', canWrite, validate({ body: createQuotationSchema }), asyncHandler(quotationController.create));
router.post(
  '/:id/duplicate',
  canWrite,
  validate({ params: quotationIdParamSchema }),
  asyncHandler(quotationController.duplicate)
);
router.patch(
  '/:id',
  canWrite,
  validate({ params: quotationIdParamSchema, body: updateQuotationSchema }),
  asyncHandler(quotationController.update)
);
router.delete(
  '/:id',
  canDelete,
  validate({ params: quotationIdParamSchema }),
  asyncHandler(quotationController.remove)
);

export default router;

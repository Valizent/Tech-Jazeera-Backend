/**
 * Payroll routes (P2-M5). Salary data is sensitive — access is the generic,
 * admin-configurable Section Access mechanism (see sectionAccess.model.js):
 * by default only Accounts (plus Admin, always) can reach this module at
 * all, both tiers starting identical (Read = Write on day one) — an Admin
 * can since diverge them (e.g. let someone view runs/payslips without
 * being able to create/edit/finalize/delete) from the Section Access
 * settings page. Every mutation is still audit-logged regardless of who
 * performs it (see payroll.service.js's logAudit calls).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createPayrollRunSchema,
  updatePayrollLineSchema,
  listPayrollRunsSchema,
  payrollRunIdParamSchema,
  payrollLineParamSchema,
} from './payroll.validation.js';
import * as payrollController from './payroll.controller.js';

const router = Router();

router.use(requireAuth);

const canRead = requireSectionAccess('payroll', 'read');
const canWrite = requireSectionAccess('payroll', 'write');

router.get('/', canRead, validate({ query: listPayrollRunsSchema }), asyncHandler(payrollController.list));
router.get('/:id', canRead, validate({ params: payrollRunIdParamSchema }), asyncHandler(payrollController.get));
router.get(
  '/:id/lines/:lineId/pdf',
  canRead,
  validate({ params: payrollLineParamSchema }),
  asyncHandler(payrollController.pdf)
);
router.post('/', canWrite, validate({ body: createPayrollRunSchema }), asyncHandler(payrollController.create));
router.patch(
  '/:id/lines/:lineId',
  canWrite,
  validate({ params: payrollLineParamSchema, body: updatePayrollLineSchema }),
  asyncHandler(payrollController.updateLine)
);
router.patch(
  '/:id/finalize',
  canWrite,
  validate({ params: payrollRunIdParamSchema }),
  asyncHandler(payrollController.finalize)
);
router.delete('/:id', canWrite, validate({ params: payrollRunIdParamSchema }), asyncHandler(payrollController.remove));

export default router;

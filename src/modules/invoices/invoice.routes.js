/**
 * Invoice routes (P2-M6).
 *
 * Roles: invoices are financial documents — Section Access key 'invoices'
 * governs everything below except delete (Admin/Manager only, an extra
 * safety rail on the single most destructive action, same posture as
 * Quotations/Clients — see sectionAccess.model.js's design notes). Read
 * ('read' level, both tiers starting identical) and create/record-payment
 * ('write' level) both narrowed from "any staff" to the 'invoices' circle —
 * a deliberate change per the financial-document classification, not an
 * oversight.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createInvoiceSchema,
  recordPaymentSchema,
  listInvoicesSchema,
  invoiceIdParamSchema,
} from './invoice.validation.js';
import * as invoiceController from './invoice.controller.js';

const router = Router();

router.use(requireAuth);

const canRead = requireSectionAccess('invoices', 'read');
const canWrite = requireSectionAccess('invoices', 'write');
const canDelete = requireRoles('Admin', 'Manager');

router.get('/', canRead, validate({ query: listInvoicesSchema }), asyncHandler(invoiceController.list));
router.get('/:id', canRead, validate({ params: invoiceIdParamSchema }), asyncHandler(invoiceController.get));
router.get('/:id/pdf', canRead, validate({ params: invoiceIdParamSchema }), asyncHandler(invoiceController.pdf));
router.post('/', canWrite, validate({ body: createInvoiceSchema }), asyncHandler(invoiceController.create));
router.post(
  '/:id/payments',
  canWrite,
  validate({ params: invoiceIdParamSchema, body: recordPaymentSchema }),
  asyncHandler(invoiceController.recordPayment)
);
router.delete('/:id', canDelete, validate({ params: invoiceIdParamSchema }), asyncHandler(invoiceController.remove));

export default router;

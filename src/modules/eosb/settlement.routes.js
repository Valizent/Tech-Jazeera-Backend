/**
 * EOSB settlement routes (P3-A).
 *
 * Roles: this is a financial/HR-compliance document — Section Access key
 * 'eosb' now governs the whole module, including delete (unlike Invoices/
 * Quotations/Clients, delete here was already inside the same tier as
 * create, not a stricter one, so folding it in removes no extra safety
 * rail — see sectionAccess.model.js's design notes). Default
 * ['Manager','HR','Accounts'] matches the old read floor exactly; Accounts
 * gains create/delete it didn't have before, same "one unified circle"
 * collapse Payroll/Expenses already went through.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { createSettlementSchema, listSettlementsSchema, settlementIdParamSchema } from './settlement.validation.js';
import * as settlementController from './settlement.controller.js';

const router = Router();

router.use(requireAuth);

const canRead = requireSectionAccess('eosb', 'read');
const canWrite = requireSectionAccess('eosb', 'write');

router.get('/', canRead, validate({ query: listSettlementsSchema }), asyncHandler(settlementController.list));
router.get('/:id', canRead, validate({ params: settlementIdParamSchema }), asyncHandler(settlementController.get));
router.get('/:id/pdf', canRead, validate({ params: settlementIdParamSchema }), asyncHandler(settlementController.pdf));
router.post('/', canWrite, validate({ body: createSettlementSchema }), asyncHandler(settlementController.create));
router.delete('/:id', canWrite, validate({ params: settlementIdParamSchema }), asyncHandler(settlementController.remove));

export default router;

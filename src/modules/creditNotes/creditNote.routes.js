/**
 * Credit note routes (2026-09-24) — flat, `invoice` referenced by id in the
 * body/query, same shape Invoice itself uses for `quotation` rather than
 * nesting under it. Gated on the same 'invoices' Section Access circle that
 * already governs recording a payment — a credit note is the same
 * sensitivity class of action on the same document. No delete route: once
 * issued, permanent (see creditNote.model.js's own doc comment).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { createCreditNoteSchema, listCreditNotesSchema, creditNoteIdParamSchema } from './creditNote.validation.js';
import * as creditNoteController from './creditNote.controller.js';

const router = Router();

router.use(requireAuth);

const canRead = requireSectionAccess('invoices', 'read');
const canWrite = requireSectionAccess('invoices', 'write');

router.get('/', canRead, validate({ query: listCreditNotesSchema }), asyncHandler(creditNoteController.list));
router.get('/:id', canRead, validate({ params: creditNoteIdParamSchema }), asyncHandler(creditNoteController.get));
router.get('/:id/pdf', canRead, validate({ params: creditNoteIdParamSchema }), asyncHandler(creditNoteController.pdf));
router.post('/', canWrite, validate({ body: createCreditNoteSchema }), asyncHandler(creditNoteController.create));

export default router;

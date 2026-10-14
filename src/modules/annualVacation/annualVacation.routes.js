/**
 * Annual Vacation routes — the staff-facing half. A Worker/Staff login files
 * and tracks their own through /api/me instead (see the `me` module).
 *
 * Access:
 *   - GET /            the review queue — Section Access 'annualVacation' Read.
 *   - PATCH /:id/decide  approve/reject — 'annualVacation' Write, then the shared
 *                        approval engine decides who may act on a given step.
 *   - POST /           file a request: for yourself (any staff login with a linked
 *                      employee) or, with Write on the key, for another employee.
 *   - GET /mine, PATCH /:id/cancel   a staff login's own requests.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaffOrExecutive } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadMultiple, uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import logger from '../../config/logger.js';
import {
  submitAnnualVacationSchema,
  decideAnnualVacationSchema,
  listAnnualVacationSchema,
  listMyAnnualVacationSchema,
  annualVacationIdParamSchema,
  changeVacationDaysSchema,
  attachTicketsSchema,
  visaDocumentSchema,
  vacationTicketParamSchema,
  eligibilityQuerySchema,
} from './annualVacation.validation.js';
import * as controller from './annualVacation.controller.js';

const router = Router();

router.use(requireAuth, requireStaffOrExecutive);

router.get('/', requireSectionAccess('annualVacation', 'read'), validate({ query: listAnnualVacationSchema }), asyncHandler(controller.list));
router.get('/mine', validate({ query: listMyAnnualVacationSchema }), asyncHandler(controller.listMine));
router.get('/eligibility', validate({ query: eligibilityQuerySchema }), asyncHandler(controller.eligibility));
router.post('/', validate({ body: submitAnnualVacationSchema }), asyncHandler(controller.submit));
router.patch(
  '/:id/cancel',
  validate({ params: annualVacationIdParamSchema }),
  asyncHandler(controller.cancel)
);
// HR's days and Accounts' tickets/visa: Can change on the section, then the step's own roles (see the service).
// The two file downloads decide access in the service (the employee's own, or a reader of the section).
const canChange = requireSectionAccess('annualVacation', 'write');
router.patch('/:id/days', canChange, validate({ params: annualVacationIdParamSchema, body: changeVacationDaysSchema }), asyncHandler(controller.changeDays));
router.post(
  '/:id/tickets',
  canChange,
  validate({ params: annualVacationIdParamSchema }),
  uploadMultiple,
  validate({ body: attachTicketsSchema }),
  asyncHandler(controller.attachTickets)
);
router.delete('/:id/tickets/:fileId', canChange, validate({ params: vacationTicketParamSchema }), asyncHandler(controller.removeTicket));
router.post(
  '/:id/visa',
  canChange,
  validate({ params: annualVacationIdParamSchema }),
  uploadSingle,
  validate({ body: visaDocumentSchema }),
  asyncHandler(controller.uploadVisa)
);
router.get('/:id/tickets/:fileId/file', validate({ params: vacationTicketParamSchema }), asyncHandler(controller.ticketFile));
router.get('/:id/visa/file', validate({ params: annualVacationIdParamSchema }), asyncHandler(controller.visaFile));

router.patch(
  '/:id/decide',
  requireSectionAccess('annualVacation', 'write'),
  validate({ params: annualVacationIdParamSchema, body: decideAnnualVacationSchema }),
  asyncHandler(controller.decide)
);

/** An upload whose request then failed is removed from storage again (same cleanup as the other upload routes). */
router.use((err, req, res, next) => {
  for (const file of [...(req.files ?? []), ...(req.file ? [req.file] : [])]) {
    if (!file.filename) continue;
    destroyDocumentFile(file.filename).catch((cleanupErr) =>
      logger.error(`[annualVacation] orphaned upload ${file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

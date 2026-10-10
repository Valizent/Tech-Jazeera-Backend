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
import {
  submitAnnualVacationSchema,
  decideAnnualVacationSchema,
  listAnnualVacationSchema,
  listMyAnnualVacationSchema,
  annualVacationIdParamSchema,
} from './annualVacation.validation.js';
import * as controller from './annualVacation.controller.js';

const router = Router();

router.use(requireAuth, requireStaffOrExecutive);

router.get('/', requireSectionAccess('annualVacation', 'read'), validate({ query: listAnnualVacationSchema }), asyncHandler(controller.list));
router.get('/mine', validate({ query: listMyAnnualVacationSchema }), asyncHandler(controller.listMine));
router.post('/', validate({ body: submitAnnualVacationSchema }), asyncHandler(controller.submit));
router.patch(
  '/:id/cancel',
  validate({ params: annualVacationIdParamSchema }),
  asyncHandler(controller.cancel)
);
router.patch(
  '/:id/decide',
  requireSectionAccess('annualVacation', 'write'),
  validate({ params: annualVacationIdParamSchema, body: decideAnnualVacationSchema }),
  asyncHandler(controller.decide)
);

export default router;

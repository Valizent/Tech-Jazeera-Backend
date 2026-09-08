/**
 * Financial requests routes (P3-C). Workers submit their own advance/
 * reimbursement requests through /api/me instead; this router is the staff
 * review queue plus the actions staff perform (submit their OWN request,
 * decide, record a repayment, mark paid).
 *
 * Roles: only DECIDE (both advances and reimbursements) moves to Section
 * Access key 'financialRequests', default
 * ['Manager','HR','Accounts','Coordinator','Executive'] — deliberately the
 * FULL original requireStaffOrExecutive floor, not narrowed. Deciding is
 * really governed by the shared approvalEngine once a workflow governs a
 * request (see approvalEngine.service.js's resolveStepAuthority), which can
 * legitimately authorize ANY staff role — e.g. a Coordinator who is a real
 * ApprovalRole member on a configured step, exactly like the company's real
 * Mobilisation hierarchy already allows. A narrower Section Access default
 * here would sit IN FRONT of that check and could silently block a
 * workflow-authorized decider before the engine ever runs — this key exists
 * so an Admin CAN narrow it deliberately, not so the rollout narrows it for
 * them. The legacy (no workflow) path still enforces its own stricter
 * Admin/Manager/HR-only rule (LEGACY_DECIDE_ROLES) independently, untouched.
 *
 * LIST and SUBMIT deliberately stay on requireStaffOrExecutive, UNCHANGED:
 * Coordinator was excluded from the review queue by the original design
 * (money matters kept in a narrower circle than Leave), but the Approval
 * Hierarchy's staff self-submission (P2-M4+) reopens exactly two doors for
 * Coordinator on these same two endpoints — submitting their own request,
 * and then seeing ONLY that request in the list (see advance.service.js/
 * reimbursement.service.js's Coordinator self-scoping) — never the
 * company-wide queue.
 *
 * Recording money actually changing hands (a repayment, marking a claim
 * paid) is untouched — never part of "deciding," so it keeps its original
 * Admin/Manager/HR/Accounts-only gate (canHandleMoney), Executive excluded,
 * deliberately NOT folded into 'financialRequests'.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../config/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaffOrExecutive } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import {
  submitAdvanceSchema,
  decideAdvanceSchema,
  addRepaymentSchema,
  listAdvancesSchema,
  advanceIdParamSchema,
} from './advance.validation.js';
import {
  submitReimbursementSchema,
  decideReimbursementSchema,
  listReimbursementsSchema,
  reimbursementIdParamSchema,
} from './reimbursement.validation.js';
import * as advanceController from './advance.controller.js';
import * as reimbursementController from './reimbursement.controller.js';

const router = Router();

router.use(requireAuth);

const canDecideFinancialRequests = requireSectionAccess('financialRequests', 'write');
const canHandleMoney = requireRoles('Admin', 'Manager', 'HR', 'Accounts');

router.get(
  '/advances',
  requireStaffOrExecutive,
  validate({ query: listAdvancesSchema }),
  asyncHandler(advanceController.list)
);
router.post(
  '/advances',
  requireStaffOrExecutive,
  validate({ body: submitAdvanceSchema }),
  asyncHandler(advanceController.submit)
);
router.patch(
  '/advances/:id/decide',
  canDecideFinancialRequests,
  validate({ params: advanceIdParamSchema, body: decideAdvanceSchema }),
  asyncHandler(advanceController.decide)
);
router.post(
  '/advances/:id/repayments',
  canHandleMoney,
  validate({ params: advanceIdParamSchema, body: addRepaymentSchema }),
  asyncHandler(advanceController.addRepayment)
);

router.get(
  '/reimbursements',
  requireStaffOrExecutive,
  validate({ query: listReimbursementsSchema }),
  asyncHandler(reimbursementController.list)
);
router.post(
  '/reimbursements',
  requireStaffOrExecutive,
  uploadSingle,
  validate({ body: submitReimbursementSchema }),
  asyncHandler(reimbursementController.submit)
);
// NOT widened to requireStaff: getReceiptFile() has no per-claim ownership
// scoping (any id fetches any receipt), so keeping this at the ORIGINAL
// review-circle-only gate is a deliberate security choice, not an oversight
// — a Coordinator viewing their own receipt again post-submission is a
// minor UX gap, not worth opening every claim's receipt to every staff role.
router.get(
  '/reimbursements/:id/receipt',
  canHandleMoney,
  validate({ params: reimbursementIdParamSchema }),
  asyncHandler(reimbursementController.receipt)
);
router.patch(
  '/reimbursements/:id/decide',
  canDecideFinancialRequests,
  validate({ params: reimbursementIdParamSchema, body: decideReimbursementSchema }),
  asyncHandler(reimbursementController.decide)
);
router.patch(
  '/reimbursements/:id/pay',
  canHandleMoney,
  validate({ params: reimbursementIdParamSchema }),
  asyncHandler(reimbursementController.markPaid)
);

/** Same orphaned-upload cleanup as me.routes.js/document.routes.js — only
 *  the reimbursement POST above ever sets req.file on this router. */
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[financial-requests] orphaned receipt upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

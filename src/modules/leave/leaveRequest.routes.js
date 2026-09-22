/**
 * Leave request routes (P2-M2) — the staff review queue. Workers submit/
 * view/cancel their OWN requests through /api/me/leave instead (see the
 * `me` module).
 *
 * Split out of the old combined `leave.routes.js` (2026-09-22, a real
 * QA-audit finding — P2) — see leaveType.routes.js's doc comment for the
 * double-authentication bug this split fixes. Mounted at its own real
 * prefix, `/api/leave`.
 *
 * Section Access key 'leaveRequests', default ['Manager','HR','Accounts',
 * 'Coordinator','Executive'] — matches the old requireStaffOrExecutive
 * floor exactly, on every route here uniformly (no per-route carve-out
 * needed, unlike financialRequests, since this floor was already uniform
 * and already this wide). An Executive (GM/COO) needs to see the queue,
 * submit their own request, and decide whatever step they're a real
 * ApprovalRole member of — the engine re-checks that membership itself.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../config/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import { listLeaveRequestsSchema, submitLeaveRequestSchema, decideLeaveRequestSchema, leaveRequestIdParamSchema } from './leave.validation.js';
import * as leaveController from './leave.controller.js';

const router = Router();

router.use(requireAuth);

const canReadLeaveRequests = requireSectionAccess('leaveRequests', 'read');
const canWriteLeaveRequests = requireSectionAccess('leaveRequests', 'write');

router.get('/', canReadLeaveRequests, validate({ query: listLeaveRequestsSchema }), asyncHandler(leaveController.list));
// A staff member submitting their OWN leave request (Coordinator/HR/Manager/
// Accounts) — the self-submission gap the Approval Hierarchy work filled.
// Admin has no Employee record and gets a clear 400 from the controller.
router.post('/', canWriteLeaveRequests, uploadSingle, validate({ body: submitLeaveRequestSchema }), asyncHandler(leaveController.submit));
router.get(
  '/:id/attachment',
  canReadLeaveRequests,
  validate({ params: leaveRequestIdParamSchema }),
  asyncHandler(leaveController.attachment)
);
// Once ApprovalRole membership is decoupled from User.role, an Admin could
// legitimately put an Accounts user into a workflow step — the shared
// engine (approvalEngine.service.js) is the REAL authorization now; this
// floor just confirms "someone in the granted circle is asking." A request
// not yet on a workflow still enforces the original Admin/Manager/HR/
// Coordinator gate itself, inside the engine's legacy path — a granted
// viewer with no workflow membership can reach this route but can't decide
// anything on it.
router.patch(
  '/:id/decide',
  canWriteLeaveRequests,
  validate({ params: leaveRequestIdParamSchema, body: decideLeaveRequestSchema }),
  asyncHandler(leaveController.decide)
);
router.patch(
  '/:id/acknowledge',
  requireRoles('Admin', 'Manager', 'HR', 'Coordinator'),
  validate({ params: leaveRequestIdParamSchema }),
  asyncHandler(leaveController.acknowledge)
);

/** Same orphaned-upload cleanup as document.routes.js/financialRequests.routes.js
 *  — only the POST above ever sets req.file on this router. */
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[leave] orphaned attachment upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

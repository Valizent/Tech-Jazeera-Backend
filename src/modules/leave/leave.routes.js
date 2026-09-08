/**
 * Leave routes (P2-M2).
 *
 * Two resources share this module: LeaveType (policy config) and LeaveRequest
 * (the staff review queue). Workers submit/view/cancel their OWN requests
 * through /api/me/leave instead (see the `me` module) — this router is the
 * staff-facing half, plus the read-only leave-types list every authenticated
 * user (including Worker) needs to populate a submission form.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../config/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import {
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
  listLeaveTypesSchema,
  leaveTypeIdParamSchema,
  listLeaveRequestsSchema,
  submitLeaveRequestSchema,
  decideLeaveRequestSchema,
  leaveRequestIdParamSchema,
} from './leave.validation.js';
import * as leaveController from './leave.controller.js';

const router = Router();

router.use(requireAuth);

// Leave types: readable by anyone authenticated (a Worker needs this list to
// submit); only Admin/HR shape the policy — this is company leave policy
// configuration, not a day-to-day operational manager's job.
router.get(
  '/leave-types',
  validate({ query: listLeaveTypesSchema }),
  asyncHandler(leaveController.listTypes)
);
router.post(
  '/leave-types',
  requireRoles('Admin', 'HR'),
  validate({ body: createLeaveTypeSchema }),
  asyncHandler(leaveController.createType)
);
router.patch(
  '/leave-types/:id',
  requireRoles('Admin', 'HR'),
  validate({ params: leaveTypeIdParamSchema, body: updateLeaveTypeSchema }),
  asyncHandler(leaveController.updateType)
);

// Leave requests: the staff review queue. Workers use /api/me/leave.
// M7 (optional zero-regression floor migration): Section Access key
// 'leaveRequests', default ['Manager','HR','Accounts','Coordinator',
// 'Executive'] — matches the old requireStaffOrExecutive floor exactly, on
// all four of these routes uniformly (no per-route carve-out needed, unlike
// financialRequests, since this floor was already uniform and already this
// wide). An Executive (GM/COO) needs to see the queue, submit their own
// request, and decide whatever step they're a real ApprovalRole member of —
// the engine re-checks that membership itself.
const canReadLeaveRequests = requireSectionAccess('leaveRequests', 'read');
const canWriteLeaveRequests = requireSectionAccess('leaveRequests', 'write');
router.get(
  '/leave',
  canReadLeaveRequests,
  validate({ query: listLeaveRequestsSchema }),
  asyncHandler(leaveController.list)
);
// A staff member submitting their OWN leave request (Coordinator/HR/Manager/
// Accounts) — the self-submission gap the Approval Hierarchy work filled.
// Admin has no Employee record and gets a clear 400 from the controller.
router.post(
  '/leave',
  canWriteLeaveRequests,
  uploadSingle,
  validate({ body: submitLeaveRequestSchema }),
  asyncHandler(leaveController.submit)
);
router.get(
  '/leave/:id/attachment',
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
  '/leave/:id/decide',
  canWriteLeaveRequests,
  validate({ params: leaveRequestIdParamSchema, body: decideLeaveRequestSchema }),
  asyncHandler(leaveController.decide)
);
router.patch(
  '/leave/:id/acknowledge',
  requireRoles('Admin', 'Manager', 'HR', 'Coordinator'),
  validate({ params: leaveRequestIdParamSchema }),
  asyncHandler(leaveController.acknowledge)
);

/** Same orphaned-upload cleanup as document.routes.js/financialRequests.routes.js
 *  — only the leave POST above ever sets req.file on this router. */
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[leave] orphaned attachment upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

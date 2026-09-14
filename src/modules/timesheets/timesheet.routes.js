/**
 * Timesheet routes (P2-M3b). Section Access key 'timesheetRequests' (M7,
 * optional) covers this whole router now. There is no code-level default
 * role list any more — Section Access grants by ApprovalRole membership
 * only (readApprovalRoles/writeApprovalRoles); with nothing granted, this
 * defaults to Admin-only (see sectionAccess.service.js's defaultFor). The
 * real, current circle for this key lives in the Section Access admin page/
 * DB, not here. Coordinator self-submission (P2-M4+) and Executive access
 * both flow through whatever real grant exists, same as everyone else —
 * only decide/bulk-approve go beyond this router floor, because the shared
 * approvalEngine is the REAL gate once a workflow governs a request (see
 * approvalEngine.service.js); the legacy (no workflow) path still enforces
 * its own original rule. monthly-report also has its own inner
 * Admin-or-ApprovalRole-member check beyond this floor.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  submitTimesheetSchema,
  decideTimesheetSchema,
  bulkApproveTimesheetSchema,
  listTimesheetsSchema,
  timesheetIdParamSchema,
  generateMonthlyReportSchema,
} from './timesheet.validation.js';
import * as timesheetController from './timesheet.controller.js';

const router = Router();

router.use(requireAuth);

const canRead = requireSectionAccess('timesheetRequests', 'read');
const canWrite = requireSectionAccess('timesheetRequests', 'write');

router.get('/', canRead, validate({ query: listTimesheetsSchema }), asyncHandler(timesheetController.list));
router.post('/', canWrite, validate({ body: submitTimesheetSchema }), asyncHandler(timesheetController.submit));
router.patch(
  '/:id/decide',
  canWrite,
  validate({ params: timesheetIdParamSchema, body: decideTimesheetSchema }),
  asyncHandler(timesheetController.decide)
);
router.post(
  '/bulk-approve',
  canWrite,
  validate({ body: bulkApproveTimesheetSchema }),
  asyncHandler(timesheetController.bulkApprove)
);
// Beyond the read floor above, the controller itself checks "Admin
// or a real Approval Role member" — see assertReportEligible's doc comment.
// GET returns the JSON preview for the on-screen grid; POST converts the
// same data to the .xlsx download — same eligibility floor, same builder.
router.get(
  '/monthly-report',
  canRead,
  validate({ query: generateMonthlyReportSchema }),
  asyncHandler(timesheetController.getMonthlyReport)
);
router.post(
  '/monthly-report',
  canRead,
  validate({ body: generateMonthlyReportSchema }),
  asyncHandler(timesheetController.generateMonthlyReport)
);

export default router;

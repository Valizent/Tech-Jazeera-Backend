/**
 * Timesheet routes (P2-M3b). Section Access key 'timesheetRequests' (M7,
 * optional) covers this whole router now, default
 * ['Manager','HR','Accounts','Coordinator','Executive'] — matches the old
 * router-wide requireStaffOrExecutive floor exactly, so Coordinator
 * self-submission (P2-M4+) needed no further widening here — only decide/
 * bulk-approve widen beyond the original Admin/Manager/HR-only rule,
 * because the shared approvalEngine is the REAL gate once a workflow
 * governs a request (see approvalEngine.service.js); the legacy (no
 * workflow) path still enforces the original rule itself. Letting Executive
 * (GM/COO) through this router-wide gate is safe the same way: they can
 * reach /bulk-approve and /monthly-report too, but the engine (and
 * monthly-report's own inner Admin-or-ApprovalRole-member check) still
 * gates what actually happens.
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
// or a real Approval Role member" — see generateMonthlyReport's doc comment.
router.post(
  '/monthly-report',
  canRead,
  validate({ body: generateMonthlyReportSchema }),
  asyncHandler(timesheetController.generateMonthlyReport)
);

export default router;

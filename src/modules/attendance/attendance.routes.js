/**
 * Attendance routes.
 *
 * Roles: marking (bulk/adjust) is Section Access key 'attendanceManage' at
 * the 'write' level, default ['Manager','HR'] — matches today's
 * Admin/Manager/HR circle exactly. Reading and exporting are the same key
 * at 'read' (default mirrors write) — Accounts needs the summary for
 * billing/payroll.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  markBulkSchema,
  adjustAttendanceSchema,
  listAttendanceSchema,
  summarySchema,
  exportSchema,
  officeLocationSchema,
} from './attendance.validation.js';
import * as attendanceController from './attendance.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff); // staff-only module; Workers use the ESS portal (P2-M2)

const canReadAttendance = requireSectionAccess('attendanceManage', 'read');
const canManageAttendance = requireSectionAccess('attendanceManage', 'write');

router.post(
  '/bulk',
  canManageAttendance,
  validate({ body: markBulkSchema }),
  asyncHandler(attendanceController.markBulk)
);
router.patch(
  '/adjust',
  canManageAttendance,
  validate({ body: adjustAttendanceSchema }),
  asyncHandler(attendanceController.adjust)
);
router.get('/', canReadAttendance, validate({ query: listAttendanceSchema }), asyncHandler(attendanceController.list));
router.get(
  '/summary',
  canReadAttendance,
  validate({ query: summarySchema }),
  asyncHandler(attendanceController.summary)
);
router.get(
  '/export',
  canReadAttendance,
  validate({ query: exportSchema }),
  asyncHandler(attendanceController.exportSummary)
);

// P2-M3: the geofence Workers' self-marked attendance is checked against.
// Admin-only — it's a security-relevant setting, not a day-to-day action.
router.get('/office-location', requireRoles('Admin'), asyncHandler(attendanceController.getOfficeLocation));
router.patch(
  '/office-location',
  requireRoles('Admin'),
  validate({ body: officeLocationSchema }),
  asyncHandler(attendanceController.updateOfficeLocation)
);

export default router;

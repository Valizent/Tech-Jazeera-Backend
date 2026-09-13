/**
 * Attendance routes — the Records tab only (bulk-mark/adjust an Employee's
 * day, and the grid/summary/export read views). Section Access key
 * 'attendanceRecords' (split off 'attendanceManage' 2026-09-13, alongside
 * Sign In/Out and Office Location becoming their own independently-governed
 * keys — see staffAttendance.routes.js and the office-location routes
 * below): Write is bulk-mark/adjust; Read (default mirrors write) is the
 * grid/summary/export.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
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

const canReadAttendance = requireSectionAccess('attendanceRecords', 'read');
const canManageAttendance = requireSectionAccess('attendanceRecords', 'write');

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
// Section Access key 'attendanceOfficeLocation' (was hardcoded Admin-only;
// split off 2026-09-13) — Admin-only until an Admin explicitly delegates it.
const canReadOfficeLocation = requireSectionAccess('attendanceOfficeLocation', 'read');
const canManageOfficeLocation = requireSectionAccess('attendanceOfficeLocation', 'write');
router.get('/office-location', canReadOfficeLocation, asyncHandler(attendanceController.getOfficeLocation));
router.patch(
  '/office-location',
  canManageOfficeLocation,
  validate({ body: officeLocationSchema }),
  asyncHandler(attendanceController.updateOfficeLocation)
);

export default router;

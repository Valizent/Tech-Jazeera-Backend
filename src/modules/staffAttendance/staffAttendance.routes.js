/**
 * Staff self-attendance routes — the Sign In/Out tab. Section Access key
 * 'attendanceSignInOut' (split off 'attendanceManage' 2026-09-13, alongside
 * Records and Office Location becoming their own independently-governed
 * keys — see attendance.routes.js):
 *
 * - Write: eligible to self-mark (punch) your OWN attendance from that tab,
 *   and see your own history there. Both resolve against req.user.id, never
 *   a client-supplied user id — same self-service guarantee as the /api/me
 *   module for Workers. Admin is exempt from personal clock-in by design
 *   (there is no punch button for Admin regardless of this grant); Workers
 *   already have their own equivalent via Employee-based Attendance + the
 *   ESS portal, unaffected by this key.
 * - Read (GET /all — everyone's punches, not just your own): the oversight
 *   view, so this data isn't only visible to the people generating it. Write
 *   always implies Read, so anyone eligible to self-mark can also see
 *   everyone else's punches — a deliberate, small widening versus the old
 *   hardcoded shape (previously Coordinator/Accounts could punch but not see
 *   the oversight list), the same "Write implies Read, no exceptions"
 *   convention every other Section Access key already follows.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { selfMarkSchema, listMyAttendanceSchema } from '../attendance/attendance.validation.js';
import { listAllStaffAttendanceSchema } from './staffAttendance.validation.js';
import * as staffAttendanceController from './staffAttendance.controller.js';

const router = Router();

router.use(requireAuth);

const canSelfMark = requireSectionAccess('attendanceSignInOut', 'write');
const canReadSignInOut = requireSectionAccess('attendanceSignInOut', 'read');

router.post('/punch', canSelfMark, validate({ body: selfMarkSchema }), asyncHandler(staffAttendanceController.punch));
router.get(
  '/all',
  canReadSignInOut,
  validate({ query: listAllStaffAttendanceSchema }),
  asyncHandler(staffAttendanceController.listAll)
);
router.get('/', canSelfMark, validate({ query: listMyAttendanceSchema }), asyncHandler(staffAttendanceController.listMine));

export default router;

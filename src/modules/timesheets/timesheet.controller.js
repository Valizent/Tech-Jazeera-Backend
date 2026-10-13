/**
 * Timesheet controller — HTTP translation only. Worker submit/list live in
 * the `me` module; this is the staff-facing review queue, plus a STAFF
 * member submitting their OWN timesheet (Coordinator/HR/Manager/Accounts).
 */
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import Employee from '../employees/employee.model.js';
import { isApprovalRoleMember } from '../approvals/approvals.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import { assertEmployeesInCoordinatorTeam } from '../attendance/attendance.service.js';
import { getLogoForEmbedding } from '../companySettings/companySettings.service.js';
import { buildTimesheetXlsx } from '../timesheetProcessor/timesheet.export.js';
import { XLSX_MIME } from '../timesheetProcessor/timesheet.constants.js';
import { logAudit } from '../audit/audit.service.js';
import * as timesheetService from './timesheet.service.js';
import { buildMonthlyAttendanceReport } from './monthlyReport.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, employee: req.user.employee, ip: req.ip });

export async function list(req, res) {
  const data = await timesheetService.listTimesheets(req.query, actor(req));
  res.json(new ApiResponse('Timesheets.', data));
}

/** POST /api/timesheets — Admin has no Employee record. */
export async function submit(req, res) {
  if (!req.user.employee) {
    throw new ApiError(
      400,
      'Your account has no linked employee record, so there is nothing to submit a personal request against.'
    );
  }
  const timesheet = await timesheetService.submitTimesheet(req.user.employee, req.body, actor(req));
  res.status(201).json(new ApiResponse('Timesheet submitted.', timesheet));
}

export async function decide(req, res) {
  const timesheet = await timesheetService.decideTimesheet(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Timesheet ${timesheet.status.toLowerCase()}.`, timesheet));
}

export async function bulkApprove(req, res) {
  const result = await timesheetService.bulkApproveTimesheets(req.body.ids, actor(req));
  res.json(new ApiResponse(`${result.approved} of ${result.requested} timesheet(s) approved.`, result));
}

/** Shared by both handlers below. Everyone's report: Admin, or anyone the Admin
 *  has put into a real Approval Role (the same dynamic "sits somewhere in the
 *  hierarchy" rule the Approval Log uses) who also holds 'timesheetRequests'
 *  Read. Your OWN report only needs 'timesheetOwn' Read (checked by the route)
 *  and your own employee record as the subject. */
async function assertReportEligible(req, employeeId) {
  const isOwn = Boolean(req.user.employee) && String(req.user.employee) === String(employeeId);
  const sees = { userId: req.user.id, role: req.user.role };
  if (isOwn && (await canAccessSection('timesheetOwn', sees, 'read'))) return;
  const canSeeAll = await canAccessSection('timesheetRequests', sees, 'read');
  const isEligible = req.user.role === 'Admin' || (await isApprovalRoleMember(req.user.id));
  if (!canSeeAll || !isEligible) {
    throw new ApiError(403, canSeeAll ? 'You are not part of any approval role.' : 'You can only open your own timesheet.');
  }
}

/**
 * GET /api/timesheets/monthly-report — the JSON preview behind the Monthly
 * Report tab's on-screen grid (added 2026-09-13, when that tab became a real
 * employee-list → view → export flow instead of a blind download button).
 * Same eligibility floor and same underlying builder as the POST export
 * below — this just returns the data instead of converting it to a file, so
 * the browser can render it before anyone decides whether to export it.
 */
export async function getMonthlyReport(req, res) {
  const { employeeId, month, year } = req.query;
  await assertReportEligible(req, employeeId);

  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  await assertEmployeesInCoordinatorTeam([employeeId], actor(req));

  const result = await buildMonthlyAttendanceReport(employee, { month, year });
  res.json(new ApiResponse('Monthly report.', result));
}

/**
 * POST /api/timesheets/monthly-report — a full day-by-day monthly report
 * built from real attendance (Attendance for the field workforce,
 * StaffAttendance for 'Own'-type internal staff — see
 * monthlyReport.service.js), in the exact same visual format as the
 * Timesheet Processor's export. Same eligibility floor as GET above.
 */
export async function generateMonthlyReport(req, res) {
  const { employeeId, month, year } = req.body;
  await assertReportEligible(req, employeeId);

  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  await assertEmployeesInCoordinatorTeam([employeeId], actor(req));

  const result = await buildMonthlyAttendanceReport(employee, { month, year });
  const logo = await getLogoForEmbedding();
  const buffer = await buildTimesheetXlsx(result, logo);

  await logAudit({
    user: req.user.id,
    action: 'timesheet.monthlyReport.generate',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { month, year },
    ip: req.ip,
  });

  const filename = `timesheet-report_${employee.employeeId}_${year}-${String(month).padStart(2, '0')}.xlsx`;
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

/**
 * "Me" service — the self-service surface a Worker sees over other modules'
 * data (P2-M2). It adds no data of its own; it reads Employee/Document/Leave
 * scoped to req.user.employee, which is exactly the ownership guard the
 * P2-M1 notes deferred to this milestone.
 */
import Document from '../documents/document.model.js';
import * as documentService from '../documents/document.service.js';
import Employee from '../employees/employee.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import * as leaveService from '../leave/leave.service.js';
import * as attendanceService from '../attendance/attendance.service.js';
import * as advanceService from '../financialRequests/advance.service.js';
import * as reimbursementService from '../financialRequests/reimbursement.service.js';
import * as exitReentryService from '../exitDocuments/exitReentry.service.js';
import * as annualVacationService from '../annualVacation/annualVacation.service.js';
import * as certificateService from '../exitDocuments/certificate.service.js';
import * as assetService from '../assets/asset.service.js';
import * as timesheetService from '../timesheets/timesheet.service.js';


export async function getMyProfile(employeeId) {
  const employee = await Employee.findById(employeeId)
    .populate('currentClient', 'companyName')
    .populate('coordinator', 'name email')
    .lean();
  if (!employee) throw new ApiError(404, 'Employee record not found.');
  return employee;
}

/**
 * Self-edit (Milestone 4) — contact-info fields only, validated narrowly by
 * me.validation.js's updateMyProfileSchema before this ever runs. A plain
 * object update implicitly becomes a Mongoose $set; a whole-object
 * emergencyContact replaces the nested subdocument wholesale (same
 * convention as the admin employee.service.js:updateEmployee), which is why
 * the client always resubmits all three sub-fields together.
 */
export async function updateMyProfile(employeeId, body, actor) {
  const employee = await Employee.findByIdAndUpdate(employeeId, body, {
    new: true,
    runValidators: true,
  })
    .populate('currentClient', 'companyName')
    .populate('coordinator', 'name email')
    .lean();
  if (!employee) throw new ApiError(404, 'Employee record not found.');

  await logAudit({
    user: actor.userId,
    action: 'me.profile.update',
    targetType: 'Employee',
    targetId: employee._id,
    meta: { fields: Object.keys(body) },
    ip: actor.ip,
  });
  return employee;
}

export async function listMyDocuments(employeeId, { page = 1, limit = 20 } = {}) {
  return documentService.listDocuments({ page, limit, ownerType: 'Employee', owner: employeeId });
}

/** The ownership guard: a Worker may only ever resolve a file for THEIR OWN document. */
async function assertOwnsDocument(employeeId, documentId) {
  const doc = await Document.findById(documentId).select('ownerType owner').lean();
  if (!doc || doc.ownerType !== 'Employee' || doc.owner.toString() !== employeeId) {
    throw new ApiError(404, 'Document not found.');
  }
}

export async function getMyDocumentFile(employeeId, documentId, version) {
  await assertOwnsDocument(employeeId, documentId);
  return documentService.resolveFile(documentId, version);
}

export async function submitMyLeave(employeeId, body, file, actor) {
  return leaveService.submitLeaveRequest(employeeId, body, file, actor);
}

export async function listMyLeave(employeeId, query) {
  return leaveService.listOwnLeaveRequests(employeeId, query);
}

export async function cancelMyLeave(employeeId, leaveRequestId, actor) {
  return leaveService.cancelLeaveRequest(leaveRequestId, { ...actor, employee: employeeId });
}

export async function getMyLeaveAttachmentFile(employeeId, id) {
  return leaveService.getMyAttachmentFile(employeeId, id);
}

export async function punchMyAttendance(employeeId, body, actor) {
  return attendanceService.selfPunch({ employeeId, ...body }, actor);
}

/** Own attendance history — defaults to the last 30 days when no range is given. */
export async function listMyAttendance(employeeId, { from, to } = {}) {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
  return attendanceService.listAttendance({
    from: from ?? monthAgo.toISOString().slice(0, 10),
    to: to ?? today.toISOString().slice(0, 10),
    employee: employeeId,
  });
}

export async function submitMyAdvance(employeeId, body, actor) {
  return advanceService.submitAdvance(employeeId, body, actor);
}

export async function listMyAdvances(employeeId, query) {
  return advanceService.listOwnAdvances(employeeId, query);
}

export async function cancelMyAdvance(employeeId, id, actor) {
  return advanceService.cancelAdvance(employeeId, id, actor);
}

export async function submitMyReimbursement(employeeId, body, file, actor) {
  return reimbursementService.submitReimbursement(employeeId, body, file, actor);
}

export async function listMyReimbursements(employeeId, query) {
  return reimbursementService.listOwnReimbursements(employeeId, query);
}

export async function cancelMyReimbursement(employeeId, id, actor) {
  return reimbursementService.cancelReimbursement(employeeId, id, actor);
}

export async function getMyReceiptFile(employeeId, id) {
  return reimbursementService.getMyReceiptFile(employeeId, id);
}

export async function submitMyExitReentry(employeeId, body, actor) {
  return exitReentryService.submitExitReentry(employeeId, body, actor);
}

export async function listMyExitReentry(employeeId, query) {
  return exitReentryService.listOwnExitReentry(employeeId, query);
}

export async function cancelMyExitReentry(employeeId, id, actor) {
  return exitReentryService.cancelExitReentry(employeeId, id, actor);
}

export async function submitMyAnnualVacation(employeeId, body, actor) {
  return annualVacationService.submitOwnAnnualVacation(employeeId, body, actor);
}

export async function listMyAnnualVacation(employeeId, query) {
  return annualVacationService.listOwnAnnualVacation(employeeId, query);
}

export async function cancelMyAnnualVacation(employeeId, id, actor) {
  return annualVacationService.cancelAnnualVacation(employeeId, id, actor);
}

export async function submitMyCertificate(employeeId, body, actor) {
  return certificateService.submitCertificate(employeeId, body, actor);
}

export async function listMyCertificates(employeeId, query) {
  return certificateService.listOwnCertificates(employeeId, query);
}

export async function cancelMyCertificate(employeeId, id, actor) {
  return certificateService.cancelCertificate(employeeId, id, actor);
}

export async function resolveMyCertificatePdf(employeeId, id) {
  return certificateService.resolveCertificateForPdf(id, employeeId);
}

/** Read-only — a Worker never assigns/returns their own assets. */
export async function listMyAssets(employeeId) {
  return assetService.listEmployeeAssignments(employeeId);
}

export async function submitMyTimesheet(employeeId, body, actor) {
  return timesheetService.submitTimesheet(employeeId, body, actor);
}

export async function listMyTimesheets(employeeId, query) {
  return timesheetService.listOwnTimesheets(employeeId, query);
}


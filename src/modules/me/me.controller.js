/**
 * "Me" controller — HTTP translation only. Every handler resolves data
 * against req.user.employee, never a client-supplied id — that IS the
 * self-service guarantee, not an extra check layered on top of it.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import { sendCertificatePdf } from '../exitDocuments/certificate.controller.js';

import * as meService from './me.service.js';

const actor = (req) => ({ userId: req.user.id, employee: req.user.employee, ip: req.ip });

/** requireRoles('Worker') on the router guarantees a role, not the link — a
 *  Worker whose Employee was since deleted would otherwise 500 downstream. */
function myEmployeeId(req) {
  if (!req.user.employee) {
    throw new ApiError(404, 'No employee record is linked to this account.');
  }
  return req.user.employee;
}

/** GET /api/me — 200 → data: employee (own record) */
export async function getProfile(req, res) {
  const employee = await meService.getMyProfile(myEmployeeId(req));
  res.json(new ApiResponse('Your profile.', employee));
}

/** PATCH /api/me — self-edit contact-info fields only — 200 → data: employee (refreshed) */
export async function updateProfile(req, res) {
  const employee = await meService.updateMyProfile(myEmployeeId(req), req.body, actor(req));
  res.json(new ApiResponse('Your profile has been updated.', employee));
}

/** GET /api/me/documents — 200 → data: { items, total, page, pages } */
export async function listDocuments(req, res) {
  const data = await meService.listMyDocuments(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your documents.', data));
}

/** GET /api/me/documents/:id/file?version=N — streams own file bytes only. */
export async function documentFile(req, res) {
  const fileData = await meService.getMyDocumentFile(myEmployeeId(req), req.params.id, req.query.version);

  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));

  if (fileData.source === 'disk') {
    await pipeline(fs.createReadStream(fileData.absolutePath), res);
    return;
  }
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored file is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** POST /api/me/leave (multipart: optional file + fields) — 201 → data: leave request */
export async function submitLeave(req, res) {
  const request = await meService.submitMyLeave(myEmployeeId(req), req.body, req.file, actor(req));
  const message =
    request.status === 'AutoApproved' ? 'Leave request approved.' : 'Leave request submitted for review.';
  res.status(201).json(new ApiResponse(message, request));
}

/** GET /api/me/leave — 200 → data: { items, total, page, pages } */
export async function listLeave(req, res) {
  const data = await meService.listMyLeave(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your leave requests.', data));
}

/** GET /api/me/leave/:id/attachment — streams own attachment bytes only. */
export async function leaveAttachment(req, res) {
  const fileData = await meService.getMyLeaveAttachmentFile(myEmployeeId(req), req.params.id);
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored attachment is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** PATCH /api/me/leave/:id/cancel — 200 → data: leave request */
export async function cancelLeave(req, res) {
  const request = await meService.cancelMyLeave(myEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Leave request cancelled.', request));
}

/**
 * POST /api/me/attendance/punch — 200 → data: { action, record }. The
 * Sign in/Sign out buttons in My Attendance both call this — the server
 * decides whether it's the day's first punch (check-in) or a later one
 * (pushes checkOutTime forward), not the button label. 403 if outside the
 * geofence/office network.
 */
export async function punch(req, res) {
  const data = await meService.punchMyAttendance(myEmployeeId(req), req.body, actor(req));
  res.json(new ApiResponse(data.action === 'checked-in' ? 'Signed in.' : 'Recorded.', data));
}

/** GET /api/me/attendance — 200 → data: record[] (last 30 days by default) */
export async function listAttendance(req, res) {
  const data = await meService.listMyAttendance(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your attendance.', data));
}

/** POST /api/me/advances — 201 → data: advance (Pending) */
export async function submitAdvance(req, res) {
  const advance = await meService.submitMyAdvance(myEmployeeId(req), req.body, actor(req));
  res.status(201).json(new ApiResponse('Advance request submitted.', advance));
}

/** GET /api/me/advances — 200 → data: { items, total, page, pages } */
export async function listAdvances(req, res) {
  const data = await meService.listMyAdvances(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your advance requests.', data));
}

/** PATCH /api/me/advances/:id/cancel — 200 → data: advance */
export async function cancelAdvance(req, res) {
  const advance = await meService.cancelMyAdvance(myEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Advance request cancelled.', advance));
}

/** POST /api/me/reimbursements (multipart: file + fields) — 201 → data: claim */
export async function submitReimbursement(req, res) {
  const claim = await meService.submitMyReimbursement(myEmployeeId(req), req.body, req.file, actor(req));
  res.status(201).json(new ApiResponse('Reimbursement claim submitted.', claim));
}

/** GET /api/me/reimbursements — 200 → data: { items, total, page, pages } */
export async function listReimbursements(req, res) {
  const data = await meService.listMyReimbursements(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your reimbursement claims.', data));
}

/** PATCH /api/me/reimbursements/:id/cancel — 200 → data: null */
export async function cancelReimbursement(req, res) {
  await meService.cancelMyReimbursement(myEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Reimbursement claim cancelled.'));
}

/** GET /api/me/reimbursements/:id/receipt — streams own receipt bytes only. */
export async function reimbursementReceipt(req, res) {
  const fileData = await meService.getMyReceiptFile(myEmployeeId(req), req.params.id);
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored receipt is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** POST /api/me/exit-reentry — 201 → data: request (Pending) */
export async function submitExitReentry(req, res) {
  const request = await meService.submitMyExitReentry(myEmployeeId(req), req.body, actor(req));
  res.status(201).json(new ApiResponse('Exit re-entry request submitted.', request));
}

/** GET /api/me/exit-reentry — 200 → data: { items, total, page, pages } */
export async function listExitReentry(req, res) {
  const data = await meService.listMyExitReentry(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your exit re-entry requests.', data));
}

/** PATCH /api/me/exit-reentry/:id/cancel — 200 → data: request */
export async function cancelExitReentry(req, res) {
  const request = await meService.cancelMyExitReentry(myEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Request cancelled.', request));
}

/** POST /api/me/certificates — 201 → data: request (Pending) */
export async function submitCertificate(req, res) {
  const request = await meService.submitMyCertificate(myEmployeeId(req), req.body, actor(req));
  res.status(201).json(new ApiResponse('Certificate request submitted.', request));
}

/** GET /api/me/certificates — 200 → data: { items, total, page, pages } */
export async function listCertificates(req, res) {
  const data = await meService.listMyCertificates(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your certificate requests.', data));
}

/** PATCH /api/me/certificates/:id/cancel — 200 → data: null */
export async function cancelCertificate(req, res) {
  await meService.cancelMyCertificate(myEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Certificate request cancelled.'));
}

/** GET /api/me/certificates/:id/pdf — own approved/issued certificate only. */
export async function certificatePdf(req, res) {
  const resolved = await meService.resolveMyCertificatePdf(myEmployeeId(req), req.params.id);
  await sendCertificatePdf(resolved, res);
}

/** GET /api/me/assets — 200 → data: assignment[] (current + history) */
export async function listAssets(req, res) {
  const data = await meService.listMyAssets(myEmployeeId(req));
  res.json(new ApiResponse('Your assigned assets.', data));
}

/** POST /api/me/timesheets — 201 → data: timesheet (Submitted) */
export async function submitTimesheet(req, res) {
  const timesheet = await meService.submitMyTimesheet(myEmployeeId(req), req.body, actor(req));
  res.status(201).json(new ApiResponse('Timesheet submitted.', timesheet));
}

/** GET /api/me/timesheets — 200 → data: { items, total, page, pages } */
export async function listTimesheets(req, res) {
  const data = await meService.listMyTimesheets(myEmployeeId(req), req.query);
  res.json(new ApiResponse('Your timesheets.', data));
}


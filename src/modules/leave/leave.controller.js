/**
 * Leave controller — HTTP translation only. The attachment endpoint streams
 * bytes (not the JSON envelope), same pattern as reimbursement receipts.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import * as leaveService from './leave.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, employee: req.user.employee, ip: req.ip });

/** GET /api/leave-types — any authenticated user (a Worker needs this to submit). */
export async function listTypes(req, res) {
  const types = await leaveService.listLeaveTypes(req.query);
  res.json(new ApiResponse('Leave types.', types));
}

/** POST /api/leave-types   (Admin, Manager) */
export async function createType(req, res) {
  const type = await leaveService.createLeaveType(req.body, actor(req));
  res.status(201).json(new ApiResponse('Leave type created.', type));
}

/** PATCH /api/leave-types/:id   (Admin, Manager) */
export async function updateType(req, res) {
  const type = await leaveService.updateLeaveType(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Leave type updated.', type));
}

/** GET /api/leave — staff review queue, scoped to a Coordinator's own team. */
export async function list(req, res) {
  const data = await leaveService.listLeaveRequests(req.query, actor(req));
  res.json(new ApiResponse('Leave requests.', data));
}

/**
 * POST /api/leave — a STAFF member submitting their OWN leave request
 * (Coordinator/HR/Manager/Accounts; Admin has no Employee record, see
 * below). Workers use /api/me/leave instead. This is the staff-submission
 * gap the Approval Hierarchy work filled — previously staff had no
 * submission path of their own at all.
 */
export async function submit(req, res) {
  if (!req.user.employee) {
    throw new ApiError(
      400,
      'Your account has no linked employee record, so there is nothing to submit a personal request against.'
    );
  }
  const request = await leaveService.submitLeaveRequest(req.user.employee, req.body, req.file, actor(req));
  const message =
    request.status === 'AutoApproved' ? 'Leave request approved.' : 'Leave request submitted for review.';
  res.status(201).json(new ApiResponse(message, request));
}

/** GET /api/leave/:id/attachment — streams the attachment (staff review). */
export async function attachment(req, res) {
  const fileData = await leaveService.getAttachmentFile(req.params.id, actor(req));
  await streamAttachment(fileData, res);
}

export async function streamAttachment(fileData, res) {
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored attachment is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** PATCH /api/leave/:id/decide   (Admin, Manager, HR, Coordinator-own-team) */
export async function decide(req, res) {
  const request = await leaveService.decideLeaveRequest(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Leave request ${request.status.toLowerCase()}.`, request));
}

/** PATCH /api/leave/:id/acknowledge   (Admin, Manager, HR, Coordinator-own-team) */
export async function acknowledge(req, res) {
  const request = await leaveService.acknowledgeLeaveRequest(req.params.id, actor(req));
  res.json(new ApiResponse('Marked as seen.', request));
}

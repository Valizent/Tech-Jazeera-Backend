/**
 * Annual Vacation controller — HTTP translation only. A Worker/Staff login's
 * own submit/list/cancel live in the `me` module; the routes here are the
 * staff-facing half (see annualVacation.routes.js).
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import * as service from './annualVacation.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, employee: req.user.employee, ip: req.ip });

function ownEmployeeId(req) {
  if (!req.user.employee) {
    throw new ApiError(400, 'Your account has no linked employee record, so there is nothing to request against.');
  }
  return req.user.employee;
}

/** POST /api/annual-vacation — own request (no `employee`) or on someone's behalf. */
export async function submit(req, res) {
  const { employee, ...data } = req.body;
  const onBehalf = employee && employee !== req.user.employee;
  const request = onBehalf
    ? await service.submitAnnualVacationFor(employee, data, actor(req))
    : await service.submitOwnAnnualVacation(ownEmployeeId(req), data, actor(req));
  res.status(201).json(new ApiResponse('Annual vacation request submitted.', request));
}

/** GET /api/annual-vacation — the review queue. */
export async function list(req, res) {
  const data = await service.listAnnualVacation(req.query, actor(req));
  res.json(new ApiResponse('Annual vacation requests.', data));
}

/** GET /api/annual-vacation/mine — a staff login's own requests. */
export async function listMine(req, res) {
  const data = await service.listOwnAnnualVacation(ownEmployeeId(req), req.query);
  res.json(new ApiResponse('Your annual vacation requests.', data));
}

/** PATCH /api/annual-vacation/:id/cancel — own pending request. */
export async function cancel(req, res) {
  const request = await service.cancelAnnualVacation(ownEmployeeId(req), req.params.id, actor(req));
  res.json(new ApiResponse('Request cancelled.', request));
}

/** PATCH /api/annual-vacation/:id/decide — status, optional decisionNote, optional multipart `files` (when approving). */
export async function decide(req, res) {
  const request = await service.decideAnnualVacation(req.params.id, req.body, actor(req), req.files ?? []);
  res.json(new ApiResponse(`Request ${request.status.toLowerCase()}.`, request));
}

/** PATCH /api/annual-vacation/:id/days — HR changing the days at the HR step. */
export async function changeDays(req, res) {
  const request = await service.changeVacationDays(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('The days were changed.', request));
}

/** GET /api/annual-vacation/eligibility[?employee=] */
export async function eligibility(req, res) {
  const onBehalf = Boolean(req.query.employee) && req.query.employee !== req.user.employee;
  const data = await service.getEligibility(req.query.employee ?? ownEmployeeId(req), actor(req), { onBehalf });
  res.json(new ApiResponse('Annual vacation eligibility.', data));
}

/** Streams a stored file back to the (already authorised) caller. */
export async function streamStoredFile(res, fileData) {
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) throw new ApiError(410, 'The stored document is no longer available.');
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** GET /api/annual-vacation/:id/tickets/:fileId/file */
export async function ticketFile(req, res) {
  await streamStoredFile(res, await service.getTicketFile(req.params.id, req.params.fileId, { actor: actor(req) }));
}

/** GET /api/annual-vacation/:id/visa/file */
export async function visaFile(req, res) {
  await streamStoredFile(res, await service.getVisaFile(req.params.id, { actor: actor(req) }));
}

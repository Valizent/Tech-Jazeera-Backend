/**
 * Mobilisation controller — HTTP translation only. Inputs arrive validated
 * by Zod; business rules (including who may act) live in the service. The
 * document-file endpoint streams bytes (not the JSON envelope), same
 * pattern as reimbursement.controller.js's receipt handler.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import * as mobilisationService from './mobilisation.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/mobilisations/coordinators — 200 → data: [{_id, name}] */
export async function listCoordinatorCandidates(req, res) {
  const candidates = await mobilisationService.listCoordinatorCandidates();
  res.json(new ApiResponse('Coordinators.', candidates));
}

/** GET /api/mobilisations/suggestions?field=... — 200 → data: string[] */
export async function suggestions(req, res) {
  const values = await mobilisationService.getFieldSuggestions(req.query.field);
  res.json(new ApiResponse('Suggestions.', values));
}

/** GET /api/mobilisations — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await mobilisationService.listMobilisations(req.query, actor(req));
  res.json(new ApiResponse('Mobilisations.', data));
}

/** GET /api/mobilisations/:id — 200 → data: mobilisation · 403/404 */
export async function get(req, res) {
  const mobilisation = await mobilisationService.getMobilisation(req.params.id, actor(req));
  res.json(new ApiResponse('Mobilisation.', mobilisation));
}

/** POST /api/mobilisations — 201 → data: mobilisation (Draft) · 403 wrong role */
export async function create(req, res) {
  const mobilisation = await mobilisationService.createMobilisation(req.body, actor(req));
  res.status(201).json(new ApiResponse('Mobilisation created.', mobilisation));
}

/** PATCH /api/mobilisations/:id — 200 → data: mobilisation · 400 not Draft/Rejected · 403 not the primary coordinator */
export async function update(req, res) {
  const mobilisation = await mobilisationService.updateMobilisation(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Mobilisation updated.', mobilisation));
}

// ---------------------------------------------------------------------------
// M2 — joint coordinators + submit
// ---------------------------------------------------------------------------

/** POST /api/mobilisations/:id/coordinators — 200 → data: mobilisation */
export async function addCoordinator(req, res) {
  const mobilisation = await mobilisationService.addCoordinator(req.params.id, req.body.user, actor(req));
  res.status(201).json(new ApiResponse('Coordinator invited.', mobilisation));
}

/** DELETE /api/mobilisations/:id/coordinators/:userId — 200 → data: mobilisation */
export async function removeCoordinator(req, res) {
  const mobilisation = await mobilisationService.removeCoordinator(req.params.id, req.params.userId, actor(req));
  res.json(new ApiResponse('Coordinator removed.', mobilisation));
}

/** PATCH /api/mobilisations/:id/coordinators/:userId/confirm — 200 → data: mobilisation */
export async function confirmCoordinator(req, res) {
  const mobilisation = await mobilisationService.confirmCoordinator(req.params.id, req.params.userId, actor(req));
  res.json(new ApiResponse('Confirmed.', mobilisation));
}

/** POST /api/mobilisations/:id/submit — 200 → data: mobilisation (PendingReview) */
export async function submit(req, res) {
  const mobilisation = await mobilisationService.submitMobilisation(req.params.id, actor(req));
  res.json(new ApiResponse('Mobilisation submitted for review.', mobilisation));
}

/** PATCH /api/mobilisations/:id/complete — 200 → data: mobilisation (Completed) ·
 *  400 not Approved · 403 not the primary coordinator */
export async function complete(req, res) {
  const mobilisation = await mobilisationService.completeMobilisation(req.params.id, actor(req));
  res.json(new ApiResponse('Mobilisation marked complete.', mobilisation));
}

// ---------------------------------------------------------------------------
// M3 — Marketing Manager review
// ---------------------------------------------------------------------------

/** PATCH /api/mobilisations/:id/commercial-details — 200 → data: mobilisation */
export async function saveCommercialDetails(req, res) {
  const mobilisation = await mobilisationService.saveCommercialDetails(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Commercial details saved.', mobilisation));
}

/** PATCH /api/mobilisations/:id/decide — 200 → data: mobilisation */
export async function decide(req, res) {
  const mobilisation = await mobilisationService.decideMobilisation(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Mobilisation ${mobilisation.status.toLowerCase()}.`, mobilisation));
}

// ---------------------------------------------------------------------------
// TEMPORARY — pre-production cleanup only. Remove alongside the service
// function and route — see the note in mobilisation.service.js.
// ---------------------------------------------------------------------------

/** DELETE /api/mobilisations/:id — Admin only, hard delete. */
export async function remove(req, res) {
  await mobilisationService.deleteMobilisation(req.params.id, actor(req));
  res.json(new ApiResponse('Mobilisation deleted.'));
}

// ---------------------------------------------------------------------------
// M5 — documents
// ---------------------------------------------------------------------------

/** POST /api/mobilisations/:id/documents — multipart, field `files` + `category` */
export async function addDocuments(req, res) {
  if (!req.files?.length) throw new ApiError(400, 'Attach at least one file.');
  const mobilisation = await mobilisationService.addDocuments(req.params.id, req.files, req.body.category, actor(req));
  res.status(201).json(new ApiResponse('Document(s) uploaded.', mobilisation));
}

/** DELETE /api/mobilisations/:id/documents/:fileId */
export async function removeDocument(req, res) {
  const mobilisation = await mobilisationService.removeDocument(req.params.id, req.params.fileId, actor(req));
  res.json(new ApiResponse('Document removed.', mobilisation));
}

/** GET /api/mobilisations/:id/documents/:fileId/file — streams the file. */
export async function documentFile(req, res) {
  const fileData = await mobilisationService.getDocumentFile(req.params.id, req.params.fileId, actor(req));
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored document is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

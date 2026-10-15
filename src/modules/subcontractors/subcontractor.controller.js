/**
 * Subcontractor controller — HTTP translation only. Inputs arrive validated
 * by Zod; business rules live in the service.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as subcontractorService from './subcontractor.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/subcontractors — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await subcontractorService.listSubcontractors(req.query, actor(req));
  res.json(new ApiResponse('Subcontractors.', data));
}

/** GET /api/subcontractors/:id — 200 → data: subcontractor · 404 unknown */
export async function get(req, res) {
  const subcontractor = await subcontractorService.getSubcontractor(req.params.id, actor(req));
  res.json(new ApiResponse('Subcontractor.', subcontractor));
}

/** POST /api/subcontractors (Admin, Manager) — 201 → data: subcontractor */
export async function create(req, res) {
  const subcontractor = await subcontractorService.createSubcontractor(req.body, actor(req));
  res.status(201).json(new ApiResponse('Subcontractor created.', subcontractor));
}

/** PATCH /api/subcontractors/:id (Admin, Manager) — 200 → data: subcontractor */
export async function update(req, res) {
  const subcontractor = await subcontractorService.updateSubcontractor(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Subcontractor updated.', subcontractor));
}

/** PATCH /api/subcontractors/:id/decide: approve or reject a Pending subcontractor (the SubcontractorApproval hierarchy) */
export async function decide(req, res) {
  const subcontractor = await subcontractorService.decideSubcontractor(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Subcontractor ${subcontractor.approvalStatus.toLowerCase()}.`, subcontractor));
}

/** DELETE /api/subcontractors/:id (Admin, Manager) — 200 · 409 if referenced by a mobilisation */
export async function remove(req, res) {
  await subcontractorService.deleteSubcontractor(req.params.id, actor(req));
  res.json(new ApiResponse('Subcontractor deleted.'));
}

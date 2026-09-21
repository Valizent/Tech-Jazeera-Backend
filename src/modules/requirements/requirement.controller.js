/**
 * Requirement controllers — HTTP translation only. Inputs arrive validated by
 * Zod; every rule (including who may do what) lives in the services.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as requirementService from './requirement.service.js';
import * as stageService from './requirementStage.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/requirements/board — 200 → data: { stages, requirements, truncated } */
export async function board(req, res) {
  res.json(new ApiResponse('Requirements board.', await requirementService.getBoard(req.query, actor(req))));
}

/** GET /api/requirements/coordinators — 200 → data: [{ _id, name }] · 403 without team-read */
export async function coordinators(req, res) {
  res.json(new ApiResponse('Coordinators.', await requirementService.listCoordinators(actor(req))));
}

/** GET /api/requirements/:id — 200 → data: requirement + updates · 404 unknown or not yours */
export async function get(req, res) {
  res.json(new ApiResponse('Requirement.', await requirementService.getRequirement(req.params.id, actor(req))));
}

/** POST /api/requirements — 201 → data: requirement */
export async function create(req, res) {
  const requirement = await requirementService.createRequirement(req.body, actor(req));
  res.status(201).json(new ApiResponse('Requirement added.', requirement));
}

/** PATCH /api/requirements/:id — 200 → data: requirement */
export async function update(req, res) {
  res.json(new ApiResponse('Requirement updated.', await requirementService.updateRequirement(req.params.id, req.body, actor(req))));
}

/** PATCH /api/requirements/:id/stage — 200 → data: requirement */
export async function move(req, res) {
  res.json(new ApiResponse('Requirement moved.', await requirementService.moveStage(req.params.id, req.body.stage, actor(req))));
}

/** DELETE /api/requirements/:id — 200 */
export async function remove(req, res) {
  await requirementService.deleteRequirement(req.params.id, actor(req));
  res.json(new ApiResponse('Requirement deleted.'));
}

// ---- candidates -----------------------------------------------------------------------

/** POST /api/requirements/:id/candidates — 201 → data: candidate */
export async function addCandidate(req, res) {
  const candidate = await requirementService.addCandidate(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Candidate added.', candidate));
}

/** PATCH /api/requirements/:id/candidates/:candidateId — 200 → data: candidate */
export async function updateCandidate(req, res) {
  const candidate = await requirementService.updateCandidate(req.params.id, req.params.candidateId, req.body, actor(req));
  res.json(new ApiResponse('Candidate updated.', candidate));
}

/** DELETE /api/requirements/:id/candidates/:candidateId — 200 · 409 once they have a mobilisation */
export async function removeCandidate(req, res) {
  await requirementService.removeCandidate(req.params.id, req.params.candidateId, actor(req));
  res.json(new ApiResponse('Candidate removed.'));
}

// ---- stages ---------------------------------------------------------------------------

/** POST /api/requirements/stages — 201 → data: stage */
export async function createStage(req, res) {
  res.status(201).json(new ApiResponse('Stage added.', await stageService.createStage(req.body, actor(req))));
}

/** POST /api/requirements/stages/defaults — 201 → data: [stage] · 409 if stages already exist */
export async function createSuggestedStages(req, res) {
  res.status(201).json(new ApiResponse('Suggested stages added.', await stageService.createSuggestedStages(actor(req))));
}

/** PATCH /api/requirements/stages/:id — 200 → data: stage */
export async function updateStage(req, res) {
  res.json(new ApiResponse('Stage updated.', await stageService.updateStage(req.params.id, req.body, actor(req))));
}

/** PUT /api/requirements/stages/order — 200 → data: [stage] in the new order */
export async function reorderStages(req, res) {
  res.json(new ApiResponse('Stages reordered.', await stageService.reorderStages(req.body.ids, actor(req))));
}

/** DELETE /api/requirements/stages/:id — 200 · 409 while cards are still in it */
export async function removeStage(req, res) {
  await stageService.deleteStage(req.params.id, actor(req));
  res.json(new ApiResponse('Stage deleted.'));
}

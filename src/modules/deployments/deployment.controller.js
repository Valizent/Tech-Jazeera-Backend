/**
 * Deployment controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as deploymentService from './deployment.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/deployments — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await deploymentService.listDeployments(req.query);
  res.json(new ApiResponse('Deployments.', data));
}

/** GET /api/deployments/:id — 200 → data: deployment */
export async function get(req, res) {
  const deployment = await deploymentService.getDeployment(req.params.id, actor(req));
  res.json(new ApiResponse('Deployment.', deployment));
}

/** POST /api/deployments/:id/monthly-hours — 201 → data: deployment */
export async function addMonthlyHours(req, res) {
  const deployment = await deploymentService.addMonthlyHours(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Monthly hours recorded.', deployment));
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId — 200 → data: deployment */
export async function updateMonthlyHours(req, res) {
  const deployment = await deploymentService.updateMonthlyHours(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Monthly hours updated.', deployment));
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId/decide — 200 → data: deployment */
export async function decideMonthlyHours(req, res) {
  const deployment = await deploymentService.decideMonthlyHours(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Decision recorded.', deployment));
}

/** POST /api/deployments/:id/release — 200 → data: null (worker released to standby) */
export async function release(req, res) {
  await deploymentService.releaseDeployment(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Worker released.'));
}

// TEMPORARY — pre-production cleanup only. Remove alongside the service
// function and route — see the note in deployment.service.js.

/** DELETE /api/deployments/:id — Admin only, hard delete. */
export async function remove(req, res) {
  await deploymentService.deleteDeployment(req.params.id, actor(req));
  res.json(new ApiResponse('Deployment deleted.'));
}

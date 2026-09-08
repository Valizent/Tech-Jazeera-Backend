/**
 * Deployment controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as deploymentService from './deployment.service.js';

const actor = (req) => ({ userId: req.user.id, ip: req.ip });

/** GET /api/deployments — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await deploymentService.listDeployments(req.query);
  res.json(new ApiResponse('Deployments.', data));
}

/** GET /api/deployments/:id — 200 → data: deployment */
export async function get(req, res) {
  const deployment = await deploymentService.getDeployment(req.params.id);
  res.json(new ApiResponse('Deployment.', deployment));
}

/** POST /api/deployments — 201 → data: deployment · 409 double-assignment */
export async function assign(req, res) {
  const deployment = await deploymentService.assignWorker(req.body, actor(req));
  res.status(201).json(new ApiResponse('Worker deployed.', deployment));
}

/** POST /api/deployments/:id/transfer — 200 → data: new deployment */
export async function transfer(req, res) {
  const deployment = await deploymentService.transferDeployment(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Worker transferred.', deployment));
}

/** POST /api/deployments/:id/end — 200 → data: null (worker unassigned) */
export async function end(req, res) {
  await deploymentService.endDeployment(req.params.id, actor(req));
  res.json(new ApiResponse('Deployment ended.'));
}

// TEMPORARY — pre-production cleanup only. Remove alongside the service
// function and route — see the note in deployment.service.js.

/** DELETE /api/deployments/:id — Admin only, hard delete. */
export async function remove(req, res) {
  await deploymentService.deleteDeployment(req.params.id, actor(req));
  res.json(new ApiResponse('Deployment deleted.'));
}

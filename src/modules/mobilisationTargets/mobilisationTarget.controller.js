/**
 * MobilisationTarget controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as targetService from './mobilisationTarget.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/mobilisation-targets — all targets, all months (management). */
export async function listAll(req, res) {
  const targets = await targetService.listAllTargets(actor(req));
  res.json(new ApiResponse('Mobilisation targets.', targets));
}

/** GET /api/mobilisation-targets/my?month=YYYY-MM — own target + progress. */
export async function getMy(req, res) {
  const month = req.query.month ?? new Date().toISOString().slice(0, 7);
  const result = await targetService.getMyTarget(actor(req), month);
  res.json(new ApiResponse('Your mobilisation target.', result));
}

/** GET /api/mobilisation-targets/progress?month=YYYY-MM — all coordinators. */
export async function getProgress(req, res) {
  const month = req.query.month ?? new Date().toISOString().slice(0, 7);
  const result = await targetService.getAllProgress(actor(req), month);
  res.json(new ApiResponse('Mobilisation target progress.', result));
}

/** GET /api/mobilisation-targets/semi-annual/my?endMonth=YYYY-MM — own rolling 6-month progress. */
export async function getMySemiAnnual(req, res) {
  const endMonth = req.query.endMonth ?? new Date().toISOString().slice(0, 7);
  const result = await targetService.getMySemiAnnualProgress(actor(req), endMonth);
  res.json(new ApiResponse('Your semi-annual progress.', result));
}

/** GET /api/mobilisation-targets/semi-annual?endMonth=YYYY-MM — all coordinators. */
export async function getSemiAnnual(req, res) {
  const endMonth = req.query.endMonth ?? new Date().toISOString().slice(0, 7);
  const result = await targetService.getAllSemiAnnualProgress(actor(req), endMonth);
  res.json(new ApiResponse('Semi-annual progress.', result));
}

/** POST /api/mobilisation-targets — upsert a target. */
export async function set(req, res) {
  const target = await targetService.setTarget(req.body, actor(req));
  res.status(201).json(new ApiResponse('Target set.', target));
}

/** DELETE /api/mobilisation-targets/:id — remove a target. */
export async function remove(req, res) {
  await targetService.deleteTarget(req.params.id, actor(req));
  res.json(new ApiResponse('Target removed.'));
}

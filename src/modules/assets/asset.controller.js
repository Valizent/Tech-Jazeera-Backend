/**
 * Asset controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as assetService from './asset.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

export async function list(req, res) {
  const data = await assetService.listAssets(req.query, actor(req));
  res.json(new ApiResponse('Assets.', data));
}

export async function get(req, res) {
  const asset = await assetService.getAsset(req.params.id, actor(req));
  res.json(new ApiResponse('Asset.', asset));
}

export async function create(req, res) {
  const asset = await assetService.createAsset(req.body, actor(req));
  res.status(201).json(new ApiResponse('Asset created.', asset));
}

export async function update(req, res) {
  const asset = await assetService.updateAsset(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Asset updated.', asset));
}

export async function setStatus(req, res) {
  const asset = await assetService.setAssetStatus(req.params.id, req.body.status, actor(req));
  res.json(new ApiResponse('Asset status updated.', asset));
}

export async function remove(req, res) {
  await assetService.deleteAsset(req.params.id, actor(req));
  res.json(new ApiResponse('Asset deleted.'));
}

export async function assign(req, res) {
  const assignment = await assetService.assignAsset(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Asset assigned.', assignment));
}

export async function returnAsset(req, res) {
  await assetService.returnAsset(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Asset returned.'));
}

/** GET /api/assets/by-employee/:employeeId — current + past assignments, for the Employee profile panel. */
export async function listByEmployee(req, res) {
  const data = await assetService.listEmployeeAssignments(req.params.employeeId, actor(req));
  res.json(new ApiResponse('Assigned assets.', data));
}

import ApiResponse from '../../utils/ApiResponse.js';
import * as locationService from './location.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

export async function list(req, res) {
  const locations = await locationService.listLocations();
  res.json(new ApiResponse('Locations.', locations));
}

export async function create(req, res) {
  const location = await locationService.createLocation(req.body, actor(req));
  res.status(201).json(new ApiResponse('Location added.', location));
}

export async function remove(req, res) {
  await locationService.deleteLocation(req.params.id, actor(req));
  res.json(new ApiResponse('Location deleted.'));
}

/**
 * DailyUpdate controller — HTTP translation only. Inputs arrive validated by
 * Zod; every rule (including who may do what) lives in the service.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as dailyUpdateService from './dailyUpdate.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/daily-updates?kind=Log|Task — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await dailyUpdateService.listDailyUpdates(req.query, actor(req));
  res.json(new ApiResponse('Daily updates.', data));
}

/** GET /api/daily-updates/coordinators — 200 → data: [{ _id, name }] · 403 without team-read */
export async function coordinators(req, res) {
  const data = await dailyUpdateService.listCoordinators(actor(req));
  res.json(new ApiResponse('Coordinators.', data));
}

/** POST /api/daily-updates — 201 → data: entry */
export async function create(req, res) {
  const entry = await dailyUpdateService.createDailyUpdate(req.body, actor(req));
  res.status(201).json(new ApiResponse(entry.kind === 'Log' ? 'Log entry added.' : 'Task added.', entry));
}

/** PATCH /api/daily-updates/:id — 200 → data: entry */
export async function update(req, res) {
  const entry = await dailyUpdateService.updateDailyUpdate(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Entry updated.', entry));
}

/** PATCH /api/daily-updates/:id/status — 200 → data: entry */
export async function setStatus(req, res) {
  const entry = await dailyUpdateService.setTaskStatus(req.params.id, req.body.status, actor(req));
  res.json(new ApiResponse(entry.status === 'Done' ? 'Task marked done.' : 'Task reopened.', entry));
}

/** DELETE /api/daily-updates/:id — 200 */
export async function remove(req, res) {
  await dailyUpdateService.deleteDailyUpdate(req.params.id, actor(req));
  res.json(new ApiResponse('Entry deleted.'));
}

/**
 * Client controller — HTTP translation only. Inputs arrive validated by Zod;
 * business rules live in the service.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as clientService from './client.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/clients — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await clientService.listClients(req.query, actor(req));
  res.json(new ApiResponse('Clients.', data));
}

/** GET /api/clients/:id — 200 → data: client · 400 bad id · 404 unknown */
export async function get(req, res) {
  const client = await clientService.getClient(req.params.id, actor(req));
  res.json(new ApiResponse('Client.', client));
}

/**
 * POST /api/clients (Admin, Manager, Coordinator)
 * 201 → data: client — a Coordinator's submission starts approvalStatus: 'Pending'
 */
export async function create(req, res) {
  const client = await clientService.createClient(req.body, actor(req));
  res.status(201).json(new ApiResponse('Client created.', client));
}

/**
 * PATCH /api/clients/:id (Admin, Manager, Coordinator)
 * 200 → data: client · 403 a Coordinator editing someone else's or an already-approved client
 */
export async function update(req, res) {
  const client = await clientService.updateClient(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Client updated.', client));
}

/** DELETE /api/clients/:id (Admin, Manager) — 200 · 409 if workers assigned */
export async function remove(req, res) {
  await clientService.deleteClient(req.params.id, actor(req));
  res.json(new ApiResponse('Client deleted.'));
}

/**
 * PATCH /api/clients/:id/decide (Admin, Manager)
 * 200 → data: client · 400 not Pending · 403 a Manager who isn't this coordinator's manager
 */
export async function decide(req, res) {
  const client = await clientService.decideClient(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(req.body.status === 'Approved' ? 'Client approved.' : 'Client rejected.', client));
}

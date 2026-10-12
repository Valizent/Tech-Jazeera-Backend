/**
 * Subcontractor transfer controller - HTTP only; the rules live in
 * subcontractorTransfer.service.js.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as transferService from './subcontractorTransfer.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/subcontractor-transfers - 200 -> data: { canDecide, items } */
export async function list(req, res) {
  const data = await transferService.listTransfers(req.query, actor(req));
  res.json(new ApiResponse('Subcontractor transfers.', data));
}

/** PATCH /api/subcontractor-transfers/:id/decide - 200 -> data: the transfer */
export async function decide(req, res) {
  const transfer = await transferService.decideTransfer(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Transfer ${transfer.status.toLowerCase()}.`, transfer));
}

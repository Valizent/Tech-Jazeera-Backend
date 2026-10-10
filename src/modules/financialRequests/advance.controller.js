/**
 * Salary advance controller — HTTP translation only.
 */
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as advanceService from './advance.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, employee: req.user.employee, ip: req.ip });

/** GET /api/financial-requests/advances — staff review queue */
export async function list(req, res) {
  const data = await advanceService.listAdvances(req.query, actor(req));
  res.json(new ApiResponse('Salary advances.', data));
}

/**
 * POST /api/financial-requests/advances — a STAFF member submitting their
 * OWN advance request (Coordinator/HR/Manager/Accounts). Workers use
 * /api/me/advances instead. Admin has no Employee record.
 */
export async function submit(req, res) {
  if (!req.user.employee) {
    throw new ApiError(
      400,
      'Your account has no linked employee record, so there is nothing to submit a personal request against.'
    );
  }
  const advance = await advanceService.submitAdvance(req.user.employee, req.body, actor(req));
  res.status(201).json(new ApiResponse('Advance request submitted.', advance));
}

/** PATCH /api/financial-requests/advances/:id/decide */
export async function decide(req, res) {
  const advance = await advanceService.decideAdvance(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Advance ${advance.status.toLowerCase()}.`, advance));
}

/** POST /api/financial-requests/advances/:id/repayments */
export async function addRepayment(req, res) {
  const advance = await advanceService.addRepayment(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Repayment recorded.', advance));
}

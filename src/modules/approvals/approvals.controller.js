/**
 * Approvals controller — HTTP translation only.
 */
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import * as approvalsService from './approvals.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

export async function listRoles(req, res) {
  const roles = await approvalsService.listApprovalRoles();
  res.json(new ApiResponse('Approval roles.', roles));
}

export async function createRole(req, res) {
  const role = await approvalsService.createApprovalRole(req.body, actor(req));
  res.status(201).json(new ApiResponse('Approval role created.', role));
}

export async function updateRole(req, res) {
  const role = await approvalsService.updateApprovalRole(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Approval role updated.', role));
}

export async function listWorkflows(req, res) {
  const workflows = await approvalsService.listApprovalWorkflows();
  res.json(new ApiResponse('Approval workflows.', workflows));
}

export async function createWorkflow(req, res) {
  const workflow = await approvalsService.createApprovalWorkflow(req.body, actor(req));
  res.status(201).json(new ApiResponse('Approval workflow created.', workflow));
}

export async function updateWorkflow(req, res) {
  const workflow = await approvalsService.updateApprovalWorkflow(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Approval workflow updated.', workflow));
}

export async function getSpecialRoles(req, res) {
  const data = await approvalsService.getSpecialRoles();
  res.json(new ApiResponse('Special approval roles.', data));
}

export async function setSpecialRoles(req, res) {
  const data = await approvalsService.setSpecialRoles(req.body, actor(req));
  res.json(new ApiResponse('Special approval roles updated.', data));
}

export async function listEmployeeApprovals(req, res) {
  const data = await approvalsService.listEmployeeApprovals(req.query);
  res.json(new ApiResponse('Employees approval hierarchy.', data));
}

export async function setEmployeeOverride(req, res) {
  const data = await approvalsService.setEmployeeApprovalOverride(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Approval hierarchy updated.', data));
}

/**
 * GET /api/approvals/log — visible to Admin or any real ApprovalRole
 * member (a dynamic, DB-checked gate, not a static role list) — "so the
 * COO/MM/FM/GM can see all this data whenever they need," in the user's
 * own words.
 */
export async function log(req, res) {
  const isEligible = req.user.role === 'Admin' || (await approvalsService.isApprovalRoleMember(req.user.id));
  if (!isEligible) {
    throw new ApiError(403, 'You are not part of any approval role.');
  }
  const data = await approvalsService.listApprovalLog(req.query);
  res.json(new ApiResponse('Approval log.', data));
}

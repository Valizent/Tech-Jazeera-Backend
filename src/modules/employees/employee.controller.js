/**
 * Employee controller — HTTP translation only. All inputs arrive already
 * validated/sanitized by the Zod middleware; all business rules live in the
 * service.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as employeeService from './employee.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

/** Who performed the action, for the audit trail — `role` also drives P2-M2
 *  ownership scoping (Coordinator/Manager team views) in the service layer. */
const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** `actor`, plus whether this person may see/change pay figures
 *  (`employeeFinancial` Read) - resolved once per request; the service strips
 *  salary and the WPS breakdown from every response when it is false. */
const actorWithPay = async (req) => ({
  ...actor(req),
  canSeeFinancial: await canAccessSection('employeeFinancial', { userId: req.user.id, role: req.user.role }, 'read'),
});

/**
 * GET /api/employees?page&limit&search&status&alerts&thresholdDays&team&sortBy&sortOrder
 * 200 → data: { items, total, page, pages } — scoped to "my team" for a
 * Coordinator automatically, or for a Manager passing team=mine
 */
export async function list(req, res) {
  const data = await employeeService.listEmployees(req.query, await actorWithPay(req));
  res.json(new ApiResponse('Employees.', data));
}

/**
 * GET /api/employees/:id
 * 200 → data: employee · 400 bad id · 403 outside a Coordinator's team · 404 unknown
 */
export async function get(req, res) {
  const employee = await employeeService.getEmployee(req.params.id, await actorWithPay(req));
  res.json(new ApiResponse('Employee.', employee));
}

/**
 * POST /api/employees   ('employeeCreate' Write)
 * 201 → data: employee · 400 validation · 409 duplicate employeeId
 */
export async function create(req, res) {
  const employee = await employeeService.createEmployee(req.body, await actorWithPay(req));
  res.status(201).json(new ApiResponse('Employee created.', employee));
}

/**
 * PATCH /api/employees/:id   ('employeeEdit' Write)
 * 200 → data: employee · 400 / 404 / 409 as above
 */
export async function update(req, res) {
  const employee = await employeeService.updateEmployee(req.params.id, req.body, await actorWithPay(req));
  res.json(new ApiResponse('Employee updated.', employee));
}

/**
 * DELETE /api/employees/:id   ('employeeDelete' Write)
 * 200 → data: null · 404 unknown
 */
export async function remove(req, res) {
  await employeeService.deleteEmployee(req.params.id, actor(req));
  res.json(new ApiResponse('Employee deleted.'));
}

/**
 * POST /api/employees/:id/user   (Admin, HR)
 * Provisions a login for this employee, with any role except Admin.
 * 201 → data: { user, tempPassword } — tempPassword is shown ONCE, hand it over
 * 400 no email on file · 404 unknown employee · 409 already has a login / email taken
 */
export async function createLogin(req, res) {
  const data = await employeeService.createEmployeeLogin(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Login created.', data));
}

/**
 * POST /api/employees/:id/user/reset-password   (Admin, HR)
 * 200 → data: { tempPassword } — shown ONCE, hand it over · 404 no login yet
 */
export async function resetLoginPassword(req, res) {
  const data = await employeeService.resetEmployeeLoginPassword(req.params.id, actor(req));
  res.json(new ApiResponse('Password reset.', data));
}

/**
 * PATCH /api/employees/:id/user/role   (Admin, HR)
 * Corrects an existing login's role — revokes its sessions so the change
 * takes effect immediately instead of at next natural token expiry.
 * 200 → data: { id, name, email, role } · 404 no login yet
 */
export async function updateLoginRole(req, res) {
  const data = await employeeService.updateEmployeeLoginRole(req.params.id, req.body.role, actor(req));
  res.json(new ApiResponse('Login role updated.', data));
}

import AnnualVacationRequest from './annualVacation.model.js';
import Employee from '../employees/employee.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow, startApprovalWorkflow } from '../approvals/approvals.service.js';

export async function submitAnnualVacation(employeeId, { requestedDays, reason }, actor) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (actor.userId !== employee.user?.toString() && actor.role !== 'Admin') {
    throw new ApiError(403, 'You can only request vacation for yourself.');
  }

  let eligible = false;
  if (!employee.contractEndDate) {
    throw new ApiError(400, 'Your contract end date is not set. Please contact HR.');
  }

  const now = new Date();
  const contractEnd = new Date(employee.contractEndDate);

  if (now >= contractEnd) {
    eligible = true;
  } else if (employee.contractStartDate && employee.joiningDate) {
    // If the contract start date is significantly after the joining date,
    // they are on a renewed contract, meaning their first contract has already ended.
    const start = new Date(employee.contractStartDate);
    const join = new Date(employee.joiningDate);
    const diffDays = (start - join) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) {
      eligible = true;
    }
  }

  if (!eligible) {
    throw new ApiError(400, 'You can only apply for Annual Vacation after a contract ends.');
  }

  const workflow = await resolveApprovalWorkflow('AnnualVacation', employee);

  const request = await AnnualVacationRequest.create({
    employee: employee._id,
    requestedDays,
    reason,
    workflowSnapshot: workflow.steps,
    status: 'PendingReview',
  });

  await logAudit({
    user: actor.userId,
    action: 'annualVacation.submit',
    targetType: 'AnnualVacationRequest',
    targetId: request._id,
    meta: { requestedDays },
    ip: actor.ip,
  });

  await startApprovalWorkflow(
    'AnnualVacation',
    request._id,
    workflow,
    employee._id,
    `Annual Vacation Request (${requestedDays} days)`
  );

  return request.toObject();
}

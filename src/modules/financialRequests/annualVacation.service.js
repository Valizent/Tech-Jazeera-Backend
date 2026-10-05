import AnnualVacationRequest from './annualVacation.model.js';
import Employee from '../employees/employee.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';

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

  // Resolve the workflow for this request type (same pattern as leave.service.js)
  const workflow = await resolveApprovalWorkflow(employee, 'AnnualVacation');

  const createData = {
    employee: employee._id,
    requestedDays,
    reason,
    status: 'PendingReview',
  };

  // If a workflow exists, snapshot it onto the request (same pattern as
  // leaveRequest.model.js — the steps array is frozen at submission time)
  if (workflow) {
    createData.workflowSnapshot = workflow.steps;
  }

  const request = await AnnualVacationRequest.create(createData);

  await logAudit({
    user: actor.userId,
    action: 'annualVacation.submit',
    targetType: 'AnnualVacationRequest',
    targetId: request._id,
    meta: { requestedDays },
    ip: actor.ip,
  });

  return request.toObject();
}

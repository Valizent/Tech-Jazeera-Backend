/**
 * The portal home (2026-10-11): one call that answers "what do I need to know
 * today" for a Worker/Staff login — am I signed in, how much leave do I have,
 * what is the state of my requests, which of my documents are about to lapse,
 * and may I ask for annual vacation yet. Everything is resolved against the
 * caller's own employee record; nothing here accepts an employee id.
 */
import Employee from '../employees/employee.model.js';
import Attendance from '../attendance/attendance.model.js';
import Holiday from '../holidays/holiday.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import LeaveType from '../leave/leaveType.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import ReimbursementClaim from '../financialRequests/reimbursement.model.js';
import AnnualVacationRequest from '../annualVacation/annualVacation.model.js';
import ExitReentry from '../exitDocuments/exitReentry.model.js';
import CertificateRequest from '../exitDocuments/certificate.model.js';
import Timesheet from '../timesheets/timesheet.model.js';
import ApiError from '../../utils/ApiError.js';
import { toUtcDay } from '../attendance/attendance.service.js';
import { evaluateEligibility } from '../leave/leave.service.js';
import { vacationEligibility } from '../annualVacation/annualVacation.service.js';
import { IDENTITY_DOCS } from '../dashboard/dashboard.service.js';

const DAY = 86_400_000;
const DOCUMENT_WARNING_DAYS = 60;

/** Request statuses grouped the way an employee thinks of them. */
const PENDING = ['PendingReview', 'Pending', 'Submitted'];
const APPROVED = ['Approved', 'Issued', 'Paid', 'Closed'];
const REJECTED = ['Rejected'];

const REQUEST_MODELS = [LeaveRequest, SalaryAdvance, ReimbursementClaim, AnnualVacationRequest, ExitReentry, CertificateRequest, Timesheet];

async function leaveBalances(employee) {
  // Whole documents: evaluateEligibility reads the policy fields (days per year, tiers, cycles) off the type.
  const types = await LeaveType.find({ isActive: true, recurrence: { $in: ['Annual', 'Sick', 'ContractCycle'] } }).lean();
  const rows = await Promise.all(
    types.map(async (type) => {
      try {
        const result = await evaluateEligibility(employee, type, 1);
        return { leaveType: type.name, entitlementDays: result.entitlementDays, usedDays: result.usedDays, remainingDays: result.remainingDays };
      } catch {
        // No joining date on file: the form itself explains it; the card just leaves this type out.
        return null;
      }
    })
  );
  return rows.filter(Boolean);
}

export async function getMyOverview(employeeId) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'No employee record is linked to this account.');

  const today = toUtcDay(new Date());
  const [attendance, holiday, balances, ...statusRows] = await Promise.all([
    Attendance.findOne({ employee: employee._id, date: today }).select('status checkInTime checkOutTime').lean(),
    Holiday.findOne({ endDate: { $gte: today } }).select('name startDate endDate').sort({ startDate: 1 }).lean(),
    leaveBalances(employee),
    ...REQUEST_MODELS.map((Model) =>
      Model.aggregate([{ $match: { employee: employee._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
    ),
  ]);

  const requests = { pending: 0, approved: 0, rejected: 0 };
  for (const row of statusRows.flat()) {
    if (PENDING.includes(row._id)) requests.pending += row.count;
    else if (APPROVED.includes(row._id)) requests.approved += row.count;
    else if (REJECTED.includes(row._id)) requests.rejected += row.count;
  }

  const documentWarnings = IDENTITY_DOCS.map(([key, label]) => {
    const expiry = employee[key]?.expiry;
    if (!expiry) return null;
    const daysLeft = Math.ceil((new Date(expiry).getTime() - Date.now()) / DAY);
    return daysLeft <= DOCUMENT_WARNING_DAYS ? { type: key, label, expiry, daysLeft } : null;
  })
    .filter(Boolean)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const { eligible, reason } = await vacationEligibility(employee);
  return {
    today: {
      signedIn: Boolean(attendance?.checkInTime),
      signedOut: Boolean(attendance?.checkOutTime),
      checkInTime: attendance?.checkInTime ?? null,
      checkOutTime: attendance?.checkOutTime ?? null,
    },
    leaveBalances: balances,
    nextHoliday: holiday ? { name: holiday.name, startDate: holiday.startDate, endDate: holiday.endDate } : null,
    requests,
    documentWarnings,
    contract: {
      endDate: employee.contractEndDate ?? null,
      daysLeft: employee.contractEndDate ? Math.ceil((new Date(employee.contractEndDate).getTime() - Date.now()) / DAY) : null,
      vacationEligible: eligible,
      vacationReason: eligible ? null : reason,
    },
  };
}

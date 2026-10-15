/**
 * Timesheet — one employee's weekly hours summary, submitted for approval
 * (P2-M3b, the deferred half of P2-M3 — see docs/P2-M3-notes.md and
 * docs/PHASE3-PLAN.md's decision to default to a single-level approval
 * rather than the multi-level signed flow originally scoped).
 *
 * Deliberately NOT a second place to enter hours: Attendance (P2-M3's
 * geofenced self-punch, or a staff mark) is already the one source of daily
 * hours. A Timesheet is a snapshot/summary of a week's worth of that data,
 * submitted by the worker as "this is correct" and then approved or
 * rejected by a supervisor — see timesheet.service.js for the aggregation.
 *
 * One document per employee per week (the unique index): resubmitting after
 * a Rejection updates the SAME document (fresh totals, back to Submitted),
 * it does not create a new one.
 */
import mongoose from 'mongoose';
import { escalationLevelsField } from '../approvals/approvalFields.js';

export const TIMESHEET_STATUSES = ['Submitted', 'Approved', 'Rejected'];

const timesheetSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    // Both UTC midnight; periodStart is always a Saturday (KSA week start,
    // matching attendance.dates.js's weekRange() convention), periodEnd is
    // periodStart + 6 days.
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    // Snapshotted from Attendance at submission time — see computeTotals()
    // in the service. Never recomputed live once Approved/Rejected, so a
    // later attendance correction can't silently change a decided week.
    totalHours: { type: Number, required: true, default: 0 },
    daysPresent: { type: Number, default: 0 },
    daysAbsent: { type: Number, default: 0 },
    daysLeaveOrSick: { type: Number, default: 0 },
    daysOff: { type: Number, default: 0 },
    // P3-E: hours beyond the week's threshold (48 normally, or the
    // configured Ramadan weeklyHours cap if this week overlaps one) —
    // also snapshotted at submission time, same reasoning as totalHours:
    // if HR corrects the Ramadan calendar later, an already-decided week's
    // overtime doesn't silently change underneath it.
    overtimeHours: { type: Number, default: 0 },
    // How many of the 7 days actually had an Attendance record — lets a
    // reviewer see incomplete data at a glance (recordedDays < 7).
    recordedDays: { type: Number, default: 0 },

    status: { type: String, enum: TIMESHEET_STATUSES, default: 'Submitted' },
    notes: { type: String, trim: true, maxlength: 500 },

    // decidedBy/decidedAt/decisionNote mean "the FINAL decision only" once a
    // workflow governs this request (see approvals/approvalEngine.service.js)
    // — unchanged shape/meaning on the legacy (no-workflow) path.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    // Configurable Approval Hierarchy (post-Phase-3) — see
    // leaveRequest.model.js's identical fields for the full rationale.
    // Re-resolved on every (re)submission, including a resubmission after
    // Rejection — see timesheet.service.js's submitTimesheet().
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    workflowName: { type: String, default: null },
    steps: {
      type: [
        {
          label: String,
          roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
          assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          escalation: escalationLevelsField(),
          _id: false,
        },
      ],
      default: undefined,
    },
    currentStep: { type: Number, default: 0 },
    // When the request reached its current step: the clock the escalation levels count from.
    currentStepEnteredAt: { type: Date, default: null },
    approvalTrail: {
      type: [
        {
          step: Number,
          approvalRole: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole', default: null },
          viaAdminOverride: Boolean,
          approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          decision: { type: String, enum: ['Approved', 'Rejected'] },
          note: String,
          decidedAt: Date,
          _id: false,
        },
      ],
      default: undefined,
    },
  },
  { timestamps: true }
);

timesheetSchema.index({ employee: 1, periodStart: 1 }, { unique: true });
timesheetSchema.index({ status: 1, periodStart: -1 });

export default mongoose.model('Timesheet', timesheetSchema);

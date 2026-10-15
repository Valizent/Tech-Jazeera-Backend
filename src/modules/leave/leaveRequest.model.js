/**
 * LeaveRequest — one employee's request against one LeaveType.
 *
 * `eligibility` is a SNAPSHOT computed and frozen at submission time (never
 * trust the client, and never silently recompute history if the LeaveType's
 * policy changes later — the same discipline as quotation totals). It is what
 * lets the UI show *why* a request was auto-approved or sent for review.
 */
import mongoose from 'mongoose';
import { escalationLevelsField } from '../approvals/approvalFields.js';

export const LEAVE_REQUEST_STATUSES = [
  'AutoApproved',
  'PendingReview',
  'Approved',
  'Rejected',
  'Cancelled',
];

/** An optional supporting file (e.g. a medical note) — same shape as
 *  ReimbursementClaim's receipt (reimbursement.model.js), but never
 *  required: not every leave type needs proof. _id disabled — a value
 *  object, not an entity. */
const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true }, // Cloudinary public_id
    resourceType: { type: String, required: true }, // 'raw', from the upload middleware
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const leaveRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    // Snapshot — a request stays readable even if the type is later renamed
    // or deactivated.
    leaveTypeName: { type: String, required: true },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true, min: 1 }, // inclusive calendar days
    reason: { type: String, trim: true, maxlength: 500 },
    attachment: { type: attachmentSchema, default: undefined },

    status: { type: String, enum: LEAVE_REQUEST_STATUSES, default: 'PendingReview' },

    eligibility: {
      continuousServiceMonths: { type: Number, default: 0 },
      entitlementDays: { type: Number, default: 0 },
      usedDays: { type: Number, default: 0 },
      remainingDays: { type: Number, default: 0 },
      ruleApplied: { type: String, default: '' }, // human-readable, shown in the UI
      // Only set for 'Sick' requests: how these specific days split
      // across the LeaveType's pay tiers, e.g. [{days:5,payPercent:100},
      // {days:5,payPercent:75}]. Frozen here at submission time, same
      // reasoning as everything else in `eligibility` — payroll
      // (payroll.service.js's sickLeaveDeductionForMonth) reads THIS
      // snapshot, never re-derives it from the current LeaveType, so an
      // already-decided request's pay never silently changes if the
      // company edits its sick-pay tiers later.
      payBreakdown: {
        type: [{ days: Number, payPercent: Number, _id: false }],
        default: undefined,
      },
    },

    // P2-M2: auto-approval is a right, not a manager's call (per policy), but
    // the coordinator/manager still gets it as a NOTICE they can see and flag
    // a real-world conflict against. This is that "seen it" flag — the same
    // read-signal idiom the app already uses (expiry alerts), not a new
    // notification system.
    acknowledgedByManager: { type: Boolean, default: false },

    // decidedBy/decidedAt/decisionNote now mean "the FINAL decision only" —
    // populated once, whenever the request reaches a terminal state (1 step
    // later on the legacy path, or N steps later on a workflow). Every
    // existing reader of "who decided this" keeps working unchanged;
    // approvalTrail below is the new, granular, append-only record.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },

    // Configurable Approval Hierarchy (post-Phase-3) — null on every field
    // below means "no workflow governs this request," i.e. the original
    // single-level flow above (decidedBy/At/Note set directly by whichever
    // legacy-allowed role decides it). See approvals/approvalEngine.service.js.
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    // Frozen snapshot — a later rename of the live workflow never rewrites
    // an in-flight or already-decided request's displayed name.
    workflowName: { type: String, default: null },
    // Frozen COPY of workflow.steps at submission time — a later edit to the
    // live workflow (reordering/adding/removing steps) never retroactively
    // changes an in-flight request's own chain.
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
    // Append-only — one entry per step decided, in order. Never mutated or
    // reordered after being pushed (see approvalEngine.service.js).
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

// An employee's own history, newest first (My Leave, and overlap checks).
leaveRequestSchema.index({ employee: 1, createdAt: -1 });
// The staff review queue, filtered by status.
leaveRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('LeaveRequest', leaveRequestSchema);

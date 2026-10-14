/**
 * ApprovalWorkflow — an admin-defined, ordered multi-step approval chain
 * (e.g. HR -> BDM -> {MM, COO, FM}), built entirely from ApprovalRoles.
 *
 * One step = a POOL of roles: "any one member of any one of these roles" may
 * decide this step. A strict single-approver step ("HR") is just a pool of
 * one role; a fan-in step ("any of MM/COO/FM") is a pool of several — no
 * special-casing needed for either shape. See approvalEngine.service.js for
 * how a step is actually decided.
 *
 * `appliesTo` says which request types this workflow is the COMPANY-WIDE
 * DEFAULT for. An Employee can still override with its own `approvalWorkflow`
 * field (see employees/employee.model.js) — appliesTo only governs the
 * fallback used when no override is set (approvals.service.js's
 * resolveApprovalWorkflow). The partial-unique index below prevents two
 * active workflows from both claiming the same request type as their
 * default, which would make "which one runs" ambiguous. It's a multikey
 * index (appliesTo is an array): MongoDB enforces uniqueness per ARRAY
 * ELEMENT across documents, so 'Leave' appearing in two different active
 * workflows' appliesTo collides even though the arrays themselves differ.
 */
import mongoose from 'mongoose';
import { EMPLOYEE_DEPARTMENTS } from '../employees/departments.js';

export const STEP_DUTIES = ['HrReview', 'TravelDocuments'];

export const APPROVAL_REQUEST_TYPES = [
  'Leave',
  'SalaryAdvance',
  'Reimbursement',
  'Timesheet',
  'Mobilisation',
  'ExitReentry',
  'Certificate',
  'AnnualVacation',
];

const workflowStepSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 60 },
    roles: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'Each step needs at least one role.',
      },
    },
    // A step's special duty (2026-10-14, annual vacation only): 'HrReview' lets whoever holds the step
    // change the number of days; 'TravelDocuments' makes it the step that attaches the air tickets and
    // uploads the re-entry visa, and it moves on by itself once both are done.
    duty: { type: String, enum: STEP_DUTIES, default: null },
  },
  { _id: false }
);

/** "For employees in this department, use that workflow instead" - lives on the
 *  company-wide default for a request type (the workflow whose `appliesTo` lists
 *  it). The target workflow is an ordinary workflow with an empty `appliesTo`, so
 *  the one-default-per-type index below is untouched. */
const departmentRouteSchema = new mongoose.Schema(
  {
    department: { type: String, enum: EMPLOYEE_DEPARTMENTS, required: true },
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', required: true },
  },
  { _id: false }
);

const approvalWorkflowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    steps: {
      type: [workflowStepSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'A workflow needs at least one step.',
      },
    },
    appliesTo: { type: [{ type: String, enum: APPROVAL_REQUEST_TYPES }], default: [] },
    // Told (not asked) when a request is submitted and again when it is approved, e.g. the Marketing
    // Manager for an annual vacation. Roles only: membership is read at the moment they are told.
    notifyRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
    departmentRoutes: { type: [departmentRouteSchema], default: [] },
    // Deactivate instead of delete — in-flight and decided requests freeze a
    // copy of `steps` at submission time (see e.g. leaveRequest.model.js),
    // but an Employee's `approvalWorkflow` override and this doc's own
    // appliesTo default both reference it live by id.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Only a workflow that is actually a DEFAULT for some request type competes for
// the "one active default per type" rule. (2026-10-13: the old index also
// counted an empty `appliesTo`, so a second active non-default workflow - a
// per-employee override, or a department route - was refused with a misleading
// "already has an active default" error: MongoDB indexes every empty array as
// the same key.) Renamed, so the old index can be retired by
// `retireLegacyWorkflowIndex` without an options conflict.
approvalWorkflowSchema.index(
  { appliesTo: 1 },
  { name: 'appliesTo_default_unique', unique: true, partialFilterExpression: { isActive: true, 'appliesTo.0': { $exists: true } } }
);

const ApprovalWorkflow = mongoose.model('ApprovalWorkflow', approvalWorkflowSchema);

/** Drops the pre-2026-10-13 `appliesTo_1` unique index if a database still has
 *  it. Idempotent and safe to run on every boot (called from server.js). */
export async function retireLegacyWorkflowIndex() {
  try {
    await ApprovalWorkflow.collection.dropIndex('appliesTo_1');
    return true;
  } catch (err) {
    // 26 = namespace not found (no collection yet), 27 = index not found.
    if (err.code === 26 || err.code === 27 || /index not found|ns not found/i.test(err.message)) return false;
    throw err;
  }
}

export default ApprovalWorkflow;

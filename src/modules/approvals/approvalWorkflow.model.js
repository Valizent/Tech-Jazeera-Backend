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
    // Deactivate instead of delete — in-flight and decided requests freeze a
    // copy of `steps` at submission time (see e.g. leaveRequest.model.js),
    // but an Employee's `approvalWorkflow` override and this doc's own
    // appliesTo default both reference it live by id.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

approvalWorkflowSchema.index(
  { appliesTo: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

export default mongoose.model('ApprovalWorkflow', approvalWorkflowSchema);

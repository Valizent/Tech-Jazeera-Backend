/**
 * Mobilisation — the commercial+staffing record of placing a worker with a
 * client (optionally routed through a subcontractor), including billing
 * rates/commissions and the profit on the deal. Once this reaches
 * 'Approved', a Deployment (worker actually at work, monthly client hours/OT,
 * Release) is created automatically from it — see
 * deployment.service.js's createDeploymentFromMobilisation, called from this
 * module's approveMobilisation. See docs/MOBILISATION-notes.md.
 *
 * Section 1 is filled by whoever creates it (a Coordinator, or — from M4 —
 * a BDM/Marketing Manager self-mobilising); Section 2 (client/sub quotation
 * & PO, overtime RATES) is filled by whoever holds the CURRENT approval step
 * (Office Secretary, then Marketing Manager, once an Admin configures that
 * multi-step workflow) via the commercial-details endpoint — see
 * mobilisation.service.js's saveCommercialDetails, which was already
 * generic over "whoever's turn it is" before Office Secretary existed.
 * Section 2 no longer includes the client's actual timesheet hours
 * (2026-09-12 follow-up) — a real worker isn't even placed yet at this
 * stage, so there's no timesheet to enter; that now lives entirely on the
 * Deployment this mobilisation produces once Approved, entered month by
 * month as the client's real timesheets actually arrive.
 *
 * `worker` is a reference, populated ONLY when `workerType === 'Employee'` —
 * a Supplier-Employee or Freelancer worker never gets an Employee HR record
 * at all, so their identity fields below are directly Coordinator-typed
 * instead of snapshotted. `client`/`subcontractor` stay references either
 * way; every identity field (`workerName`, `clientName`, `subcontractorName`,
 * ...) is a SNAPSHOT captured at creation/edit, same durable-history
 * convention as Deployment.clientName — a later Iqama renewal or client
 * rename must not silently rewrite an already-submitted mobilisation.
 *
 * `profitPerHour`/`profitPerMonth`/`otProfitPerHour` are SERVER-COMPUTED
 * (mobilisation.service.js's computeProfitFields), never accepted from
 * client input and recomputed on every save AND every read — this app's
 * "never trust a stored financial figure, recompute server-side" rule, same
 * posture as Payroll/Invoice totals. Formula (given directly by the
 * business owner, not inferred):
 *   profitPerHour = SupplierEmployee: (clientRate - clientCommission) - (subcontractorRate + subcontractorCommission)
 *                   Employee/Freelancer: clientRate - clientCommission
 *   profitPerMonth = (profitPerHour * requiredTimesheetHours) - fta - allowance
 * This is a pre-deployment ESTIMATE off the contracted/target hours only —
 * it deliberately does NOT factor in overtime or the client's real worked
 * hours. Once this mobilisation is Approved, the resulting Deployment's own
 * monthly-hours ledger (deployment.model.js/deployment.service.js's
 * computeMonthlyProfit) is the real, actual-hours-based profit figure for
 * every month actually worked — see the 2026-09-12 follow-up below for why
 * `clientTimesheetHours`/`otHours`/`otProfitTotal` were removed from here.
 *
 * `workflow`/`workflowName`/`steps`/`currentStep`/`approvalTrail` are the
 * Configurable Approval Hierarchy fields, identical shape to
 * reimbursement.model.js. `currentStepEnteredAt` is Mobilisation-local (the
 * shared engine doesn't know about it) — set by decideMobilisation/
 * submitMobilisation whenever `currentStep` changes, powering the
 * stale-mobilisation warning job.
 */
import mongoose from 'mongoose';


// 'Completed' is the terminal "placement has ended" state — set automatically
// when the Deployment this mobilisation produced is Released (see
// deployment.service.js's releaseDeployment), never by a direct action on
// the Mobilisation itself. Only reachable from 'Approved'.
export const MOBILISATION_STATUSES = ['Draft', 'PendingReview', 'Approved', 'Rejected', 'Completed'];
// Who a final-step rejection sends the mobilisation back to — see
// mobilisation.service.js's rejectMobilisation/submitMobilisation for what
// each one actually does differently.
export const REJECTION_TARGETS = ['Coordinator', 'OfficeSecretary', 'Both'];
export const MOBILISATION_DOCUMENT_CATEGORIES = ['Contract', 'IDCopy', 'Other'];

// 'Employee' is an existing Employee record (unchanged original behavior).
// 'SupplierEmployee'/'Freelancer' never get an Employee record — their
// identity fields are typed directly onto the mobilisation. Subcontractor
// rate/commission fields only ever apply to 'SupplierEmployee'.
export const WORKER_TYPES = ['Employee', 'SupplierEmployee', 'Freelancer'];

/** One uploaded file (M5). _id kept (default) — deleted individually by id,
 *  unlike Document.versions' append-only history. */
const mobilisationDocumentSchema = new mongoose.Schema({
  fileName: { type: String, required: true }, // Cloudinary public_id
  resourceType: { type: String, required: true }, // 'raw', from the upload middleware
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  category: { type: String, enum: MOBILISATION_DOCUMENT_CATEGORIES, required: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
});

/** One coordinator on the record. The creator is the primary, auto-confirmed;
 *  anyone else added (M2) must explicitly confirm before the record can be
 *  submitted — see mobilisation.service.js's submitMobilisation. */
const coordinatorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isPrimary: { type: Boolean, default: false },
    confirmed: { type: Boolean, default: false },
    confirmedAt: { type: Date, default: null },
  },
  { _id: false }
);

const mobilisationSchema = new mongoose.Schema(
  {
    // --- Section 1: worker & job ---
    serialNumber: { type: String, required: true, unique: true }, // 'MOB-0001', via counter.model.js's nextSequence
    workerType: { type: String, enum: WORKER_TYPES, required: true, default: 'Employee' },
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: function () {
        return this.workerType === 'Employee';
      },
      default: null,
    },
    workerName: { type: String, required: true }, // snapshot of Employee.fullName, or direct entry
    iqamaNumber: { type: String, trim: true },
    nationality: { type: String, trim: true },
    phone: { type: String, trim: true },
    jobTitle: { type: String, required: true, trim: true, maxlength: 150 },

    // --- Section 1: client & billing ---
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    clientName: { type: String, required: true }, // snapshot of Client.companyName
    // Free-typed, not validated against Client.sites — same "suggestion aid,
    // not a strict picklist" convention as workerName (see
    // getFieldSuggestions). Optional: many mobilisations won't name a
    // specific site, and this shouldn't block an otherwise-complete Draft.
    // Snapshotted onto the auto-created Deployment once Approved — see
    // deployment.service.js's createDeploymentFromMobilisation.
    site: { type: String, trim: true, default: null },
    clientRate: { type: Number, default: 0, min: 0 }, // per hour
    clientCommission: { type: Number, default: 0, min: 0 }, // per hour
    fta: { type: Number, default: 0, min: 0 }, // per month — Food/Travel/Accommodation, company-paid
    allowance: { type: Number, default: 0, min: 0 }, // per month, company-paid
    requiredTimesheetHours: { type: Number, default: null, min: 0 }, // contracted/target hours, set by the Coordinator

    // --- Section 1: subcontractor — only when workerType === 'SupplierEmployee' ---
    hasSubcontractor: { type: Boolean, default: false }, // server-derived from workerType — never client-writable
    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', default: null },
    subcontractorName: { type: String, default: null }, // snapshot of Subcontractor.name
    subcontractorRate: { type: Number, default: 0, min: 0 }, // per hour
    subcontractorCommission: { type: Number, default: 0, min: 0 }, // per hour

    // --- Section 1: computed economics (server-only — see computeProfitFields) ---
    profitPerHour: { type: Number, default: null },
    profitPerMonth: { type: Number, default: null }, // null until requiredTimesheetHours is set

    mobilisationDate: { type: Date, required: true },
    checkoutDate: { type: Date, default: null },

    // --- Section 2: overtime RATES — filled by the current-step reviewer,
    // mirrors the regular-hours rate split. No `otHours`/`otProfitTotal`
    // here (removed 2026-09-12) — actual OT hours are now tracked entirely
    // on the Deployment's monthly-hours ledger, which already reads these
    // rate fields straight off this document (see deployment.service.js's
    // computeMonthlyProfit). `otProfitPerHour` stays: a pure rate-derived
    // margin preview that needs no hours figure at all.
    otClientRate: { type: Number, default: null, min: 0 },
    otClientCommission: { type: Number, default: null, min: 0 },
    otSubcontractorRate: { type: Number, default: null, min: 0 }, // SupplierEmployee only
    otSubcontractorCommission: { type: Number, default: null, min: 0 }, // SupplierEmployee only
    otProfitPerHour: { type: Number, default: null }, // computed

    // --- stale-mobilisation warning support ---
    currentStepEnteredAt: { type: Date, default: null },

    // --- Section 1: coordinators / documents / remark ---
    coordinators: {
      type: [coordinatorSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'A mobilisation needs at least one coordinator.',
      },
    },
    documents: { type: [mobilisationDocumentSchema], default: [] },
    remark: { type: String, trim: true, maxlength: 1000 },

    // --- Section 2: current-step reviewer only (Office Secretary, then Marketing Manager) ---
    clientQuotation: { type: String, trim: true, default: null },
    clientQuotationDate: { type: Date, default: null },
    clientPO: { type: String, trim: true, default: null },
    clientPODate: { type: Date, default: null },
    subQuotation: { type: String, trim: true, default: null },
    subQuotationDate: { type: Date, default: null },
    subPO: { type: String, trim: true, default: null },
    subPODate: { type: Date, default: null },

    // --- Workflow (Configurable Approval Hierarchy, M2/M3) ---
    status: { type: String, enum: MOBILISATION_STATUSES, default: 'Draft' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },
    // Set only by a final-step rejection targeting 'Coordinator' or 'Both'
    // (status becomes 'Rejected' either way) — read by submitMobilisation to
    // decide whether resubmitting restarts the whole workflow or skips
    // straight back to the step it was rejected from. A rejection targeting
    // 'OfficeSecretary' never sets this: it never leaves 'PendingReview' in
    // the first place (see mobilisation.service.js's rejectMobilisation).
    // Always cleared back to null on a successful resubmit.
    rejectionTarget: { type: String, enum: REJECTION_TARGETS, default: null },
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    workflowName: { type: String, default: null },
    steps: {
      type: [
        {
          label: String,
          roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }],
          _id: false,
        },
      ],
      default: undefined,
    },
    currentStep: { type: Number, default: 0 },
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

mobilisationSchema.index({ worker: 1, createdAt: -1 });
mobilisationSchema.index({ client: 1 });
mobilisationSchema.index({ status: 1, createdAt: -1 });
mobilisationSchema.index({ 'coordinators.user': 1 });

export default mongoose.model('Mobilisation', mobilisationSchema);

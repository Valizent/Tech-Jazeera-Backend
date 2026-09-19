/**
 * Deployment — the record of a worker actually WORKING at a client, born
 * automatically the moment its source Mobilisation reaches 'Approved' (see
 * mobilisation.service.js's approveMobilisation → this module's
 * createDeploymentFromMobilisation) and ended by a real "Release" action
 * (releaseDeployment) — never created or edited by hand. One Mobilisation
 * produces at most one Deployment, ever; mobilising the same worker again
 * later is a brand new Mobilisation, which produces its own new Deployment.
 *
 * Schema choices, justified:
 *  - `mobilisation` is the source of truth for identity/commercial context
 *    (worker/client/rates) — a REFERENCE, since Mobilisation has its own
 *    independent lifecycle and already carries every rate/commission field
 *    this module needs. `workerType`/`workerName`/`client`/`clientName`/
 *    `subcontractor`/`subcontractorName`/`requiredTimesheetHours` are
 *    SNAPSHOTS taken at Deployment-creation time — durable history, same
 *    convention as Mobilisation's own snapshot fields, and lets this
 *    register render without populating Mobilisation on every read.
 *  - `worker` is a real Employee reference, but only when `workerType ===
 *    'Employee'` — a SupplierEmployee/Freelancer mobilisation has no
 *    Employee record at all (see mobilisation.model.js), so this stays null
 *    for those; Employee.currentClient/currentSite are only ever touched
 *    for a real Employee.
 *  - `monthlyHours` is EMBEDDED — it lives and dies with this one
 *    deployment, is never queried on its own, and is exactly the kind of
 *    small append-mostly history this app always embeds (line items, doc
 *    versions, emergency contact). One entry per calendar month. `otHours`
 *    IS server-computed (SupplierEmployee: max(0, actualHours -
 *    supplierHours); Employee/Freelancer: max(0, actualHours -
 *    contractHours) — see deployment.service.js's computeOtHours), and so is
 *    `otAmount` (= otHours × the source Mobilisation's `otClientRate`,
 *    added 2026-09-13 per the user's own ask — never client-submitted,
 *    same "recompute financials server-side, always" rule as Mobilisation's
 *    own commission math) — see deployment.service.js. `otAmount` is
 *    commercial data, same sensitivity class as `profit`: stripped from the
 *    response entirely for anyone without `deploymentsHoursDecide` access,
 *    so whoever just enters the daily hours (typically Office Secretary)
 *    never sees what it bills to the client.
 */
import mongoose from 'mongoose';

export const MONTHLY_HOURS_STATUSES = ['Pending', 'Approved', 'Rejected'];
export const DEPLOYMENT_STATUSES = ['Active', 'Ended'];
/**
 * Why an Active deployment was demobilised (added 2026-09-12, replacing the
 * single generic 'Released'). Each reason resolves to exactly one outcome
 * for the worker — Standby (still with the company, eligible for a new
 * Mobilisation) or Exit (no longer with the company at all) — via
 * DEMOBILISATION_OUTCOME below, EXCEPT 'Other', whose outcome is an explicit
 * caller-supplied flag (see deployment.service.js's demobiliseDeployment) —
 * a genuinely novel reason shouldn't be forced into either bucket by a
 * fixed lookup.
 *  - 'ClientAssignmentEnded': the direct rename of the old 'Released' — the
 *    client/project no longer needs this worker; they remain employed.
 *  - 'TerminatedByCompany' / 'Resigned' / 'TransferredToAnotherCompany'
 *    (sponsorship/"Tanazel" transfer to a new employer): Employee-only —
 *    SupplierEmployee/Freelancer have no employment relationship with this
 *    company to end (rejected server-side if attempted, see
 *    deployment.validation.js).
 *  - 'Other': any worker type; the note is mandatory (see the model field).
 */
export const DEMOBILISATION_REASONS = [
  'ClientAssignmentEnded',
  'TerminatedByCompany',
  'Resigned',
  'TransferredToAnotherCompany',
  'Other',
];
/** Reasons restricted to a real Employee — see the enum's own doc comment. */
export const EMPLOYEE_ONLY_DEMOBILISATION_REASONS = ['TerminatedByCompany', 'Resigned', 'TransferredToAnotherCompany'];
/** Reason → outcome, for every reason except 'Other' (see the enum's own doc
 *  comment). Consumed by deployment.service.js's demobiliseDeployment. */
export const DEMOBILISATION_OUTCOME = {
  ClientAssignmentEnded: 'Standby',
  TerminatedByCompany: 'Exit',
  Resigned: 'Exit',
  TransferredToAnotherCompany: 'Exit',
};
export const WORKER_TYPES = ['Employee', 'SupplierEmployee', 'Freelancer'];
/** One calendar day of a monthly-hours entry is either a real worked day
 *  (`hours` meaningful) or a non-working day the enterer marks explicitly —
 *  added 2026-09-12 per the user's own ask ("when day is off, then its F,
 *  when on sick leave S, when absent A"), deliberately a manual per-day
 *  mark typed in by whoever fills the sheet, NOT auto-pulled from the
 *  Attendance module (a client timesheet can legitimately differ from
 *  internal attendance, and SupplierEmployee/Freelancer workers have no
 *  Attendance record to pull from at all). 'Off'/'Sick'/'Absent' BLOCK
 *  `hours` entirely for that day (the client's own UI enforces this one
 *  input can only ever be a number OR one of these three states, never
 *  both) — see deployments.schema.js's parseDailyEntry. */
export const DAILY_ENTRY_STATUSES = ['Worked', 'Off', 'Sick', 'Absent'];

/** One calendar month's actual client-timesheet hours, entered once the
 *  month has fully ended. `contractHours` is snapshotted at entry time from
 *  the deployment's own `requiredTimesheetHours` — a stable point-in-time
 *  reference even if that figure is ever revisited later.
 *
 *  Single-level Approve/Reject (Marketing Manager, via the new
 *  'deploymentsHoursDecide' Section Access key — see
 *  deployment.service.js's decideMonthlyHours) — not the full Configurable
 *  Approval Hierarchy engine, since this is one embedded array entry on a
 *  Deployment, not a top-level document the engine's workflow/steps/
 *  currentStep shape assumes. Same judgment call as Financial Requests'
 *  own single-level decide. A Pending or Rejected entry stays editable by
 *  whoever entered it; editing a Rejected entry resets it back to Pending
 *  (an implicit resubmit — see updateMonthlyHours). Once Approved, it's
 *  locked — matches the "approved financial data doesn't drift" posture
 *  Invoice/Quotation line items already follow. */
const dailyEntrySchema = new mongoose.Schema(
  { status: { type: String, enum: DAILY_ENTRY_STATUSES, default: 'Worked' }, hours: { type: Number, min: 0, max: 24, default: 0 } },
  { _id: false }
);

const monthlyHoursSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // 'YYYY-MM'
    contractHours: { type: Number, required: true, min: 0 },
    // Day-by-day entry (added 2026-09-12) was REVERTED 2026-09-16, the
    // user's own ask — back to two typed totals transcribed straight off
    // the client's own timesheet, the shape this app originally used
    // (see docs/MOBILISATION-notes.md's 2026-09-12 follow-up). `dailyHours`
    // stays defined ONLY so an already-entered record from that window
    // keeps showing its real per-day breakdown (view-only — see
    // DeploymentDetailPage.jsx) until someone actually corrects it, at
    // which point deployment.service.js's updateMonthlyHours clears it back
    // to `[]`; no NEW entry ever populates it again. `actualHours` is now
    // directly typed ("client timesheet hours") for any entry with an empty
    // `dailyHours`, trusted as-is (whoever transcribes the client's
    // timesheet already knows the number — same posture as
    // `deductionAmount` below) — only ever summed from `dailyHours` for a
    // pre-2026-09-16 record that still has it.
    dailyHours: { type: [dailyEntrySchema], default: [] },
    actualHours: { type: Number, required: true, min: 0 },
    // The SUBCONTRACTOR's own timesheet hours for this same month — added
    // 2026-09-19, the user's own ask: a real subcontractor keeps their own
    // record, which can legitimately differ from what the client's
    // timesheet shows (`actualHours` above). Only meaningful (and required —
    // see deployment.service.js's addMonthlyHours) for a SupplierEmployee
    // deployment, since only that type has a real subcontractor; stays null
    // and unused for Employee/Freelancer, which keep the original
    // contractHours-based OT formula below.
    supplierHours: { type: Number, min: 0, default: null },
    // How many real days the client's timesheet shows as worked that month
    // — added 2026-09-16, a second headline number a real timesheet always
    // carries alongside total hours. Informational/cross-check only, not
    // part of the otHours formula below. `0` on a pre-2026-09-16 record
    // that predates this field (never invented after the fact).
    daysWorked: { type: Number, default: 0, min: 0, max: 31 },
    // server-computed (deployment.service.js's computeOtHours) — SupplierEmployee:
    // max(0, actualHours - supplierHours); Employee/Freelancer, unchanged:
    // max(0, actualHours - contractHours).
    otHours: { type: Number, required: true, min: 0 },
    otAmount: { type: Number, default: 0, min: 0 }, // server-computed = otHours × Mobilisation.otClientRate — see module doc comment
    // A deduction the CLIENT applied on their own timesheet (their most
    // common reason: an Absent day — see DAILY_ENTRY_STATUSES above — but
    // this is whatever figure their timesheet actually shows, not something
    // this app derives from the Absent day count itself). Added 2026-09-13
    // per the user's own ask. Manually entered by whoever transcribes the
    // client's timesheet (never server-computed — there's no in-app formula
    // for what a client chooses to deduct, same posture as GOSI), but
    // deliberately NOT commercial like otAmount: the enterer already knows
    // the number, since she's the one typing it in from a real document in
    // front of her — hiding it from her afterward would hide nothing she
    // doesn't already know. Subtracted from this entry's own computed
    // profit (see computeMonthlyProfit) and, for a real Employee whose
    // Employee.type is 'Outsourced' (the only kind this company actually
    // pays), automatically seeded into that month's PayrollRun line as an
    // `otherDeductions` entry — see payroll.service.js's createPayrollRun
    // and deployment.service.js's deductionsForEmployeeMonth. Only an
    // APPROVED entry's deduction is ever picked up by Payroll — an
    // unapproved (possibly disputed) figure must never silently reduce a
    // real paycheck.
    deductionAmount: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 500 },
    enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enteredAt: { type: Date, default: Date.now },
    status: { type: String, enum: MONTHLY_HOURS_STATUSES, default: 'Pending' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true }
);

const deploymentSchema = new mongoose.Schema(
  {
    mobilisation: { type: mongoose.Schema.Types.ObjectId, ref: 'Mobilisation', required: true },
    workerType: { type: String, enum: WORKER_TYPES, required: true },
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: function () {
        return this.workerType === 'Employee';
      },
      default: null,
    },
    workerName: { type: String, required: true }, // snapshot

    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    clientName: { type: String, required: true }, // snapshot
    site: { type: String, trim: true, default: null }, // snapshot of Mobilisation.site — optional, free-typed there

    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', default: null },
    subcontractorName: { type: String, default: null }, // snapshot, SupplierEmployee only

    requiredTimesheetHours: { type: Number, default: null, min: 0 }, // snapshot of Mobilisation.requiredTimesheetHours

    startDate: { type: Date, required: true }, // = Mobilisation.mobilisationDate
    endDate: { type: Date, default: null },
    status: { type: String, enum: DEPLOYMENT_STATUSES, default: 'Active' },
    endReason: { type: String, enum: DEMOBILISATION_REASONS, default: null },
    // The outcome actually applied for the worker at demobilise time —
    // DEMOBILISATION_OUTCOME[endReason] for every reason except 'Other'
    // (whose outcome comes from an explicit form choice, see
    // deployment.service.js) — stored rather than re-derived so 'Other'
    // stays reportable too, and so a later change to the lookup table can
    // never silently reinterpret history.
    demobilisationOutcome: { type: String, enum: ['Standby', 'Exit'], default: null },
    releaseNote: { type: String, trim: true, maxlength: 1000 },

    monthlyHours: { type: [monthlyHoursSchema], default: [] },

    notes: { type: String, trim: true, maxlength: 1000 },

    // Worker-data archive — mirrors Mobilisation's own field exactly (see
    // that model's own doc comment). Set together with the source
    // Mobilisation by mobilisation.service.js's archiveWorkerData/
    // unarchiveWorkerData, never independently.
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One Deployment per Mobilisation, ever — createDeploymentFromMobilisation
// fires exactly once, when that mobilisation is approved.
deploymentSchema.index({ mobilisation: 1 }, { unique: true });
// The double-assignment guard for a real Employee worker: at most one Active
// deployment at a time. Excludes null `worker` (SupplierEmployee/Freelancer)
// from the partial index entirely, rather than colliding multiple nulls.
// Bug fixed 2026-09-12: MongoDB's partialFilterExpression does NOT support
// $ne at all (only $eq/$gt/$gte/$lt/$lte/$exists/$type, and $and of those) —
// it was silently DROPPED at index-creation time, leaving the real, already
// -built index as just `{ status: 'Active' }` with no worker condition, so
// every null-worker (SupplierEmployee/Freelancer) deployment collided as if
// they all shared one "worker". In production this meant only ONE Active
// Freelancer/SupplierEmployee deployment could exist system-wide at a time
// — found via a live E11000 error while verifying an unrelated feature, not
// user-reported. Same `$type` pattern NfcCard.model.js's own chipUid
// partial index already uses (a value can only be of BSON type 'objectId'
// if it's actually present and non-null, which is exactly "a real
// Employee").
deploymentSchema.index(
  { worker: 1 },
  { unique: true, partialFilterExpression: { status: 'Active', worker: { $type: 'objectId' } }, name: 'uniq_active_worker' }
);
deploymentSchema.index({ worker: 1, startDate: -1 });
deploymentSchema.index({ client: 1, status: 1 });
deploymentSchema.index({ startDate: -1 });

export default mongoose.model('Deployment', deploymentSchema);

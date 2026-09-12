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
 *    versions, emergency contact). One entry per calendar month; `otAmount`
 *    is a plain manually-entered number (no verified OT-commission formula
 *    trusted yet), same posture as Payroll's GOSI and Mobilisation's own
 *    original `profit` field. `otHours` IS server-computed
 *    (max(0, actualHours - contractHours)) — see deployment.service.js.
 */
import mongoose from 'mongoose';

export const DEPLOYMENT_SHIFTS = ['Day', 'Night', 'Rotating'];
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
    // One entry per calendar day of `month` (index 0 = day 1), added
    // 2026-09-12 so the client's real day-by-day timesheet can be entered
    // directly — same idea as Attendance's own day-by-day grid — instead of
    // only ever typing one aggregate number for the whole month. Each day
    // is `{status, hours}` (see DAILY_ENTRY_STATUSES above) — widened the
    // same day, before any real data existed in this shape yet, once a
    // plain worked-hours number per day turned out not to be enough.
    // `actualHours` is the sum of every 'Worked' day's `hours`, always
    // server-computed from this array (never trust a client-submitted
    // total when the real breakdown is right there — same rule as every
    // other derived financial figure in this app). A legacy entry from
    // before this existed has an empty `dailyHours` and keeps its own
    // already-stored `actualHours`.
    dailyHours: { type: [dailyEntrySchema], default: [] },
    actualHours: { type: Number, required: true, min: 0 },
    otHours: { type: Number, required: true, min: 0 }, // server-computed = max(0, actualHours - contractHours)
    otAmount: { type: Number, default: 0, min: 0 }, // manually entered — see module doc comment
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

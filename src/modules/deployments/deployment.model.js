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
export const DEPLOYMENT_STATUSES = ['Active', 'Ended'];
/** Why an Active deployment was ended. Release is the only real way a
 *  Deployment ends now — no more direct Transfer (moving to a different
 *  client always goes through a brand new Mobilisation and its own
 *  approval, never a same-step swap). */
export const DEPLOYMENT_END_REASONS = ['Released'];
export const WORKER_TYPES = ['Employee', 'SupplierEmployee', 'Freelancer'];

/** One calendar month's actual client-timesheet hours, entered once the
 *  month has fully ended. `contractHours` is snapshotted at entry time from
 *  the deployment's own `requiredTimesheetHours` — a stable point-in-time
 *  reference even if that figure is ever revisited later. */
const monthlyHoursSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // 'YYYY-MM'
    contractHours: { type: Number, required: true, min: 0 },
    actualHours: { type: Number, required: true, min: 0 },
    otHours: { type: Number, required: true, min: 0 }, // server-computed = max(0, actualHours - contractHours)
    otAmount: { type: Number, default: 0, min: 0 }, // manually entered — see module doc comment
    notes: { type: String, trim: true, maxlength: 500 },
    enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enteredAt: { type: Date, default: Date.now },
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
    endReason: { type: String, enum: DEPLOYMENT_END_REASONS, default: null },
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
deploymentSchema.index(
  { worker: 1 },
  { unique: true, partialFilterExpression: { status: 'Active', worker: { $ne: null } }, name: 'uniq_active_worker' }
);
deploymentSchema.index({ worker: 1, startDate: -1 });
deploymentSchema.index({ client: 1, status: 1 });
deploymentSchema.index({ startDate: -1 });

export default mongoose.model('Deployment', deploymentSchema);

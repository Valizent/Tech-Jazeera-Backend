/**
 * Requirement — a client's ask for workers that has come in but isn't mobilised
 * yet: the card on the pre-mobilisation board. It exists BEFORE any specific
 * worker is committed, which is exactly what a Mobilisation (named worker,
 * client rate, start date) can't represent — a Requirement is what turns into
 * one or more Mobilisations later.
 *
 * Deliberately NO commercial fields (no rates, commissions, profit): those are
 * entered at Mobilisation time and are stripped from coordinators there. Keeping
 * them off this record means a coordinator can safely see all of every card
 * they're on — there is nothing here to hide.
 *
 * `clientName` is always stored (a snapshot, like every other clientName in this
 * app); `client` is set only when that name matches an approved, active Client.
 * A requirement can therefore arrive from a company that isn't a client yet, and
 * gets linked the moment the name matches one — the handoff to a Mobilisation
 * needs the link, the pipeline itself doesn't.
 *
 * `stageHistory` is EMBEDDED — it lives and dies with the card, is only ever
 * read with it, and is append-only. `stageEnteredAt` is what "days in this
 * stage" (and the stale flag) is measured from.
 *
 * `candidates` (milestone 3) is EMBEDDED too: the specific workers being lined up
 * for this requirement — who they are, where they came from, how far their
 * paperwork is. They live and die with the card and are only ever read with it.
 * Once a candidate's documents are ready, "Start mobilisation" creates a real
 * Mobilisation for them (linked back via `mobilisation`), and that mobilisation's
 * final approval is what marks the candidate Mobilised.
 */
import mongoose from 'mongoose';

const stageMoveSchema = new mongoose.Schema(
  {
    stage: { type: mongoose.Schema.Types.ObjectId, ref: 'RequirementStage', required: true },
    stageName: { type: String, required: true }, // snapshot — survives the stage being renamed or deleted
    movedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    movedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Where a candidate is in getting ready. A person, not a placement, so this is
 *  deliberately small and fixed (the board's STAGES are the admin-editable part).
 *  'Mobilised' is set only by the system, when the linked mobilisation is
 *  approved — never by hand (see requirement.validation.js's MANUAL_CANDIDATE_STATUSES). */
export const CANDIDATE_STATUSES = ['Identified', 'DocsInProgress', 'DocsReady', 'Mobilised', 'Dropped'];
/** The two worker types a candidate can be — a subcontractor's worker or an
 *  independent one. An own employee is mobilised from the Standby list instead
 *  (its picker needs Employees access a coordinator usually doesn't have). */
export const CANDIDATE_WORKER_TYPES = ['SupplierEmployee', 'Freelancer'];

const candidateSchema = new mongoose.Schema({
  workerType: { type: String, enum: CANDIDATE_WORKER_TYPES, required: true },
  workerName: { type: String, required: true, trim: true, maxlength: 150 },
  iqamaNumber: { type: String, trim: true, default: null }, // often not known yet — optional
  nationality: { type: String, trim: true, maxlength: 80, default: null },
  phone: { type: String, trim: true, maxlength: 30, default: null },
  // Only for SupplierEmployee. `subcontractorName` is the usual durable snapshot.
  subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', default: null },
  subcontractorName: { type: String, default: null },
  status: { type: String, enum: CANDIDATE_STATUSES, default: 'Identified' },
  docsNote: { type: String, trim: true, maxlength: 300, default: null }, // e.g. "passport received, medical pending"
  // The Mobilisation started for this candidate. Mobilisations can't be deleted,
  // so this never dangles; a REJECTED one is still the candidate's (the coordinator
  // fixes and resubmits the same record), which is why it isn't cleared.
  mobilisation: { type: mongoose.Schema.Types.ObjectId, ref: 'Mobilisation', default: null },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  addedAt: { type: Date, default: Date.now },
});

const requirementSchema = new mongoose.Schema(
  {
    serialNumber: { type: String, required: true, unique: true }, // 'REQ-0001', via counter.model.js's nextSequence
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    clientName: { type: String, required: true, trim: true, maxlength: 150 },
    jobTitle: { type: String, required: true, trim: true, maxlength: 150 },
    headcount: { type: Number, required: true, min: 1, max: 500, default: 1 },
    neededBy: { type: Date, default: null }, // date-only, UTC midnight
    site: { type: String, trim: true, maxlength: 150, default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: null },

    // Every coordinator working this requirement — always real, active
    // `Coordinator` logins (enforced in requirement.service.js).
    coordinators: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'A requirement needs at least one coordinator.' },
    },

    stage: { type: mongoose.Schema.Types.ObjectId, ref: 'RequirementStage', required: true },
    stageEnteredAt: { type: Date, required: true, default: Date.now },
    stageHistory: { type: [stageMoveSchema], default: [] },
    candidates: { type: [candidateSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

requirementSchema.index({ stage: 1, stageEnteredAt: 1 });
requirementSchema.index({ coordinators: 1 });
// getBoard's own sort (requirement.service.js) — the WHOLE board across
// every stage at once (client/coordinator columns are grouped client-side),
// so it sorts by `stageEnteredAt` alone, never filtered by `stage` first.
// The compound index above doesn't serve that (its leading field is
// `stage`); added 2026-09-22, a real QA-audit finding (P10): that sort was
// doing SORT over COLLSCAN with no supporting index. The `{stage:1,
// stageEnteredAt:1}` index above stays — countStaleRequirements's own
// per-stage staleness filter (stage equality + a stageEnteredAt range) is a
// real, different query shape that index still serves.
requirementSchema.index({ stageEnteredAt: 1, _id: 1 });

export default mongoose.model('Requirement', requirementSchema);

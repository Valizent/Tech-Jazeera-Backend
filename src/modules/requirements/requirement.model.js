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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

requirementSchema.index({ stage: 1, stageEnteredAt: 1 });
requirementSchema.index({ coordinators: 1 });

export default mongoose.model('Requirement', requirementSchema);

/**
 * RequirementStage — one column of the Requirements board ("Sourcing",
 * "Documentation in progress", ...). Admin-editable, per the user's decision:
 * the company decides its own stages instead of the app hardcoding a pipeline.
 *
 * Two behaviours hang off a stage, both optional:
 *   - `staleAfterDays` — a card sitting in this stage that long is flagged
 *     stale. Per stage, because "waiting on documents" legitimately takes
 *     longer than "new, nobody has started". Null = never flagged.
 *   - `notifyOnEnter` — moving a card INTO this stage notifies everyone in the
 *     `requirementsTeam` circle (typically the stage that means "ready to
 *     mobilise", so the people who mobilise hear about it).
 *
 * `isTerminal` marks a stage where the work is finished (mobilised, lost).
 * It's never flagged stale, and its cards drop off the default board once
 * they've sat there for a month. A paused requirement ("On hold") is NOT
 * terminal — it should stay visible until someone resumes it.
 */
import mongoose from 'mongoose';

const requirementStageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    order: { type: Number, required: true },
    staleAfterDays: { type: Number, min: 1, max: 365, default: null },
    isTerminal: { type: Boolean, default: false },
    notifyOnEnter: { type: Boolean, default: false },
  },
  { timestamps: true }
);

requirementStageSchema.index({ order: 1 });
// Case-insensitive uniqueness: "Sourcing" and "sourcing" are the same column.
requirementStageSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export default mongoose.model('RequirementStage', requirementStageSchema);

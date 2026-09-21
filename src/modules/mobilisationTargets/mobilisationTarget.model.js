/**
 * MobilisationTarget — one document per coordinator per calendar month.
 * Stores the target mobilisation count and the incentive percentage that
 * kicks in for every mobilisation BEYOND the target (the coordinator earns
 * that % of each extra mobilisation's profitPerMonth as a bonus).
 *
 * Unique on { coordinator, month } — only one active target per
 * coordinator per month (upsert semantics in the service layer).
 */
import mongoose from 'mongoose';

const mobilisationTargetSchema = new mongoose.Schema(
  {
    /** The Coordinator user this target is for. */
    coordinator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** 'YYYY-MM' — the calendar month this target covers (e.g. '2026-09'). */
    month: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.'],
    },

    /** Number of Approved/Completed mobilisations the coordinator must reach. */
    target: { type: Number, required: true, min: 1 },

    /**
     * Percentage of profitPerMonth the coordinator earns for every
     * mobilisation BEYOND the target. Set by whoever has the
     * `mobilisationTargets` Section Access write grant.
     * 0 means "no incentive configured".
     */
    incentivePercent: { type: Number, default: 0, min: 0, max: 100 },

    /** Who set/last edited this target. */
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One target per coordinator per month — upsert replaces instead of
// accumulating duplicates.
mobilisationTargetSchema.index({ coordinator: 1, month: 1 }, { unique: true });

export default mongoose.model('MobilisationTarget', mobilisationTargetSchema);

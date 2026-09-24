/**
 * MobilisationTarget — one document per coordinator per calendar month.
 * Stores the target — a Riyal amount of estimated monthly profit the
 * coordinator's Approved/Completed mobilisations should bring to the
 * company (2026-09-22, real user correction: this used to be a plain
 * mobilisation COUNT; a coordinator's real value to the company is the
 * profit their placements bring in, not how many they closed) — and the
 * incentive percentage that kicks in for every mobilisation counted AFTER
 * the coordinator's cumulative profit crosses that Riyal target (the
 * coordinator earns that % of each such mobilisation's own profitPerMonth
 * as a bonus).
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

    /** Riyal amount of estimated monthly profit (sum of profitPerMonth
     *  across Approved/Completed mobilisations) the coordinator must reach. */
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

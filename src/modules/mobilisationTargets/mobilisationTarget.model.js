/**
 * MobilisationTarget — one document per coordinator per calendar month.
 * Stores the Riyal target a coordinator's REAL revenue (2026-09-27,
 * replacing the original 2026-09-22 profitPerMonth-estimate version — see
 * mobilisationTarget.service.js's own top doc comment) should reach that
 * month, plus two independent incentive percentages:
 *
 *  - `incentivePercent` — monthly, kicks in once the month's real `achieved`
 *    crosses `target` (currently informational; not yet turned into a
 *    computed bonus amount anywhere).
 *  - `semiAnnualIncentivePercent` — a DIFFERENT, standing rate (2026-09-27)
 *    for the rolling-6-month tracker: once a coordinator's trailing 6-month
 *    real revenue crosses 6 months' worth of targets, they earn this % of
 *    the NET PROFIT attributable to the excess only (not the whole period).
 *    Set on whichever month's target is most recently edited — a rolling
 *    window pulls together up to 6 separate target documents, so the MOST
 *    RECENT one's value is treated as the coordinator's current standing
 *    rate, same simplification as `target` itself already requires no
 *    special "semi-annual" document of its own.
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

    /** Riyal amount of real revenue (mobilisationTarget.service.js's
     *  realRevenueByCoordinator) the coordinator must reach this month. */
    target: { type: Number, required: true, min: 1 },

    /**
     * Percentage the coordinator earns for every Riyal of real revenue
     * credited AFTER crossing `target` this month. Set by whoever has the
     * `mobilisationTargets` Section Access write grant. 0 means "no
     * incentive configured".
     */
    incentivePercent: { type: Number, default: 0, min: 0, max: 100 },

    /** See this file's own top doc comment. 0 means "no semi-annual
     *  incentive configured". */
    semiAnnualIncentivePercent: { type: Number, default: 0, min: 0, max: 100 },

    /** Who set/last edited this target. */
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One target per coordinator per month — upsert replaces instead of
// accumulating duplicates.
mobilisationTargetSchema.index({ coordinator: 1, month: 1 }, { unique: true });

export default mongoose.model('MobilisationTarget', mobilisationTargetSchema);

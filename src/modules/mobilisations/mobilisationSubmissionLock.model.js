/**
 * A short-lived, per-worker advisory lock — fixed 2026-09-29, a real audit
 * finding: `assertNoActivePlacement`/`assertNoActiveNonEmployeePlacement`
 * (mobilisation.service.js) are plain reads with no atomic conditional
 * update to run against (there's no Mobilisation document yet to compare
 * to), so two near-simultaneous `createMobilisation` calls for the SAME
 * worker/Iqama could both pass the check before either inserts, producing
 * two independently-approvable mobilisations for one physical worker — the
 * exact race class `leaveSubmissionLock.model.js` was built to close for
 * Leave, applied here to the same underlying problem.
 *
 * Keyed by a plain string rather than an Employee ref, since a
 * SupplierEmployee/Freelancer worker has no Employee record at all — the
 * key is `employee:<id>` for a real Employee or `iqama:<number>` for
 * everyone else (see `mobilisationWorkerLockKey` in mobilisation.service.js).
 * Acquired via `create()` (the unique index lets only ONE concurrent insert
 * for the same key succeed — the loser gets a duplicate-key error,
 * translated to a 409) and released via `deleteOne()` in a `finally` block
 * around the whole create flow. The TTL index is a crash-safety net only,
 * not the normal release path.
 */
import mongoose from 'mongoose';

const mobilisationSubmissionLockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 30 },
});

export default mongoose.model('MobilisationSubmissionLock', mobilisationSubmissionLockSchema);

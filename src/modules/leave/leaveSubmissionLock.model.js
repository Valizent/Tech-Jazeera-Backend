/**
 * A short-lived, per-employee advisory lock — fixed 2026-09-15, a real
 * QA-audit-found gap — F3: two concurrent leave submissions for the same
 * employee could both pass the overlap check and the entitlement check
 * against the same pre-either-request snapshot, then both create, leaving
 * two overlapping requests and total approved days exceeding the real
 * entitlement. Neither check has a single document to run an atomic
 * conditional update against (a brand-new LeaveRequest doesn't exist yet to
 * compare against), so — same reasoning the report itself gives — a real
 * serialization point is required, not just wrapping the reads/insert in a
 * transaction (which does not by itself prevent two transactions each
 * inserting a DIFFERENT new document from both committing).
 *
 * Acquired via `create()` (the unique index makes only ONE concurrent
 * insert for the same employee succeed — the loser gets a duplicate-key
 * error, translated to a 409) and released via `deleteOne()` in a `finally`
 * block around the whole submit flow — see leave.service.js's
 * submitLeaveRequest. The TTL index is a crash-safety net only (if the
 * process died between acquire and release), not the normal release path;
 * 30s is far longer than this synchronous check-then-create ever takes.
 */
import mongoose from 'mongoose';

const leaveSubmissionLockSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 30 },
});

export default mongoose.model('LeaveSubmissionLock', leaveSubmissionLockSchema);

/**
 * Notification — a persisted, in-app record of something a user should
 * know about (P3-F). This is the source of truth; a push notification
 * (see pushSubscription.model.js) is a best-effort real-time nudge on top
 * of it, never the only copy — a push can be missed (permission not
 * granted, device offline, browser closed), but this list can't be.
 */
import mongoose from 'mongoose';

// 'Task' (added 2026-09-20): a daily-update task was assigned to you, or one
// you assigned was completed — not an approval decision, so not 'RequestStatus'.
// 'Requirement' (added 2026-09-20): a pre-mobilisation requirement was assigned
// to you, or moved along the board.
export const NOTIFICATION_TYPES = ['Expiry', 'RequestStatus', 'Task', 'Requirement'];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, trim: true, maxlength: 500 },
    // A client-side route to open on click (e.g. "/me/leave"). Optional —
    // some notifications are informational only.
    url: { type: String, trim: true, maxlength: 300 },
    read: { type: Boolean, default: false },
    // Only set for type 'Expiry': lets the daily expiry-alert job re-run
    // safely without re-notifying the same still-expiring item every day —
    // see notifications/expiryAlert.job.js. A sparse unique index makes
    // this work, but ONLY because most notifications leave the field
    // genuinely absent rather than explicitly null — deliberately no
    // `default: null` here (Mongoose would then write every plain
    // notification with `dedupeKey: null`, and a sparse index does NOT
    // skip "present with value null", only "the field doesn't exist" — the
    // second such document would collide with the first on that shared
    // null value). See notification.service.js's notifyUser().
    dedupeKey: { type: String },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export default mongoose.model('Notification', notificationSchema);

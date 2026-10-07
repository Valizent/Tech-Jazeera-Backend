/**
 * DevicePushToken — one phone's Expo push token for a user (the native
 * mobile app, 2026-10-06 — see docs/MOBILE-RN-notes.md, M2). The phone's
 * twin of PushSubscription (which is a browser's Web Push endpoint): the app
 * registers its token after sign-in and removes it on sign-out.
 *
 * `token` is the unique key — each app install mints its own. A phone that
 * signs in as someone else moves its token to the new user (an upsert on
 * `token`), so a shared phone never keeps receiving the previous person's
 * notifications.
 */
import mongoose from 'mongoose';

export const DEVICE_PLATFORMS = ['android', 'ios'];

const devicePushTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
    // Informational only ("Pixel 8", "iPhone 15") — never used for logic.
    deviceName: { type: String, trim: true, maxlength: 100 },
  },
  { timestamps: true }
);

export default mongoose.model('DevicePushToken', devicePushTokenSchema);

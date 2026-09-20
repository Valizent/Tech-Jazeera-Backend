/**
 * Notification service (P3-F) — the in-app list (the reliable channel) plus
 * best-effort Web Push delivery on top of it. See notification.model.js and
 * config/webPush.js for why push is additive, never the only copy.
 */
import { webpush, pushEnabled } from '../../config/webPush.js';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import User from '../auth/user.model.js';
import Notification from './notification.model.js';
import PushSubscription from './pushSubscription.model.js';
import ApiError from '../../utils/ApiError.js';

/**
 * Push the notification to every device this user has subscribed on.
 * Best-effort: a failed send never throws back to the caller — the
 * Notification record already exists regardless of whether push succeeds.
 * A 404/410 from the push service means that subscription is dead (the
 * browser un-registered it, or the device was reset) — standard Web Push
 * hygiene is to delete it so we stop wasting sends on it.
 */
async function pushToUser(userId, notification) {
  if (!pushEnabled) return;
  const subscriptions = await PushSubscription.find({ user: userId }).lean();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url,
  });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          logger.warn(`[notifications] push send failed (${err.statusCode ?? 'no status'}): ${err.message}`);
        }
      }
    })
  );
}

/**
 * Create a notification for a user and push it. `dedupeKey`, when given,
 * makes this idempotent — a second call with the same key is a no-op
 * (used by the expiry-alert job, which re-scans daily and must not spam
 * the same still-expiring item every run). The returned object carries a
 * non-persisted `wasNew` flag so a bulk caller (the expiry job) can report
 * an accurate "X new notifications" count instead of counting every call
 * it made, most of which are no-op repeats on any given day.
 */
export async function notifyUser(userId, { type, title, body, url, dedupeKey }) {
  if (dedupeKey) {
    const existing = await Notification.findOne({ dedupeKey }).lean();
    if (existing) return { ...existing, wasNew: false }; // already notified for this exact item/expiry combination
  }

  // dedupeKey is only ever set on the document when one was actually given —
  // never explicitly `null`. The uniqueness index on it is sparse (skips
  // documents where the field doesn't exist at all), which only holds if
  // "no dedupeKey" means the key is OMITTED, not present-with-value-null;
  // setting it to null on every plain request-status notification would
  // make them all collide on that one shared null value the moment a
  // second one is ever created.
  const attrs = { user: userId, type, title, body, url };
  if (dedupeKey) attrs.dedupeKey = dedupeKey;
  const notification = await Notification.create(attrs);
  await pushToUser(userId, notification);
  return { ...notification.toObject(), wasNew: true };
}

/**
 * notifyUser, but a failure only logs a warning and returns null — for the
 * many callers where a notification is a courtesy on top of a real action
 * (assigning a task, moving a requirement) and must never fail that action.
 */
export async function notifyUserSafely(userId, payload) {
  try {
    return await notifyUser(userId, payload);
  } catch (err) {
    logger.warn(`[notifications] notification to ${userId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the employee's own login (if one has been provisioned) and notify
 * it. Silently does nothing if the employee has no login — most Client-type
 * employees don't (see P2-M1), so this is the normal case, not an error.
 *
 * `data.url` may be a plain string, or a `(role) => url` function for a
 * caller whose recipient could be either a Worker (ESS portal, `/me/...`)
 * or a staff self-submitter (admin shell, e.g. `/leave`) — the Approval
 * Hierarchy's staff self-submission (P2-M4+) means a request's own
 * requester is no longer always a Worker.
 */
export async function notifyEmployeeUser(employeeId, data) {
  const user = await User.findOne({ employee: employeeId }).select('_id role').lean();
  if (!user) return null;
  const url = typeof data.url === 'function' ? data.url(user.role) : data.url;
  return notifyUser(user._id, { ...data, url });
}

export async function listNotifications(userId, { page, limit, unreadOnly }) {
  const filter = { user: userId };
  if (unreadOnly) filter.read = false;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: userId, read: false }),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)), unreadCount };
}

export async function markNotificationRead(userId, id) {
  const notification = await Notification.findOneAndUpdate({ _id: id, user: userId }, { read: true }, { new: true }).lean();
  if (!notification) throw new ApiError(404, 'Notification not found.');
  return notification;
}

export async function markAllNotificationsRead(userId) {
  const result = await Notification.updateMany({ user: userId, read: false }, { read: true });
  return { updated: result.modifiedCount };
}

export function getVapidPublicKey() {
  return { publicKey: pushEnabled ? env.vapidPublicKey : null };
}

export async function subscribeToPush(userId, { endpoint, keys, userAgent }) {
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: userId, endpoint, keys, userAgent },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function unsubscribeFromPush(userId, endpoint) {
  await PushSubscription.deleteOne({ endpoint, user: userId });
}

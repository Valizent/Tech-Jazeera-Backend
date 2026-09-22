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

// A real Web Push send can hang or run long (a slow/unreachable push
// service) — bound how long ONE send is allowed to hold a worker slot
// (below), so a single bad endpoint can't quietly tie one up indefinitely.
const PUSH_SEND_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`push send timed out after ${ms}ms`)), ms)),
  ]);
}

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
        await withTimeout(webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload), PUSH_SEND_TIMEOUT_MS);
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
 * A small bounded-concurrency queue for push delivery (2026-09-22, a real
 * QA-audit finding — P5): notifyUser below used to `await pushToUser(...)`
 * before returning, so a save response (and every caller looping over
 * several recipients — e.g. requirement.service.js notifying a whole card's
 * coordinators) sat waiting on an external push service that can be slow.
 * Reproduced: one recipient added 259ms to the response, four sequential
 * recipients added 1055ms, entirely from this await.
 *
 * This is deliberately NOT a bare fire-and-forget promise per call (the
 * audit's own explicit warning against "detached, unreliable promises as
 * the only delivery mechanism") — it's ONE persistent queue drained by a
 * small, bounded pool of workers, so delivery has real bounded concurrency
 * (PUSH_CONCURRENCY, not literally unbounded parallel sends) and every
 * failure is caught inside the worker (never an unhandled rejection). The
 * Notification document itself — created and awaited BEFORE this is called
 * — is already the durable, reliable record (this file's own top doc
 * comment); push has always been the best-effort copy on top of it, so a
 * job lost to a process restart loses nothing a bare unawaited promise
 * wouldn't already have lost — a full persisted outbox would be real new
 * infrastructure for a channel that was never meant to be more durable than
 * this, so it stays in-process, the same "no new scheduler dependency"
 * posture the expiry-alert job's own setInterval already established.
 */
const PUSH_CONCURRENCY = 5;
const pushQueue = [];
let activePushWorkers = 0;

function enqueuePush(userId, notification) {
  pushQueue.push({ userId, notification });
  // Each existing worker drains the WHOLE queue itself (see its own while
  // loop below), so at most one new worker ever needs starting per call —
  // spawning more here would just mean two workers racing shift() on an
  // already-covered queue.
  if (activePushWorkers < PUSH_CONCURRENCY) {
    activePushWorkers += 1;
    runPushWorker();
  }
}

async function runPushWorker() {
  try {
    let job;
    while ((job = pushQueue.shift())) {
      try {
        await pushToUser(job.userId, job.notification);
      } catch (err) {
        // pushToUser already catches per-subscription; this only guards
        // against a failure in pushToUser itself (e.g. the subscription
        // lookup query), so the worker loop can never die on one bad job.
        logger.warn(`[notifications] queued push to ${job.userId} failed: ${err.message}`);
      }
    }
  } finally {
    activePushWorkers -= 1;
  }
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
  // Not awaited — see enqueuePush's own doc comment above for why this is
  // still a real, bounded, non-silent delivery mechanism, not a bare
  // fire-and-forget promise.
  enqueuePush(userId, notification);
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

/**
 * Just the unread count — one query, not the three `listNotifications` above
 * runs. Added 2026-09-22 (a real QA-audit finding — P1): the bell's own 10s
 * poll only ever needs this number for its badge; it used to run the full
 * list (3 queries) every 10 seconds per open tab just to read one field off
 * the response. The full list is now only fetched when the panel opens.
 */
export async function getUnreadCount(userId) {
  const unreadCount = await Notification.countDocuments({ user: userId, read: false });
  return { unreadCount };
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

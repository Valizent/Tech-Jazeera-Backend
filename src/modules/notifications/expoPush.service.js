/**
 * Phone push for the native mobile app, through Expo's push service (which
 * relays to Firebase Cloud Messaging on Android and APNs on iOS) — the
 * phone's twin of the Web Push send in notification.service.js, and just as
 * best-effort: the Notification document is always the real record, push is
 * the copy on top of it.
 *
 * Plain `fetch` to Expo's documented HTTP endpoint — Node 22 has it built
 * in, so this needs no SDK dependency. One request per notification carries
 * every device the user is signed in on (a person has a handful of phones at
 * most; Expo's own limit is 100 messages per request).
 *
 * `data.url` is the same web path the in-app list already uses — the app's
 * routes mirror the web's, so tapping the push opens the matching screen —
 * and `data.notificationId` lets the app mark the in-app copy read.
 */
import logger from '../../config/logger.js';
import DevicePushToken from './devicePushToken.model.js';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TIMEOUT_MS = 10_000;

export async function sendExpoPush(userId, notification) {
  const devices = await DevicePushToken.find({ user: userId }).select('token').lean();
  if (devices.length === 0) return;

  const messages = devices.map((device) => ({
    to: device.token,
    title: notification.title,
    ...(notification.body ? { body: notification.body } : {}),
    data: { url: notification.url ?? null, notificationId: String(notification._id) },
    sound: 'default',
    priority: 'high',
    // The app creates this Android channel before registering (src/lib/push.js).
    channelId: 'default',
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
  });
  if (!response.ok) {
    logger.warn(`[notifications] Expo push request failed (${response.status})`);
    return;
  }

  // One ticket per message, in the same order. DeviceNotRegistered means the
  // app was uninstalled or its token replaced — standard hygiene is to stop
  // sending to it, exactly like a 404/410 Web Push subscription.
  const { data: tickets = [] } = await response.json();
  const deadTokens = [];
  tickets.forEach((ticket, i) => {
    if (ticket.status !== 'error') return;
    if (ticket.details?.error === 'DeviceNotRegistered') deadTokens.push(messages[i].to);
    else logger.warn(`[notifications] Expo push ticket error (${ticket.details?.error ?? 'unknown'}): ${ticket.message}`);
  });
  if (deadTokens.length > 0) await DevicePushToken.deleteMany({ token: { $in: deadTokens } });
}

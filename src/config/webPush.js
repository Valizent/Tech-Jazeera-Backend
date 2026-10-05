/**
 * Web Push (P3-F) configuration — the app's own VAPID identity, not a
 * third-party API key. `pushEnabled` is false whenever the keys aren't
 * configured (a fresh checkout, or a deployment that hasn't run
 * `npm run generate:vapid` yet); every caller checks it and degrades to
 * "notification recorded, not pushed" rather than throwing — the in-app
 * notification list (notification.service.js) is the reliable channel,
 * push is a best-effort enhancement on top of it.
 */
import webpush from 'web-push';
import env from './env.js';
import logger from './logger.js';

export const pushEnabled = Boolean(env.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject);

if (pushEnabled) {
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
} else {
  logger.warn(
    '[webPush] VAPID keys not configured push notifications are disabled. ' +
      'Run `npm run generate:vapid` and add the output to server/.env to enable them.'
  );
}

export { webpush };

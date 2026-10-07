/**
 * Notification routes (P3-F). requireAuth only — deliberately NOT
 * requireStaff: notifications are personal to any logged-in user, and a
 * Worker needs their own list (their leave/timesheet/request decisions)
 * exactly as much as staff need theirs (expiry alerts, client submissions).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  listNotificationsSchema,
  notificationIdParamSchema,
  subscribePushSchema,
  unsubscribePushSchema,
  registerDeviceSchema,
  unregisterDeviceSchema,
} from './notification.validation.js';
import * as notificationController from './notification.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', validate({ query: listNotificationsSchema }), asyncHandler(notificationController.list));
// The bell badge's own lightweight poll (2026-09-22, a real QA-audit finding
// — P1) — one query, not the full list's three.
router.get('/unread-count', asyncHandler(notificationController.unreadCount));
router.get('/vapid-public-key', asyncHandler(notificationController.vapidPublicKey));
router.patch('/:id/read', validate({ params: notificationIdParamSchema }), asyncHandler(notificationController.markRead));
router.post('/read-all', asyncHandler(notificationController.markAllRead));
router.post('/subscribe', validate({ body: subscribePushSchema }), asyncHandler(notificationController.subscribe));
router.post('/unsubscribe', validate({ body: unsubscribePushSchema }), asyncHandler(notificationController.unsubscribe));
// The native mobile app's Expo push token (2026-10-06, M2) — the phone's
// equivalent of /subscribe + /unsubscribe above.
router.post('/devices', validate({ body: registerDeviceSchema }), asyncHandler(notificationController.registerDevice));
router.delete('/devices', validate({ body: unregisterDeviceSchema }), asyncHandler(notificationController.unregisterDevice));

export default router;

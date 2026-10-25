/**
 * Chat routes. Every office staff login and Executive can chat; Worker and Staff
 * self-service logins cannot (the router-level gate). Conversations are visible to
 * their members only, and a non-member gets the same 404 as a missing one.
 *
 * The only Section Access key is `chatModeration` (Write): reviewing messages that
 * a member reported and removing them. It never exposes ordinary conversations.
 *
 * Messages are SENT here (multipart: optional text + optional image/PDF in field
 * `file`); the real-time socket only signals that a conversation changed.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaffOrExecutive } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadChatAttachment, destroyDocumentFile } from '../../middleware/upload.js';
import logger from '../../config/logger.js';
import {
  idParamSchema,
  createConversationSchema,
  updateConversationSchema,
  listConversationsSchema,
  listMessagesSchema,
  sendMessageSchema,
  reportMessageSchema,
  directoryQuerySchema,
  listReportsSchema,
  decideReportSchema,
} from './chat.validation.js';
import * as controller from './chat.controller.js';

const router = Router();

router.use(requireAuth, requireStaffOrExecutive);

router.get('/unread-count', asyncHandler(controller.unreadCount));
router.get('/directory', validate({ query: directoryQuerySchema }), asyncHandler(controller.directory));

router.get('/conversations', validate({ query: listConversationsSchema }), asyncHandler(controller.listConversations));
router.post('/conversations', validate({ body: createConversationSchema }), asyncHandler(controller.createConversation));
router.patch(
  '/conversations/:id',
  validate({ params: idParamSchema, body: updateConversationSchema }),
  asyncHandler(controller.updateConversation)
);
router.delete('/conversations/:id/members/me', validate({ params: idParamSchema }), asyncHandler(controller.leaveConversation));
router.get(
  '/conversations/:id/messages',
  validate({ params: idParamSchema, query: listMessagesSchema }),
  asyncHandler(controller.listMessages)
);
router.post(
  '/conversations/:id/messages',
  validate({ params: idParamSchema }),
  uploadChatAttachment,
  validate({ body: sendMessageSchema }),
  asyncHandler(controller.sendMessage)
);
router.post('/conversations/:id/read', validate({ params: idParamSchema }), asyncHandler(controller.markRead));

router.delete('/messages/:id', validate({ params: idParamSchema }), asyncHandler(controller.deleteMessage));
router.get('/messages/:id/file', validate({ params: idParamSchema }), asyncHandler(controller.messageFile));
router.post(
  '/messages/:id/report',
  validate({ params: idParamSchema, body: reportMessageSchema }),
  asyncHandler(controller.reportMessage)
);

const moderate = requireSectionAccess('chatModeration', 'write');
router.get('/reports', moderate, validate({ query: listReportsSchema }), asyncHandler(controller.listReports));
router.get('/reports/:id/file', moderate, validate({ params: idParamSchema }), asyncHandler(controller.reportFile));
router.patch(
  '/reports/:id',
  moderate,
  validate({ params: idParamSchema, body: decideReportSchema }),
  asyncHandler(controller.decideReport)
);

/** An upload whose request then failed is removed from storage again (same cleanup as the other upload routes). */
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[chat] orphaned upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

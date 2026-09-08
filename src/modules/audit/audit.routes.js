import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { listAuditSchema } from './audit.validation.js';
import * as auditController from './audit.controller.js';

const router = Router();

// Section Access key 'auditLog' at the 'read' level — default [] (nobody
// but Admin), matching today's Admin-only behavior exactly until an Admin
// grants someone else. There is no write action for this key — the audit
// trail is system-generated, never manually written.
router.get(
  '/',
  requireAuth,
  requireSectionAccess('auditLog', 'read'),
  validate({ query: listAuditSchema }),
  asyncHandler(auditController.list)
);

export default router;

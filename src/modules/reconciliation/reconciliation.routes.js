/**
 * Reconciliation routes — a read-only integrity report. Section Access key
 * 'reconciliation' at the 'read' level, default [] (nobody but Admin),
 * same shape as 'auditLog' — no write action, since this report only ever
 * reads and links to real records for a human to act on.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import * as reconciliationController from './reconciliation.controller.js';

const router = Router();

router.get('/', requireAuth, requireSectionAccess('reconciliation', 'read'), asyncHandler(reconciliationController.run));

export default router;

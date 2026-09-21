/**
 * Requirements routes.
 *
 * The CARD routes carry no per-route requireSectionAccess gate: which of the two
 * keys applies (`requirementsOwn` / `requirementsTeam`) depends on the card being
 * touched, and a route gate can only ask one question up front — the service
 * resolves access once per request and enforces it per action (same shape as
 * dailyUpdate.routes.js). The STAGE routes are different: one key, one question,
 * so `requirementStages` (Write) gates them here. requireStaff stays the floor.
 *
 * Order matters: every fixed path ('board', 'coordinators', 'stages/...') is
 * registered before '/:id', or it would be read as a requirement id.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createRequirementSchema,
  updateRequirementSchema,
  moveStageSchema,
  boardQuerySchema,
  requirementIdParamSchema,
  createStageSchema,
  updateStageSchema,
  reorderStagesSchema,
  stageIdParamSchema,
  createCandidateSchema,
  updateCandidateSchema,
  candidateParamSchema,
} from './requirement.validation.js';
import * as controller from './requirement.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

const canManageStages = requireSectionAccess('requirementStages', 'write');

router.get('/board', validate({ query: boardQuerySchema }), asyncHandler(controller.board));
router.get('/coordinators', asyncHandler(controller.coordinators));

router.post('/stages/defaults', canManageStages, asyncHandler(controller.createSuggestedStages));
router.put('/stages/order', canManageStages, validate({ body: reorderStagesSchema }), asyncHandler(controller.reorderStages));
router.post('/stages', canManageStages, validate({ body: createStageSchema }), asyncHandler(controller.createStage));
router.patch(
  '/stages/:id',
  canManageStages,
  validate({ params: stageIdParamSchema, body: updateStageSchema }),
  asyncHandler(controller.updateStage)
);
router.delete('/stages/:id', canManageStages, validate({ params: stageIdParamSchema }), asyncHandler(controller.removeStage));

router.post('/', validate({ body: createRequirementSchema }), asyncHandler(controller.create));
router.get('/:id', validate({ params: requirementIdParamSchema }), asyncHandler(controller.get));
router.patch(
  '/:id',
  validate({ params: requirementIdParamSchema, body: updateRequirementSchema }),
  asyncHandler(controller.update)
);
router.patch(
  '/:id/stage',
  validate({ params: requirementIdParamSchema, body: moveStageSchema }),
  asyncHandler(controller.move)
);
router.delete('/:id', validate({ params: requirementIdParamSchema }), asyncHandler(controller.remove));

// Candidates — like the card routes, authorized in the service (edit rights on the card).
router.post(
  '/:id/candidates',
  validate({ params: requirementIdParamSchema, body: createCandidateSchema }),
  asyncHandler(controller.addCandidate)
);
router.patch(
  '/:id/candidates/:candidateId',
  validate({ params: candidateParamSchema, body: updateCandidateSchema }),
  asyncHandler(controller.updateCandidate)
);
router.delete('/:id/candidates/:candidateId', validate({ params: candidateParamSchema }), asyncHandler(controller.removeCandidate));

export default router;

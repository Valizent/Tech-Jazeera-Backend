/**
 * Deployment routes.
 *
 * Router-level `requireStaff` reaches Office Secretary too now (she moved
 * into STAFF_ROLES 2026-09-13 — see rbac.js's own doc comment); her real
 * hours-entry ability is still the hardcoded exception INSIDE
 * addMonthlyHours/updateMonthlyHours below, not a Section Access grant (same
 * pattern mobilisation.service.js's createMobilisation uses — this is a
 * per-feature business rule, unrelated to whether her login role can reach
 * this router at all).
 *
 * Roles: READ (the register/history) is Section Access key
 * 'deploymentsRelease' at the 'read' level (default mirrors write) — chosen
 * as the canonical "can view this section" key since it's the more general
 * of the two deployment keys; 'deploymentsHours' stays write-only, no
 * separate read check of its own. Office Secretary is a hardcoded exception
 * to this read gate too (same reasoning as the monthly-hours write bypass
 * below — they need to find the deployment they're about to enter hours
 * against). Monthly hours entry is gated inside the service (Office
 * Secretary, or Section Access key 'deploymentsHours' at 'write'). Deciding
 * an entered month (Approve/Reject) is a SEPARATE key, 'deploymentsHoursDecide'
 * at 'write' — deliberately not the same key as entry, so whoever enters
 * hours (Office Secretary) is never automatically who approves them; no
 * Office Secretary bypass here, gated at the route like Release below.
 * Defaults to Admin-only until an Admin grants it (e.g. to a "Marketing
 * Manager" ApprovalRole) — same "nobody but Admin until configured"
 * posture every newly-introduced Section Access key gets. Demobilise
 * (POST /:id/demobilise, formerly "Release" — the Section Access key name
 * itself, 'deploymentsRelease', is unchanged) is 'deploymentsRelease' at
 * 'write', default ['Coordinator', 'Manager'] — Office Secretary never
 * demobilises. Deployments have no CREATE route at all — they're born
 * automatically from an Approved Mobilisation (see mobilisation.service.js's
 * approveMobilisation) — EXCEPT for a TEMPORARY Admin-only DELETE added for
 * pre-production cleanup; remove it before going live (see the note on that
 * route below). PATCH /:id (2026-09-16, the user's own ask) is a real,
 * permanent edit — gated by its own new key, 'deploymentsEdit', at 'write',
 * scoped narrowly to the descriptive fields alone (see
 * deployment.validation.js's updateDeploymentSchema) — Admin-only until
 * granted; MM granted write immediately (see
 * src/scripts/grant-deployments-edit.js). GET /export (2026-09-16, the
 * user's own ask) is gated the same as the register itself
 * (`canReadDeployments`) — same filters, no pagination, downloads a .xlsx
 * instead of JSON (see deployment.export.js).
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff, requireRoles } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  listDeploymentsSchema,
  exportDeploymentsSchema,
  deploymentIdParamSchema,
  monthlyHoursEntryParamSchema,
  updateDeploymentSchema,
  addMonthlyHoursSchema,
  updateMonthlyHoursSchema,
  decideMonthlyHoursSchema,
  demobiliseDeploymentSchema,
} from './deployment.validation.js';
import * as deploymentController from './deployment.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

const canRelease = requireSectionAccess('deploymentsRelease', 'write');
const canDecideHours = requireSectionAccess('deploymentsHoursDecide', 'write');
const canReadDeploymentsGate = requireSectionAccess('deploymentsRelease', 'read');
// Office Secretary is deny-by-default for Section Access entirely (see
// canAccessSection's floor) — hardcoded through here too, same as the
// write-side bypass in deployment.service.js's addMonthlyHours.
const canReadDeployments = asyncHandler(async (req, res, next) => {
  if (req.user.role === 'Office Secretary') return next();
  return canReadDeploymentsGate(req, res, next);
});

router.get('/', canReadDeployments, validate({ query: listDeploymentsSchema }), asyncHandler(deploymentController.list));
// Before the /:id catch-all, or "standby"/"export" are read as a deployment id.
router.get('/standby', canReadDeployments, asyncHandler(deploymentController.standby));
router.get(
  '/export',
  canReadDeployments,
  validate({ query: exportDeploymentsSchema }),
  asyncHandler(deploymentController.exportAll)
);
router.get(
  '/:id',
  canReadDeployments,
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.get)
);
router.patch(
  '/:id',
  requireSectionAccess('deploymentsEdit', 'write'),
  validate({ params: deploymentIdParamSchema, body: updateDeploymentSchema }),
  asyncHandler(deploymentController.update)
);
router.post(
  '/:id/monthly-hours',
  validate({ params: deploymentIdParamSchema, body: addMonthlyHoursSchema }),
  asyncHandler(deploymentController.addMonthlyHours)
);
router.patch(
  '/:id/monthly-hours/:entryId',
  validate({ params: monthlyHoursEntryParamSchema, body: updateMonthlyHoursSchema }),
  asyncHandler(deploymentController.updateMonthlyHours)
);
router.patch(
  '/:id/monthly-hours/:entryId/decide',
  canDecideHours,
  validate({ params: monthlyHoursEntryParamSchema, body: decideMonthlyHoursSchema }),
  asyncHandler(deploymentController.decideMonthlyHours)
);
router.post(
  '/:id/demobilise',
  canRelease,
  validate({ params: deploymentIdParamSchema, body: demobiliseDeploymentSchema }),
  asyncHandler(deploymentController.demobilise)
);
// TEMPORARY — pre-production cleanup only, Admin-only hard delete. Remove
// this route (and deployment.controller.js's `remove` / deployment.
// service.js's `deleteDeployment`) before going live.
router.delete(
  '/:id',
  requireRoles('Admin'),
  validate({ params: deploymentIdParamSchema }),
  asyncHandler(deploymentController.remove)
);

export default router;

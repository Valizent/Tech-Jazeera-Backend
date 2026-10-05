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
 * demobilises. Deployments have no CREATE or DELETE route at all — they're
 * born automatically from an Approved Mobilisation (see
 * mobilisation.service.js's approveMobilisation) and are immutable history;
 * Demobilise is the real lifecycle action. PATCH /:id (2026-09-16, the
 * user's own ask) is a real,
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
import { requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import logger from '../../config/logger.js';
import {
  listDeploymentsSchema,
  exportDeploymentsSchema,
  deploymentIdParamSchema,
  monthlyHoursEntryParamSchema,
  updateDeploymentSchema,
  addMonthlyHoursSchema,
  updateMonthlyHoursSchema,
  decideMonthlyHoursSchema,
  sendInvoiceSchema,
  clientIdParamSchema,
  clientPaymentIdParamSchema,
  recordClientPaymentSchema,
  decideClientPaymentSchema,
  recordSubInvoiceSchema,
  subcontractorIdParamSchema,
  subcontractorPaymentIdParamSchema,
  recordSubcontractorPaymentSchema,
  decideSubcontractorPaymentSchema,

  demobiliseDeploymentSchema,
} from './deployment.validation.js';
import * as deploymentController from './deployment.controller.js';

const router = Router();

router.use(requireAuth);
router.use(requireStaff);

const canRelease = requireSectionAccess('deploymentsRelease', 'write');
const canDecideHours = requireSectionAccess('deploymentsHoursDecide', 'write');
const canInvoice = requireSectionAccess('deploymentsInvoicing', 'write');
const canDecidePayment = requireSectionAccess('deploymentsPaymentDecide', 'write');
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
// No canReadDeployments gate — visibility is its own rule (own mobilisations
// for a Coordinator, or 'mobilisationsViewer' for MM/Admin), computed in the
// service, same as Requirements/Daily Updates' "own work needs no grant".
router.get('/payments-due', asyncHandler(deploymentController.paymentsDue));
router.get('/paid-invoices', asyncHandler(deploymentController.paidInvoices));
// Before /:id, or a real clientId is read as a deployment id.
router.get(
  '/payments-due/:clientId',
  validate({ params: clientIdParamSchema }),
  asyncHandler(deploymentController.clientPaymentDetail)
);
// Recording is the same broad circle as entering hours (Office Secretary or
// 'deploymentsHours' write) — checked inside the service, same reasoning
// the old per-entry route never gated this one at the router level either.
router.post(
  '/payments-due/:clientId/payments',
  validate({ params: clientIdParamSchema, body: recordClientPaymentSchema }),
  asyncHandler(deploymentController.recordClientPayment)
);
router.get('/pending-payments', canDecidePayment, asyncHandler(deploymentController.pendingPaymentsQueue));
router.patch(
  '/client-payments/:paymentId/decide',
  canDecidePayment,
  validate({ params: clientPaymentIdParamSchema, body: decideClientPaymentSchema }),
  asyncHandler(deploymentController.decideClientPayment)
);
// Same reasoning — visibility (deploymentsInvoicing/mobilisationsViewer read)
// is computed in the service, not this route-level gate.
router.get('/ready-to-invoice', asyncHandler(deploymentController.readyToInvoice));
router.get('/pending-hours', asyncHandler(deploymentController.pendingHoursQueue));
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
  '/:id/monthly-hours/:entryId/send-invoice',
  canInvoice,
  uploadSingle,
  validate({ params: monthlyHoursEntryParamSchema, body: sendInvoiceSchema }),
  asyncHandler(deploymentController.sendInvoice)
);
router.get(
  '/:id/monthly-hours/:entryId/invoice-file',
  // Fixed 2026-09-29 (audit finding): this had NO gate at all — any staff
  // login could download any deployment's invoice PDF regardless of grant.
  // `canReadDeployments` is the same general "can view this section" gate
  // every other GET route on this router already uses.
  canReadDeployments,
  validate({ params: monthlyHoursEntryParamSchema }),
  asyncHandler(deploymentController.invoiceFile)
);
router.post(
  '/:id/demobilise',
  canRelease,
  validate({ params: deploymentIdParamSchema, body: demobiliseDeploymentSchema }),
  asyncHandler(deploymentController.demobilise)
);

/** Same orphaned-upload cleanup as financialRequests.routes.js/me.routes.js/
 *  document.routes.js — only the send-invoice POST above ever sets req.file
 *  on this router. */
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[deployments] orphaned invoice upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

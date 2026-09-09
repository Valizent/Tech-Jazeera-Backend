/**
 * Company settings routes. Every route beyond requireAuth is gated by the
 * controller's own dynamic Section Access check ('companySettings' key —
 * Admin, plus whoever an Admin has granted on the Section Access page).
 * Changing WHO gets that grant lives entirely on the Section Access page
 * now (Admin-only there too) — not a route in this file. Visible in the
 * nav to every staff role (dynamic eligibility can't be expressed as a
 * static per-role nav filter); a non-eligible viewer gets this page's own
 * explained 403, not a route redirect — same pattern as the Approval Log.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireStaff } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { updateCompanySettingsSchema } from './companySettings.validation.js';
import { uploadLogoImage } from './logo.upload.js';
import * as companySettingsController from './companySettings.controller.js';

const router = Router();

// Public — no requireAuth, no Section Access check. Needs to reach the
// pre-login screen and the ESS Worker portal (requireStaff below would
// otherwise exclude Workers from ever seeing their own company's branding).
// See the controller/service doc comments for why just these two fields
// are safe to expose without a permission check. This router must also be
// mounted in app.js BEFORE `app.use('/api', leaveRoutes)` — that router is
// mounted at the bare '/api' prefix with its own unconditional
// `router.use(requireAuth)`, which otherwise intercepts (and 401s) any
// '/api/*' request that falls through to it, including this one, before it
// ever reaches this module's own mount further down.
router.get('/branding', asyncHandler(companySettingsController.getBranding));

router.use(requireAuth, requireStaff);

router.get('/', asyncHandler(companySettingsController.get));
router.patch('/', validate({ body: updateCompanySettingsSchema }), asyncHandler(companySettingsController.update));
router.post('/logo', uploadLogoImage, asyncHandler(companySettingsController.uploadLogo));
router.delete('/logo', asyncHandler(companySettingsController.removeLogo));

export default router;

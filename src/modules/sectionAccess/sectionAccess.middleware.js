/**
 * requireSectionAccess — the dynamic counterpart to requireRoles(...) for a
 * module whose access circle an Admin configures at runtime (see
 * sectionAccess.model.js). The Worker/Staff floor and the Admin override
 * both live in canAccessSection itself, shared with the "mine" endpoint —
 * this middleware is just the route gate around that one check.
 *
 * `level` picks the tier: `'write'` (default) for a create/edit/decide/
 * delete route, `'read'` for a GET route that should also honor a
 * Read-only grant (write always implies read, so a write grantee never
 * needs a separate read grant too).
 */
import ApiError from '../../utils/ApiError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireStaff } from '../../middleware/rbac.js';
import { canAccessSection } from './sectionAccess.service.js';
import { SELF_SERVICE_LOGIN_ROLES } from './selfService.constants.js';

/**
 * requireStaff, plus a Worker/Staff login that holds at least Read on one of
 * `sectionKeys` (2026-10-10 — the reserved "Worker"/"Staff" approval roles, see
 * selfService.constants.js). Staff roles pass exactly as before; a self-service
 * login passes only for the modules whose key it was granted, and each route's
 * own requireSectionAccess still decides what it may actually do there.
 */
export function requireStaffOrSelfServiceGrant(...sectionKeys) {
  return asyncHandler(async (req, res, next) => {
    if (!req.user) throw new ApiError(500, 'Something went wrong. Please try again.');
    if (!SELF_SERVICE_LOGIN_ROLES.includes(req.user.role)) return requireStaff(req, res, next);
    const actor = { userId: req.user.id, role: req.user.role };
    for (const key of sectionKeys) {
      if (await canAccessSection(key, actor, 'read')) return next();
    }
    throw new ApiError(403, 'You do not have permission to perform this action.');
  });
}

export function requireSectionAccess(sectionKey, level = 'write') {
  return asyncHandler(async (req, res, next) => {
    if (!req.user) {
      // Programmer error: this ran before requireAuth. Fail loudly.
      throw new ApiError(500, 'Something went wrong. Please try again.');
    }
    const allowed = await canAccessSection(sectionKey, { userId: req.user.id, role: req.user.role }, level);
    if (!allowed) {
      throw new ApiError(403, 'You do not have permission to perform this action.');
    }
    next();
  });
}

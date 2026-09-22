/**
 * Section Access controller — HTTP translation only. Every route here is
 * Admin-only at the router level (see sectionAccess.routes.js) EXCEPT the
 * explicit `/mine` exception right below: deciding who else can open a
 * section is not itself delegable to whoever that grant creates, same
 * posture as CompanySettings.manageRoles — but reading your OWN resolved
 * access is safe for any authenticated staff-tier user (2026-09-22, a real
 * QA-audit finding — comment drift; this doc comment previously claimed
 * "every route" with no exception noted).
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as sectionAccessService from './sectionAccess.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/section-access/:sectionKey/mine — any authenticated staff-tier
 *  user, not Admin-only: lets a page decide whether to even show a gated
 *  button (e.g. "Add employee") without a wasted form fill ending in a 403. */
export async function mine(req, res) {
  const allowed = await sectionAccessService.canAccessSection(req.params.sectionKey, {
    userId: req.user.id,
    role: req.user.role,
  });
  res.json(new ApiResponse('Access check.', { allowed }));
}

/** GET /api/section-access */
export async function list(req, res) {
  const sections = await sectionAccessService.listSectionAccess();
  res.json(new ApiResponse('Section access settings.', sections));
}

/** PATCH /api/section-access/:sectionKey */
export async function update(req, res) {
  const settings = await sectionAccessService.updateSectionAccess(req.params.sectionKey, req.body, actor(req));
  res.json(new ApiResponse('Access updated.', settings));
}

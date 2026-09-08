/**
 * Company settings controller — HTTP translation only. The edit circle is
 * governed by Section Access's 'companySettings' key (Admin, plus whoever
 * an Admin has granted via the Section Access page) — dynamic, can't be a
 * static requireRoles(...), so every action checks it here itself, same
 * pattern as the Approval Log's own "Admin, or a real member" gate.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';
import * as companySettingsService from './companySettings.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

async function assertCanManage(req) {
  const allowed = await canAccessSection('companySettings', actor(req), 'write');
  if (!allowed) throw new ApiError(403, 'You do not have permission to manage company settings.');
}

async function assertCanRead(req) {
  const allowed = await canAccessSection('companySettings', actor(req), 'read');
  if (!allowed) throw new ApiError(403, 'You do not have permission to view company settings.');
}

/** GET /api/company-settings   (Section Access: companySettings, read) */
export async function get(req, res) {
  await assertCanRead(req);
  const settings = await companySettingsService.getCompanySettings();
  res.json(new ApiResponse('Company settings.', settings));
}

/** PATCH /api/company-settings   (Section Access: companySettings) */
export async function update(req, res) {
  await assertCanManage(req);
  const settings = await companySettingsService.updateCompanySettings(req.body, actor(req));
  res.json(new ApiResponse('Company settings updated.', settings));
}

/** POST /api/company-settings/logo   (Section Access: companySettings) — multipart, field `logo` */
export async function uploadLogo(req, res) {
  await assertCanManage(req);
  if (!req.file) throw new ApiError(400, 'Please attach a logo image.');
  const settings = await companySettingsService.setLogo(req.file.path, actor(req));
  res.status(201).json(new ApiResponse('Logo updated.', settings));
}

/** DELETE /api/company-settings/logo   (Section Access: companySettings) */
export async function removeLogo(req, res) {
  await assertCanManage(req);
  const settings = await companySettingsService.removeLogo(actor(req));
  res.json(new ApiResponse('Logo removed.', settings));
}

/**
 * Zod schemas for Section Access. `allowedRoles` is validated against
 * GRANTABLE_ROLES (every User.role except Worker/Staff) — the same floor
 * requireSectionAccess enforces at request time, kept in one place.
 */
import { z } from 'zod';
import { SECTION_KEYS, GRANTABLE_ROLES } from './sectionAccess.model.js';

const approvalRoleId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid role id.');

export const sectionKeyParamSchema = z.object({
  sectionKey: z.enum(SECTION_KEYS),
});

export const updateSectionAccessSchema = z.object({
  readRoles: z.array(z.enum(GRANTABLE_ROLES)).max(GRANTABLE_ROLES.length),
  readApprovalRoles: z.array(approvalRoleId).max(50),
  writeRoles: z.array(z.enum(GRANTABLE_ROLES)).max(GRANTABLE_ROLES.length),
  writeApprovalRoles: z.array(approvalRoleId).max(50),
});

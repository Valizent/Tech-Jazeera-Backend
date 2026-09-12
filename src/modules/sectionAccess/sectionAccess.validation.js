/**
 * Zod schemas for Section Access. Approval Roles are the only grant type —
 * `readApprovalRoles`/`writeApprovalRoles` are validated as ObjectIds here;
 * whether each id is a real, active ApprovalRole is checked in the service
 * (`assertValidApprovalRoles`), which needs a DB lookup Zod can't do.
 */
import { z } from 'zod';
import { SECTION_KEYS } from './sectionAccess.model.js';

const approvalRoleId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid role id.');

export const sectionKeyParamSchema = z.object({
  sectionKey: z.enum(SECTION_KEYS),
});

export const updateSectionAccessSchema = z.object({
  readApprovalRoles: z.array(approvalRoleId).max(50),
  writeApprovalRoles: z.array(approvalRoleId).max(50),
});

/**
 * SectionAccess — the generic "who else can open this section" mechanism,
 * one document per section key. Extracted from the same pattern
 * CompanySettings.manageRoles and MobilisationSettings.viewerRoles each
 * built independently for their own one module — this is that pattern made
 * reusable, so a THIRD module (Payroll/Expenses, and any future one) doesn't
 * grow its own bespoke copy again.
 *
 * `allowedRoles` are literal User.role values (e.g. 'Accounts') — for a
 * grant tied to the fixed login-role enum. `allowedApprovalRoles` are
 * ApprovalRole ids (e.g. an admin-named "Financial Manager" or "COO" role) —
 * for a grant tied to a real person regardless of their login role, the same
 * indirection Company Settings/Mobilisation Settings already use. A section
 * with no document yet (nobody has configured it) falls back to a
 * hardcoded per-section default in sectionAccess.service.js — never an empty
 * "nobody but Admin" surprise for a section that already had a sensible
 * owner before this system existed.
 */
import mongoose from 'mongoose';
import { ROLES } from '../auth/user.model.js';

/** Every section this mechanism currently governs. Add a key here (and a
 *  default in sectionAccess.service.js) to bring a new page under
 *  admin-configurable access without touching this model again. */
export const SECTION_KEYS = [
  'payroll',
  'expenses',
  'employeeCreate',
  'companySettings',
  'mobilisationsViewer',
  'mobilisationsSelfMobilise',
  'invoices',
  'eosb',
  'financialRequests',
  'auditLog',
  'timesheetProcessor',
  'nfc',
  'clientsManage',
  'deploymentsHours',
  'deploymentsRelease',
  'subcontractorsManage',
  'attendanceManage',
  'documentsManage',
  'assetsManage',
  'quotationsManage',
  'ramadanManage',
  'team',
  'approvalHierarchy',
  'leaveRequests',
  'timesheetRequests',
  'exitDocuments',
];

/** Worker/Staff (the ESS self-service personas) are never grantable here —
 *  same floor requireStaff/requireStaffOrExecutive enforce everywhere else.
 *  This system only ever ADDS access on top of that floor. Office Secretary
 *  is excluded too, deliberately: unlike every other role here, it's
 *  designed to reach things ONLY via ApprovalRole membership on a specific
 *  workflow step (see requireStaffOrOfficeSecretary's own doc comment),
 *  never a blanket per-section grant — canAccessSection's own floor check
 *  (STAFF_ROLES) already excludes it, so allowing it here would just be a
 *  silently-broken option in the UI (picking it saves fine, grants nothing). */
export const GRANTABLE_ROLES = ROLES.filter((role) => !['Worker', 'Staff', 'Office Secretary'].includes(role));

const sectionAccessSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, enum: SECTION_KEYS, required: true, unique: true },
    allowedRoles: { type: [{ type: String, enum: GRANTABLE_ROLES }], default: [] },
    allowedApprovalRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('SectionAccess', sectionAccessSchema);

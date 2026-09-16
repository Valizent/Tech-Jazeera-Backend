/**
 * SectionAccess — the generic "who else can open this section" mechanism,
 * one document per section key, with TWO independent tiers: Read (can view)
 * and Write (can create/edit/decide/delete — and always implies Read, so a
 * Write grantee never needs to be listed twice). Extracted from the same
 * pattern CompanySettings.manageRoles and MobilisationSettings.viewerRoles
 * each built independently for their own one module — this is that pattern
 * made reusable, so a THIRD module (Payroll/Expenses, and any future one)
 * doesn't grow its own bespoke copy again.
 *
 * `writeApprovalRoles`/`readApprovalRoles` are `ApprovalRole` ids (e.g. an
 * admin-named "Financial Manager" or "COO" role) — a grant tied to a real
 * person regardless of their login role, the same indirection Company
 * Settings/Mobilisation Settings already use. This used to also support a
 * second grant type tied directly to the fixed login-role enum
 * (`readRoles`/`writeRoles`); the user asked to drop that entirely so
 * Approval Roles are the only way anything is granted here — see
 * docs/SECTION-ACCESS-notes.md's 2026-09-13 follow-up and
 * src/scripts/migrate-section-access-approval-roles.js, which converted every
 * section's pre-existing login-role grant into a matching Approval Role
 * before this field was removed. A section with no document yet (nobody has
 * configured it) has an empty grant — Admin-only until an Admin grants an
 * Approval Role — see sectionAccess.service.js's `defaultFor`.
 *
 * Not every section has a real "write" action tied to this key (e.g.
 * `mobilisationsViewer` is pure-read by design — Mobilisation's actual write
 * path is the separate `mobilisationsSelfMobilise` key; `team`'s real write
 * is a permanently hardcoded Admin-only rail, not this key at all) — for
 * those, `writeApprovalRoles` simply stays empty and nothing ever checks it.
 * See sectionAccess.service.js's canAccessSection for how the two tiers are
 * checked, and docs/SECTION-ACCESS-notes.md for the per-section
 * categorization behind the migration that introduced this.
 */
import mongoose from 'mongoose';

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
  'deploymentsHoursDecide',
  'deploymentsRelease',
  'subcontractorsManage',
  'attendanceRecords',
  'attendanceSignInOut',
  'attendanceOfficeLocation',
  'documentsManage',
  'assetsManage',
  'quotationsManage',
  'ramadanManage',
  'team',
  'approvalHierarchy',
  'leaveRequests',
  'timesheetRequests',
  'exitDocuments',
  'holidays',
  // Added 2026-09-15, the user's own ask (a Coordinator/Manager/HR
  // cost-and-profit view): gates the Dashboard's company-wide profit
  // figure (Revenue from invoices − Payroll cost − Expenses) on its OWN
  // key, independent from needing raw read access to Invoices/Payroll/
  // Expenses individually — same "a derived figure gets its own narrower
  // authorization, decoupled from the raw underlying fields' own access
  // grants" precedent Mobilisation/Deployment's own `profit` field already
  // follows. Before this, the widget required read on all three of those
  // sections at once — correct for data-integrity (never show a partial
  // figure) but meant seeing one aggregate number required exposure to
  // every individual invoice/payroll run/expense line. See
  // dashboard.service.js's getDashboard.
  'dashboardProfit',
  // Added 2026-09-15, the QA audit's own suggestion #6 ("add reconciliation
  // checks for ledger totals, finalized payroll, and deployments missing
  // from approved mobilisations") — a read-only oversight report, same
  // shape as 'auditLog': no write action, Admin-only until granted. See
  // reconciliation.service.js.
  'reconciliation',
];

const sectionAccessSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, enum: SECTION_KEYS, required: true, unique: true },
    readApprovalRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
    writeApprovalRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('SectionAccess', sectionAccessSchema);

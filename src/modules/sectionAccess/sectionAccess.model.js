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

  'expenses',
  'employeeCreate',
  'companySettings',
  'mobilisationsViewer',
  'mobilisationsSelfMobilise',
  'eosb',
  'financialRequests',
  'auditLog',
  'timesheetProcessor',
  'nfc',
  'clientsManage',
  'deploymentsHours',
  'deploymentsHoursDecide',
  'deploymentsInvoicing',
  'deploymentsPaymentDecide',
  'deploymentsRelease',
  'deploymentsEdit',
  'subcontractorsManage',
  'attendanceRecords',
  'attendanceSignInOut',
  'attendanceOfficeLocation',
  'documentsManage',
  'assetsManage',
  'ramadanManage',
  'team',
  'approvalHierarchy',
  'leaveRequests',
  'timesheetRequests',
  'exitDocuments',
  // Added 2026-10-10 — Annual Vacation: Read = the staff review queue; Write = file a
  // request for another employee and decide requests. An employee's own requests
  // need no grant (ESS, or a staff login with a linked employee).
  'annualVacation',
  'holidays',
  // Added 2026-09-15, the user's own ask (a Coordinator/Manager/HR
  // cost-and-profit view): gates the Dashboard's real "Actual Performance"
  // profit figure (verified client payments − Expenses, see
  // deployment.service.js's getActualPerformanceSummary) on its OWN key,
  // independent from needing raw read access to Payroll/Expenses
  // individually — same "a derived figure gets its own narrower
  // authorization, decoupled from the raw underlying fields' own access
  // grants" precedent Mobilisation/Deployment's own `profit` field already
  // follows. See dashboard.service.js's getDashboard.
  'dashboardProfit',
  // Added 2026-09-15, the QA audit's own suggestion #6 ("add reconciliation
  // checks for ledger totals, finalized payroll, and deployments missing
  // from approved mobilisations") — a read-only oversight report, same
  // shape as 'auditLog': no write action, Admin-only until granted. See
  // reconciliation.service.js.
  'reconciliation',
  // Added 2026-09-20 — the Daily Updates module (a coordinator's day-to-day
  // log and to-do list). Two keys because there are two genuinely different
  // circles: `dailyUpdatesOwn` is a coordinator's own workspace (Read: see
  // their own; Write: add/edit their own and tick off what's assigned to
  // them), `dailyUpdatesTeam` is oversight of everyone (Read: see every
  // coordinator's; Write: assign tasks to any coordinator, edit/delete/tick
  // anyone's). See dailyUpdate.service.js for how the two combine.
  'dailyUpdatesOwn',
  'dailyUpdatesTeam',
  // Added 2026-09-20 — the pre-mobilisation Requirements board (milestone 2 of
  // the Coordinator Workflow). Same own/team pair as Daily Updates:
  // `requirementsOwn` (Read: see the requirements I'm a coordinator on; Write:
  // add requirements as myself, edit/move/delete my own, add updates to my
  // cards) and `requirementsTeam` (Read: see every requirement; Write: assign
  // any coordinators, edit/move/delete anyone's; members are also who gets
  // notified when a card reaches a "notify" stage). `requirementStages` is a
  // Write-only key — who may add/rename/reorder/delete the board's stages;
  // Admin only until granted, per "admin editable". Reading the stages needs
  // no key of its own: they arrive with the board itself.
  'requirementsOwn',
  'requirementsTeam',
  'requirementStages',
  // Added 2026-09-21 — Mobilisation Targets: who may set/edit/remove a
  // monthly mobilisation-count target (and its incentive %) for a
  // coordinator. A coordinator's own read of their own target is always
  // allowed (ungated); this key governs the write path (set/edit/remove)
  // AND the management overview (all coordinators' progress).
  'mobilisationTargets',
  // Added 2026-10-12 - who is reminded when a client or subcontractor is
  // still missing company details (see notifications/companyDetails.job.js).
  // Recipient lists, not permissions: the members of the roles ticked under
  // Write are notified (BDM at day 40, Marketing Manager from day 45).
  'companyDetailsBdm',
  'companyDetailsManager',
  // Added 2026-10-13 - the Employees section's own permissions (the user's
  // Section Access redesign, milestone 1). `employeeCreate` stays the "view
  // the directory (Read) / add an employee (Write)" key; these three split
  // out the rest so each can be given to a different circle:
  //   employeeEdit      Write = change an existing employee. Until an Admin
  //                     configures it, it follows `employeeCreate`'s Write
  //                     circle (see FALLBACK_KEY in sectionAccess.service.js).
  //   employeeDelete    Write = delete an employee. Admin only until granted.
  //   employeeFinancial Read  = see salary and the WPS pay breakdown. Admin
  //                     only until granted; the server removes those fields
  //                     from every employee response for anyone else.
  'employeeEdit',
  'employeeDelete',
  'employeeFinancial',
  // Added 2026-10-13 (milestone 2) - the "my own" half of two sections whose
  // single Write used to mean both "file my own request" and "decide everyone's":
  //   leaveApply     Write = file your own leave request. Until configured it
  //                  follows `leaveRequests` Write, so nobody loses it.
  //   timesheetOwn   Read  = see your own monthly timesheet (without seeing
  //                  everyone's). Until configured it follows `timesheetRequests`.
  'leaveApply',
  'timesheetOwn',
  // Added 2026-10-24 - in-app chat moderation. Chat itself needs no grant (every office
  // staff login and Executive can chat); this single-tier key (Write) chooses who may
  // review messages that members reported and remove them. Nobody reads conversations
  // through it. Admin only until granted.
  'chatModeration',
];

const sectionAccessSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, enum: SECTION_KEYS, required: true, unique: true },
    readApprovalRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
    writeApprovalRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
    // "All office staff" (2026-10-13): every Admin/Manager/HR/Accounts/Coordinator/
    // Executive/Office Secretary login, without listing them in an Approval Role.
    // Never Worker or Staff logins, and never beyond what that section's own
    // safe list allows. One switch per tier, same tiers as the role lists above.
    readAllStaff: { type: Boolean, default: false },
    writeAllStaff: { type: Boolean, default: false },
    // "...except these": members of any of these approval roles are NOT
    // covered by either All-office-staff switch above (e.g. everyone files
    // leave except MM, FM, COO and GM). Does not remove a person who is also
    // named in a role grant of the same section; that grant still applies.
    allStaffExceptRoles: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRole' }], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('SectionAccess', sectionAccessSchema);

/**
 * One-time migration: Section Access no longer grants by literal login role
 * at all (`readRoles`/`writeRoles` were removed from the schema) — Approval
 * Roles are now the only grant type, per the user's own instruction. This
 * script converts every section's existing login-role grant into an
 * equivalent Approval Role grant, so nobody who had access yesterday loses
 * it the moment this ships.
 *
 * For each of the 5 login roles that ever appeared in a default or
 * admin-configured grant (Manager, HR, Accounts, Coordinator, Executive —
 * 'Admin' is skipped: Admin already bypasses Section Access entirely,
 * regardless of any grant, so an 'Admin' entry in an old readRoles/writeRoles
 * list was always inert), this script finds-or-creates an ApprovalRole of
 * that exact name and makes sure every user currently holding that login
 * role is a member of it (additive only — never removes an existing member
 * who doesn't hold that login role, in case an Admin already put someone
 * else in deliberately for an unrelated org-chart reason). In this
 * company's real data, ApprovalRoles named "HR" and "Coordinator" already
 * existed (part of the real approval hierarchy) and already had exactly the
 * matching members — those are reused as-is; "Manager"/"Accounts"/
 * "Executive" are newly created.
 *
 * Then, for every SECTION_KEYS entry:
 *  - If a SectionAccess document already exists, its own readRoles/
 *    writeRoles (even if empty — an Admin may have deliberately narrowed a
 *    section to nobody-but-Admin already, and that deliberate choice must
 *    not be overridden) are converted and merged (via $addToSet, never
 *    overwritten) into readApprovalRoles/writeApprovalRoles, and the old
 *    fields are unset.
 *  - If no document exists at all, it was still relying on the hardcoded
 *    JS defaults this same change deleted from sectionAccess.service.js —
 *    FORMER_DEFAULTS below is a frozen snapshot of exactly what those
 *    defaults used to be, so a document is created from that snapshot
 *    instead of silently reverting to Admin-only.
 *
 * Uses raw collection access for `sectionaccesses` (the old field names no
 * longer exist in the current schema), same convention as
 * migrate-section-access-tiers.js.
 *
 * Usage:  node src/scripts/migrate-section-access-approval-roles.js
 *    or:  npm run migrate:section-access-approval-roles
 *
 * Idempotent: re-running finds every relevant ApprovalRole/member already in
 * place and every old field already absent, and reports 0 changes.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import User from '../modules/auth/user.model.js';
import ApprovalRole from '../modules/approvals/approvalRole.model.js';

// Every login role that ever appeared in a Section Access default or
// admin-configured grant, excluding 'Admin' (always inert here — Admin
// bypasses Section Access entirely regardless of any grant).
const MIGRATABLE_ROLES = ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'];

// Frozen snapshot of DEFAULT_READ_ROLES/DEFAULT_WRITE_ROLES as they stood in
// sectionAccess.service.js immediately before this migration deleted them —
// only for the sections that had NO SectionAccess document yet at migration
// time (still relying on those JS defaults). Sections with a real document
// use that document's own readRoles/writeRoles instead, further down.
const FORMER_DEFAULTS = {
  eosb: { read: ['Manager', 'HR', 'Accounts'], write: ['Manager', 'HR', 'Accounts'] },
  deploymentsRelease: { read: ['Coordinator', 'Manager'], write: ['Coordinator', 'Manager'] },
  subcontractorsManage: { read: ['Manager'], write: ['Manager'] },
  attendanceManage: { read: ['Manager', 'HR'], write: ['Manager', 'HR'] },
  quotationsManage: { read: ['Manager', 'Accounts'], write: ['Manager', 'Accounts'] },
  ramadanManage: { read: ['Manager', 'HR'], write: ['Manager', 'HR'] },
  timesheetRequests: {
    read: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
    write: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
  },
  exitDocuments: {
    read: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
    write: ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive'],
  },
};

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
const sectionAccessCollection = mongoose.connection.collection('sectionaccesses');

// --- Step 1: find-or-create one ApprovalRole per migratable login role,
// and make sure it contains every current user with that login role. ---
console.log('--- Ensuring an Approval Role exists per login role ---');
const roleIdByName = new Map();
for (const roleName of MIGRATABLE_ROLES) {
  const usersWithRole = await User.find({ role: roleName }).select('_id name').lean();
  let approvalRole = await ApprovalRole.findOne({ name: roleName });
  if (!approvalRole) {
    approvalRole = await ApprovalRole.create({
      name: roleName,
      description: `Auto-created during the Section Access login-role migration — every login with role "${roleName}".`,
      members: usersWithRole.map((u) => u._id),
    });
    console.log(`  + created "${roleName}" with ${usersWithRole.length} member(s): ${usersWithRole.map((u) => u.name).join(', ') || '(none)'}`);
  } else {
    const existingMemberIds = new Set(approvalRole.members.map(String));
    const missing = usersWithRole.filter((u) => !existingMemberIds.has(String(u._id)));
    if (missing.length > 0) {
      approvalRole.members.push(...missing.map((u) => u._id));
      await approvalRole.save();
      console.log(`  ~ reused existing "${roleName}", added ${missing.length} missing member(s): ${missing.map((u) => u.name).join(', ')}`);
    } else {
      console.log(`  = reused existing "${roleName}" — already has every ${roleName} login (${usersWithRole.length}).`);
    }
  }
  roleIdByName.set(roleName, approvalRole._id);
}

// --- Step 2: convert every section's login-role grant into the matching
// approval-role ids, merging into readApprovalRoles/writeApprovalRoles. ---
console.log('\n--- Migrating Section Access grants ---');
const SECTION_KEYS = [
  'payroll', 'expenses', 'employeeCreate', 'companySettings', 'mobilisationsViewer',
  'mobilisationsSelfMobilise', 'invoices', 'eosb', 'financialRequests', 'auditLog',
  'timesheetProcessor', 'nfc', 'clientsManage', 'deploymentsHours', 'deploymentsHoursDecide',
  'deploymentsRelease', 'subcontractorsManage', 'attendanceManage', 'documentsManage',
  'assetsManage', 'quotationsManage', 'ramadanManage', 'team', 'approvalHierarchy',
  'leaveRequests', 'timesheetRequests', 'exitDocuments',
];

const toApprovalRoleIds = (loginRoles) =>
  (loginRoles ?? [])
    .filter((r) => r !== 'Admin')
    .map((r) => roleIdByName.get(r))
    .filter(Boolean);

let migratedCount = 0;
let skippedCount = 0;
for (const sectionKey of SECTION_KEYS) {
  const doc = await sectionAccessCollection.findOne({ sectionKey });

  let readIds, writeIds;
  if (doc) {
    readIds = toApprovalRoleIds(doc.readRoles);
    writeIds = toApprovalRoleIds(doc.writeRoles);
    if (!doc.readRoles && !doc.writeRoles) {
      // Already on the new shape (re-run, or never had the old fields) — nothing to do.
      skippedCount += 1;
      continue;
    }
  } else if (FORMER_DEFAULTS[sectionKey]) {
    readIds = toApprovalRoleIds(FORMER_DEFAULTS[sectionKey].read);
    writeIds = toApprovalRoleIds(FORMER_DEFAULTS[sectionKey].write);
  } else {
    // No document, and no former default (e.g. employeeCreate,
    // deploymentsHours, deploymentsHoursDecide) — was already Admin-only.
    skippedCount += 1;
    continue;
  }

  await sectionAccessCollection.updateOne(
    { sectionKey },
    {
      $set: { sectionKey },
      $addToSet: {
        readApprovalRoles: { $each: readIds },
        writeApprovalRoles: { $each: writeIds },
      },
      $unset: { readRoles: '', writeRoles: '' },
    },
    { upsert: true }
  );
  migratedCount += 1;
  console.log(`  ✓ ${sectionKey}: +${readIds.length} read role(s), +${writeIds.length} write role(s)`);
}

console.log(`\n✓ Migrated ${migratedCount} section(s), ${skippedCount} already up to date / already Admin-only.`);
await mongoose.connection.close();

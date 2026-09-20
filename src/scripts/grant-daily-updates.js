/**
 * One-time setup for the Daily Updates module (2026-09-20), the user's own
 * instruction — coordinators keep their own day-to-day log and to-dos, and MM
 * can see (and assign tasks to) every coordinator:
 *
 *   - "Coordinator" ApprovalRole → WRITE on 'dailyUpdatesOwn'
 *       (their own workspace: add/edit their own entries, tick off assigned tasks)
 *   - "MM" ApprovalRole          → WRITE on 'dailyUpdatesTeam'
 *       (see every coordinator's log/tasks AND assign tasks — write implies read)
 *
 * Both are ordinary Section Access grants: an Admin can widen or narrow them
 * any time from the Section Access page (e.g. drop MM to Read-only to make it
 * view-only, or add BDM/COO/GM later).
 *
 * Additive and idempotent: merges into whatever grant already exists for each
 * key (never removes one), safe to re-run. Must be run once per database
 * (dev, staging, production) — the grants live in that database's own
 * SectionAccess collection.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import ApprovalRole from '../modules/approvals/approvalRole.model.js';
import User from '../modules/auth/user.model.js';
import { updateSectionAccess, getSectionAccess } from '../modules/sectionAccess/sectionAccess.service.js';

const GRANTS = [
  { roleName: 'Coordinator', sectionKey: 'dailyUpdatesOwn' },
  { roleName: 'MM', sectionKey: 'dailyUpdatesTeam' },
];

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const admin = await User.findOne({ role: 'Admin' }).select('_id name email').lean();
if (!admin) throw new Error('No real Admin user found — refusing to guess an actor for the audit log.');
const actor = { userId: admin._id.toString(), ip: '127.0.0.1' };

for (const { roleName, sectionKey } of GRANTS) {
  const role = await ApprovalRole.findOne({ name: roleName, isActive: true }).select('_id name').lean();
  if (!role) throw new Error(`ApprovalRole "${roleName}" not found (or inactive) — nothing granted for ${sectionKey}.`);

  const current = await getSectionAccess(sectionKey);
  const writeIds = new Set(current.writeApprovalRoles.map((id) => id.toString()));
  writeIds.add(role._id.toString());

  const updated = await updateSectionAccess(
    sectionKey,
    {
      readApprovalRoles: current.readApprovalRoles.map((id) => id.toString()),
      writeApprovalRoles: [...writeIds],
    },
    actor
  );
  console.log(`✓ ${sectionKey}: writeApprovalRoles now has ${updated.writeApprovalRoles.length} role(s) — granted ${role.name}`);
}

console.log(`Attributed to Admin: ${admin.name} <${admin.email}>`);
await mongoose.connection.close();

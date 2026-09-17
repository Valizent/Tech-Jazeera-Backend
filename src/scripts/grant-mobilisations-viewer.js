/**
 * One-time setup: grants the real "MM" (Marketing Manager) ApprovalRole
 * read access on the 'mobilisationsViewer' Section Access key (2026-09-17,
 * the user's own explicit instruction — a Manager could see a Deployment
 * (deploymentsRelease read, granted by default) but its "View mobilisation"
 * link 403'd, since mobilisationsViewer is a separate key with no default
 * grant). mobilisationsViewer is pure-read by design (see sectionAccess.
 * model.js's own doc comment) — there's no write tier to also grant.
 *
 * Additive and idempotent: merges into whatever readApprovalRoles already
 * exists for this key (never removes an existing grant), safe to re-run.
 * Same shape as grant-deployments-edit.js, just the read tier instead of
 * write (mobilisationsViewer has no write action of its own to grant).
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import ApprovalRole from '../modules/approvals/approvalRole.model.js';
import User from '../modules/auth/user.model.js';
import { updateSectionAccess, getSectionAccess } from '../modules/sectionAccess/sectionAccess.service.js';

const TARGET_ROLE_NAME = 'MM';
const TARGET_KEY = 'mobilisationsViewer';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const admin = await User.findOne({ role: 'Admin' }).select('_id name email').lean();
if (!admin) throw new Error('No real Admin user found — refusing to guess an actor for the audit log.');
const actor = { userId: admin._id.toString(), ip: '127.0.0.1' };

const role = await ApprovalRole.findOne({ name: TARGET_ROLE_NAME, isActive: true }).select('_id name').lean();
if (!role) throw new Error(`ApprovalRole "${TARGET_ROLE_NAME}" not found (or inactive) — nothing granted.`);

const current = await getSectionAccess(TARGET_KEY);
const existingReadIds = new Set(current.readApprovalRoles.map((id) => id.toString()));
existingReadIds.add(role._id.toString());

const updated = await updateSectionAccess(
  TARGET_KEY,
  {
    readApprovalRoles: [...existingReadIds],
    writeApprovalRoles: current.writeApprovalRoles.map((id) => id.toString()),
  },
  actor
);

console.log(`✓ ${TARGET_KEY}: readApprovalRoles now has ${updated.readApprovalRoles.length} role(s)`);
console.log(`  Granted: ${role.name}`);
console.log(`Attributed to Admin: ${admin.name} <${admin.email}>`);
await mongoose.connection.close();

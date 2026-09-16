/**
 * One-time setup: grants the real "MM" (Marketing Manager) ApprovalRole
 * write access on the new 'deploymentsEdit' Section Access key (2026-09-16,
 * the user's own explicit instruction — "give MM the write and read access
 * now"). Write already implies Read (see sectionAccess.service.js's
 * canAccessSection), so this is the whole grant — same convention every
 * other write grant in this app already follows (e.g.
 * 'mobilisationsSelfMobilise' grants MM write only, no redundant read entry).
 *
 * Additive and idempotent: merges into whatever writeApprovalRoles already
 * exists for this key (never removes an existing grant), safe to re-run.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import ApprovalRole from '../modules/approvals/approvalRole.model.js';
import User from '../modules/auth/user.model.js';
import { updateSectionAccess, getSectionAccess } from '../modules/sectionAccess/sectionAccess.service.js';

const TARGET_ROLE_NAME = 'MM';
const TARGET_KEY = 'deploymentsEdit';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const admin = await User.findOne({ role: 'Admin' }).select('_id name email').lean();
if (!admin) throw new Error('No real Admin user found — refusing to guess an actor for the audit log.');
const actor = { userId: admin._id.toString(), ip: '127.0.0.1' };

const role = await ApprovalRole.findOne({ name: TARGET_ROLE_NAME, isActive: true }).select('_id name').lean();
if (!role) throw new Error(`ApprovalRole "${TARGET_ROLE_NAME}" not found (or inactive) — nothing granted.`);

const current = await getSectionAccess(TARGET_KEY);
const existingWriteIds = new Set(current.writeApprovalRoles.map((id) => id.toString()));
existingWriteIds.add(role._id.toString());

const updated = await updateSectionAccess(
  TARGET_KEY,
  {
    readApprovalRoles: current.readApprovalRoles.map((id) => id.toString()),
    writeApprovalRoles: [...existingWriteIds],
  },
  actor
);

console.log(`✓ ${TARGET_KEY}: writeApprovalRoles now has ${updated.writeApprovalRoles.length} role(s)`);
console.log(`  Granted: ${role.name}`);
console.log(`Attributed to Admin: ${admin.name} <${admin.email}>`);
await mongoose.connection.close();

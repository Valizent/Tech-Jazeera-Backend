/**
 * One-time setup: grants Coordinator/Manager/HR real, operational
 * cost-and-profit visibility — the user's own ask, 2026-09-15, following
 * the QA audit's "workforce/payroll eligibility" suggestion (the user
 * redirected it: don't fix Payroll inclusion, just give these three roles
 * a cost/profit view — "Both" per-placement and company-wide, per their
 * own choice).
 *
 * No login-role-shaped ApprovalRole stand-ins are created here — the user
 * explicitly rejected that pattern earlier in this project's history (see
 * docs/SECTION-ACCESS-notes.md's 2026-09-13 follow-up: the migration's own
 * auto-created "Manager"/"Accounts"/"Executive" roles were deleted outright
 * once spotted). Instead this grants the company's REAL, pre-existing
 * org-chart ApprovalRoles that already 1:1 cover "Coordinator, Manager, HR"
 * as login-role categories: 'Coordinator' and 'HR' map directly; there is
 * no single 'Manager' ApprovalRole because this company's real org chart
 * splits every Manager-login user across 5 distinct real titles — GM, COO,
 * MM (Marketing Manager), FM (Financial Manager), BDM — so all five are
 * granted to cover every real Manager-login user.
 *
 * Grants READ ONLY (visibility, not decide/write power) on:
 *  - 'mobilisationsViewer' — already a pure-read key; grants full
 *    Mobilisation visibility including profitPerHour/profitPerMonth.
 *  - 'deploymentsHoursDecide' — its 3 profit-visibility checks were widened
 *    2026-09-15 to accept the Read tier (previously Write-only, which would
 *    have also handed out decide/approve power just to see the number).
 *  - 'dashboardProfit' — new key (2026-09-15) gating the Dashboard's
 *    company-wide profit widget on its own, decoupled from needing raw
 *    read on Invoices/Payroll/Expenses individually.
 *
 * Additive and idempotent: merges into whatever readApprovalRoles already
 * exists for each key (never removes an existing grant), safe to re-run.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import ApprovalRole from '../modules/approvals/approvalRole.model.js';
import User from '../modules/auth/user.model.js';
import { updateSectionAccess, getSectionAccess } from '../modules/sectionAccess/sectionAccess.service.js';

const TARGET_ROLE_NAMES = ['Coordinator', 'HR', 'GM', 'COO', 'MM', 'FM', 'BDM'];
const TARGET_KEYS = ['mobilisationsViewer', 'deploymentsHoursDecide', 'dashboardProfit'];

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const admin = await User.findOne({ role: 'Admin' }).select('_id name email').lean();
if (!admin) throw new Error('No real Admin user found — refusing to guess an actor for the audit log.');
const actor = { userId: admin._id.toString(), ip: '127.0.0.1' };

const roles = await ApprovalRole.find({ name: { $in: TARGET_ROLE_NAMES }, isActive: true }).select('_id name').lean();
console.log(`Found ${roles.length}/${TARGET_ROLE_NAMES.length} target roles:`, roles.map((r) => r.name).join(', '));
const missing = TARGET_ROLE_NAMES.filter((n) => !roles.some((r) => r.name === n));
if (missing.length) console.log('MISSING (not granted — role does not exist or is inactive):', missing.join(', '));
const roleIds = roles.map((r) => r._id);

for (const key of TARGET_KEYS) {
  const current = await getSectionAccess(key);
  const existingReadIds = new Set(current.readApprovalRoles.map((id) => id.toString()));
  for (const id of roleIds) existingReadIds.add(id.toString());
  const updated = await updateSectionAccess(
    key,
    {
      readApprovalRoles: [...existingReadIds],
      writeApprovalRoles: current.writeApprovalRoles.map((id) => id.toString()),
    },
    actor
  );
  console.log(`✓ ${key}: readApprovalRoles now has ${updated.readApprovalRoles.length} role(s)`);
}

console.log(`\nDone. Attributed to Admin: ${admin.name} <${admin.email}>`);
await mongoose.connection.close();

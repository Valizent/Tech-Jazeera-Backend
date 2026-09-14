/**
 * Seed / reset the Admin account. A brand-new database has no users, and
 * there is no self-registration — this script bootstraps (or re-keys) the
 * first Admin so someone can log in and run the company.
 *
 * Usage:  node src/scripts/seed-admin.js <email> <password> [name] [--confirm]
 *    or:  npm run seed:admin -- <email> <password> [name] [--confirm]
 *
 * Running it again with the same email UPDATES that admin's password/name —
 * which doubles as the password-reset procedure for Phase 1.
 *
 * SAFETY: if <email> already belongs to a non-Admin user, the script refuses
 * to touch it unless --confirm is also passed. Without this, a typo'd email
 * during ordinary use (this is the exact script run constantly for throwaway
 * test admins) would silently promote a real Worker/Staff login to Admin and
 * reset their password, with no warning at all.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import User from '../modules/auth/user.model.js';
import { hashPassword } from '../modules/auth/auth.service.js';

// --confirm is a flag, not a positional argument — filtered out before
// destructuring, or `npm run seed:admin -- a@b.com pass --confirm` (no name
// given) would assign it to `name` instead of being recognized as the flag.
const rawArgs = process.argv.slice(2);
const confirmed = rawArgs.includes('--confirm');
const [email, password, name = 'Administrator'] = rawArgs.filter((a) => a !== '--confirm');

// Basic guards — this is an operator tool, so errors must be self-explanatory.
if (!email || !password) {
  console.error('Usage: npm run seed:admin -- <email> <password> [name]');
  process.exit(1);
}
if (!/^\S+@\S+\.\S+$/.test(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const existing = await User.findOne({ email: email.toLowerCase() });
if (existing && existing.role !== 'Admin' && !confirmed) {
  console.error(
    `"${email}" already exists as role "${existing.role}". This would overwrite them as ` +
      'Admin and reset their password. Re-run with --confirm if that is really what you want.'
  );
  await mongoose.connection.close();
  process.exit(1);
}

const passwordHash = await hashPassword(password);
const admin = await User.findOneAndUpdate(
  { email: email.toLowerCase() },
  { name, email: email.toLowerCase(), passwordHash, role: 'Admin', isActive: true, passwordChangedAt: new Date() },
  { new: true, upsert: true } // create if missing, update if present
);

console.log(`✓ Admin ready: ${admin.email} (${admin.name})`);
console.log('  You can now log in via POST /api/auth/login.');
await mongoose.connection.close();

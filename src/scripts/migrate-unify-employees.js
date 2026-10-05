/**
 * One-time migration: unify Employee and staff-login accounts.
 *
 *   1. Every pre-existing Employee record defaults to type: 'Client' — that's
 *      what the collection has always represented. Anything that's actually
 *      internal staff (flagged in the log below) needs a manual recategorize
 *      to 'Own' afterward via the edit form — this can't be inferred safely.
 *   2. Every non-Admin User with no linked Employee (today: every Manager/
 *      HR/Accounts/Coordinator login) gets a new type: 'Own' Employee, with
 *      an auto-generated employeeId (STAFF-001, STAFF-002, ...), fullName
 *      from the login's name, designation defaulted to their role, and
 *      joiningDate from the login's own createdAt (a real fact, reused as a
 *      proxy — not invented). nationality/mobile/salary are left unset,
 *      which is safe now that they're required only for type: 'Client'.
 *   3. A Coordinator's old `managedBy` (read from the raw collection — it's
 *      no longer in the User schema) is copied onto their new Employee's
 *      `manager` field, then `managedBy` is unset from every User document.
 *
 * Usage:  node src/scripts/migrate-unify-employees.js
 *    or:  npm run migrate:unify-employees
 *
 * Idempotent: re-running only touches Employee docs still missing `type`,
 * and Users that still have no `employee` link — already-migrated records
 * are left alone.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import User from '../modules/auth/user.model.js';
import Employee from '../modules/employees/employee.model.js';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

// --- Step 1: backfill `type` on every pre-existing Employee record ---------
const typeResult = await Employee.updateMany(
  { type: { $exists: false } },
  { $set: { type: 'Client' } }
);
console.log(`✓ Defaulted ${typeResult.modifiedCount} existing employee(s) to type: 'Client'.`);
console.log(
  "⚠ This can't distinguish internal staff from supplied workforce automatically (e.g. someone who's both " +
    "an Employee record and separately has an Admin/staff login under a different account has no data trail " +
    "connecting the two). Review your existing employees and manually recategorize any to 'Own' via the edit form."
);

// --- Step 2: backfill an Employee for every non-Admin, unlinked User -------
// Read managedBy from the raw collection — it's no longer in the User
// schema, so Model-level queries can't see it.
const rawUsers = await User.collection.find({}).toArray();
const managedByMap = new Map(rawUsers.filter((u) => u.managedBy).map((u) => [u._id.toString(), u.managedBy]));

const unlinked = await User.find({ role: { $ne: 'Admin' }, employee: null });
let seq = 1;
for (const user of unlinked) {
  const employeeId = `STAFF-${String(seq).padStart(3, '0')}`;
  seq += 1;
  const employee = await Employee.create({
    employeeId,
    fullName: user.name,
    type: 'Own',
    designation: user.role,
    joiningDate: user.createdAt,
    status: 'Active',
    manager: managedByMap.get(user._id.toString()) ?? null,
  });
  user.employee = employee._id;
  await user.save();
  console.log(`✓ ${user.email} (${user.role}) → new employee ${employeeId} (${user.name}).`);
}
if (unlinked.length === 0) console.log('✓ No unlinked non-Admin logins found nothing to backfill.');

// --- Step 3: drop the now-superseded managedBy field ------------------------
const unsetResult = await User.collection.updateMany({}, { $unset: { managedBy: '' } });
console.log(`✓ Removed the legacy managedBy field from ${unsetResult.modifiedCount} user document(s).`);

console.log('\nDone. Review the flagged records above, then re-categorize any as needed via the Employees edit form.');
await mongoose.connection.close();

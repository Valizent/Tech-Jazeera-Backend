/**
 * One-time migration: split each SectionAccess document's single grant
 * (`allowedRoles`/`allowedApprovalRoles`) into two independent tiers —
 * `readRoles`/`readApprovalRoles` and `writeRoles`/`writeApprovalRoles`.
 *
 * For every section except the two whose existing grant already meant
 * "can view" rather than "can write" (`mobilisationsViewer`, `team` — see
 * sectionAccess.model.js's doc comment), the existing grant becomes BOTH
 * tiers' starting value: Read mirrors Write, per the explicit instruction
 * behind this change. Nothing regresses for anyone already granted access
 * today — the Admin can diverge Read/Write per section afterward from the
 * Section Access page. For `mobilisationsViewer`/`team`, the existing grant
 * becomes the Read tier only; Write starts empty (no write action was ever
 * tied to either key).
 *
 * Uses the raw collection, not the Mongoose model — the old field names no
 * longer exist in the current schema.
 *
 * Usage:  node src/scripts/migrate-section-access-tiers.js
 *    or:  npm run migrate:section-access-tiers
 *
 * Idempotent: only touches documents that still carry the old
 * `allowedRoles` field — safe to re-run (a second run reports 0 found).
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';

const READ_ONLY_KEYS = new Set(['mobilisationsViewer', 'team']);

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
const collection = mongoose.connection.collection('sectionaccesses');

const docs = await collection.find({ allowedRoles: { $exists: true } }).toArray();
console.log(`Found ${docs.length} section(s) still on the old single-tier grant.`);

let migrated = 0;
for (const doc of docs) {
  const allowedRoles = doc.allowedRoles ?? [];
  const allowedApprovalRoles = doc.allowedApprovalRoles ?? [];
  const isReadOnlyKey = READ_ONLY_KEYS.has(doc.sectionKey);

  const update = isReadOnlyKey
    ? { readRoles: allowedRoles, readApprovalRoles: allowedApprovalRoles, writeRoles: [], writeApprovalRoles: [] }
    : {
        readRoles: allowedRoles,
        readApprovalRoles: allowedApprovalRoles,
        writeRoles: allowedRoles,
        writeApprovalRoles: allowedApprovalRoles,
      };

  await collection.updateOne(
    { _id: doc._id },
    { $set: update, $unset: { allowedRoles: '', allowedApprovalRoles: '' } }
  );
  migrated += 1;
  console.log(`  ✓ ${doc.sectionKey} → ${isReadOnlyKey ? 'read-only (write stays empty)' : 'read = write (mirrored)'}`);
}

console.log(`\n✓ Migrated ${migrated} section(s).`);
await mongoose.connection.close();

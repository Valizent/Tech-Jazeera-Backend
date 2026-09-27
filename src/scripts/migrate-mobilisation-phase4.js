/**
 * One-time migration: backfill every pre-existing Mobilisation document for
 * the Phase-4 schema (worker types, split FTA/allowance, restructured
 * overtime, the new required+unique serialNumber).
 *
 *   1. `workerType: 'Employee'` — every pre-existing mobilisation necessarily
 *      names a real Employee `worker` (the old schema required it), so this
 *      is a safe, unambiguous default, not a guess.
 *   2. `fta` = the old `ftaAllowance` value, `allowance` = 0 — the old field
 *      covered both FTA and a general allowance as one number; splitting it
 *      can't recover which portion was which, so the full amount is kept as
 *      FTA (the more specific of the two) rather than silently dropped.
 *   3. `serialNumber` assigned in creation order via the same atomic counter
 *      Invoices/Quotations already use — must run before the new unique
 *      index on `serialNumber` is ever built, or a second document still
 *      missing the field would collide with the first on that index.
 *   4. Legacy overtime data (`overtimeRate`/`overtimeHours`/`otAmount`/
 *      `otCommissionIn`/`otCommissionOut`) can't be decomposed into the new
 *      rate/commission split — preserved as a note appended to `remark`
 *      rather than silently discarded.
 *   5. Every removed field (`ftaAllowance`, `clientTimesheetRequired`,
 *      `subcontractorTimesheetRequired`, `profit`, the old flat OT fields)
 *      is unset.
 *
 * Reads/writes via the raw collection (bypassing Mongoose), since the fields
 * being read no longer exist in the current schema by the time this runs.
 *
 * Usage:  node src/scripts/migrate-mobilisation-phase4.js
 *    or:  npm run migrate:mobilisation-phase4
 *
 * Idempotent: only touches documents still missing `workerType` or
 * `serialNumber` — already-migrated records are left alone.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import Mobilisation from '../modules/mobilisations/mobilisation.model.js';
import { nextSequence } from '../modules/shared/counter.model.js';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const legacyDocs = await Mobilisation.collection
  .find({ $or: [{ workerType: { $exists: false } }, { serialNumber: { $exists: false } }] })
  .sort({ createdAt: 1 })
  .toArray();

if (legacyDocs.length === 0) {
  console.log('✓ No pre-Phase-4 mobilisation documents found — nothing to migrate.');
} else {
  for (const doc of legacyDocs) {
    const set = {};
    const unset = {
      ftaAllowance: '',
      clientTimesheetRequired: '',
      subcontractorTimesheetRequired: '',
      profit: '',
      overtimeRate: '',
      overtimeHours: '',
      otAmount: '',
      otCommissionIn: '',
      otCommissionOut: '',
    };

    if (doc.workerType == null) set.workerType = 'Employee';
    if (typeof doc.ftaAllowance === 'number') {
      set.fta = doc.ftaAllowance;
      set.allowance = 0;
    }
    if (doc.serialNumber == null) {
      const seq = await nextSequence('mobilisation');
      set.serialNumber = `MOB-${String(seq).padStart(4, '0')}`;
    }
    if (doc.overtimeHours || doc.otAmount) {
      const note = `[Pre-migration OT] hours=${doc.overtimeHours ?? 0} rate=${doc.overtimeRate ?? 0} amount=${doc.otAmount ?? 0} commissionIn=${doc.otCommissionIn ?? 0} commissionOut=${doc.otCommissionOut ?? 0}`;
      set.remark = doc.remark ? `${doc.remark}\n${note}` : note;
    }

    await Mobilisation.collection.updateOne({ _id: doc._id }, { $set: set, $unset: unset });
    console.log(`✓ ${doc._id} → workerType='Employee', serialNumber=${set.serialNumber ?? doc.serialNumber}.`);
  }
  console.log(`\n✓ Migrated ${legacyDocs.length} mobilisation(s) to the Phase-4 schema.`);
}

await mongoose.connection.close();

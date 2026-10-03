/**
 * One-time migration: backfill OutsourcedEmployee from every pre-existing
 * Freelancer/SupplierEmployee Mobilisation.
 *
 * createMobilisation auto-upserts a new worker into OutsourcedEmployees the
 * moment a mobilisation is created (mobilisation.service.js) — but that hook
 * only fires going forward. Every non-Employee mobilisation created before
 * the hook existed left no OutsourcedEmployee record behind, which is why
 * the Outsourced Employees page can look empty even though real
 * Freelancer/SupplierEmployee workers already exist in Mobilisation history
 * (reported live: "we already have some outsourced employees, can we list
 * them here").
 *
 * Replays the exact same upsert the live hook performs, in createdAt order
 * (oldest first) so the result matches what the hook would have produced had
 * it existed since day one: the worker's FIRST mobilisation wins the
 * $setOnInsert snapshot, later ones for the same name+workerType no-op.
 *
 * Usage:  node src/scripts/migrate-backfill-outsourced-employees.js
 *    or:  npm run migrate:backfill-outsourced-employees
 *
 * Idempotent: a document already matching {name, workerType} is left alone
 * (findOneAndUpdate + $setOnInsert) — safe to re-run.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import Mobilisation from '../modules/mobilisations/mobilisation.model.js';
import OutsourcedEmployee from '../modules/employees/outsourcedEmployee.model.js';
import { escapeRegex } from '../utils/escapeRegex.js';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const workers = await Mobilisation.find({ workerType: { $ne: 'Employee' } })
  .sort({ createdAt: 1 })
  .select('workerName workerType phone iqamaNumber nationality subcontractor createdBy')
  .lean();

let created = 0;
let alreadyKnown = 0;
let skipped = 0;

for (const m of workers) {
  if (!m.workerName || !m.createdBy) {
    skipped += 1;
    continue;
  }
  const before = await OutsourcedEmployee.exists({
    name: { $regex: new RegExp(`^${escapeRegex(m.workerName)}$`, 'i') },
    workerType: m.workerType,
  });

  await OutsourcedEmployee.findOneAndUpdate(
    {
      name: { $regex: new RegExp(`^${escapeRegex(m.workerName)}$`, 'i') },
      workerType: m.workerType,
    },
    {
      $setOnInsert: {
        name: m.workerName,
        workerType: m.workerType,
        phone: m.phone || null,
        iqamaNumber: m.iqamaNumber || null,
        nationality: m.nationality || null,
        subcontractor: m.subcontractor || null,
        createdBy: m.createdBy,
      },
    },
    { upsert: true, new: true }
  );

  if (before) alreadyKnown += 1;
  else created += 1;
}

console.log(`✓ Scanned ${workers.length} non-Employee mobilisation(s).`);
console.log(`✓ Created ${created} new OutsourcedEmployee record(s).`);
console.log(`✓ ${alreadyKnown} worker(s) already had a record (left untouched).`);
if (skipped) console.log(`! Skipped ${skipped} mobilisation(s) missing workerName/createdBy.`);

await mongoose.connection.close();

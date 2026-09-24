/**
 * One-time backfill: the new shared Location picklist (see
 * src/modules/locations/) replaces two things that both used to be plain
 * free-typed strings with no shared list — Mobilisation's `site` field (whose
 * suggestions used to come from a live `Mobilisation.distinct('site')` query,
 * now removed) and Requirement's `site` field (which had no suggestions at
 * all). Without this backfill, every distinct site name either form's users
 * have ever typed would simply vanish from suggestions the moment this
 * ships, until manually re-added one by one.
 *
 * This script collects every distinct non-empty `site` value across BOTH
 * collections, de-duplicates case-insensitively (keeping the first casing
 * seen), and creates a Location document for any not already present.
 *
 * Usage:  node src/scripts/migrate-seed-locations.js
 *    or:  npm run migrate:seed-locations
 *
 * Idempotent: re-running finds every value already present as a Location
 * (case-insensitively) and reports 0 created.
 */
import env from '../config/env.js'; // validates env before we touch the DB
import mongoose from 'mongoose';
import Mobilisation from '../modules/mobilisations/mobilisation.model.js';
import Requirement from '../modules/requirements/requirement.model.js';
import Location from '../modules/locations/location.model.js';

await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });

const [mobilisationSites, requirementSites, existingLocations] = await Promise.all([
  Mobilisation.distinct('site', { site: { $nin: [null, ''] } }),
  Requirement.distinct('site', { site: { $nin: [null, ''] } }),
  Location.find({}).select('name').lean(),
]);

const existingByLower = new Set(existingLocations.map((l) => l.name.toLowerCase()));
const seenByLower = new Map(); // lowercase -> first casing seen, across both sources
for (const value of [...mobilisationSites, ...requirementSites]) {
  const trimmed = value.trim();
  if (!trimmed) continue;
  const lower = trimmed.toLowerCase();
  if (!seenByLower.has(lower)) seenByLower.set(lower, trimmed);
}

const toCreate = [...seenByLower.entries()]
  .filter(([lower]) => !existingByLower.has(lower))
  .map(([, name]) => ({ name }));

if (toCreate.length > 0) {
  await Location.insertMany(toCreate, { ordered: false });
}

console.log(`Found ${seenByLower.size} distinct site value(s) across Mobilisation + Requirement.`);
console.log(`✓ Created ${toCreate.length} new Location document(s); ${seenByLower.size - toCreate.length} already existed.`);
if (toCreate.length > 0) {
  console.log(`  Added: ${toCreate.map((l) => l.name).join(', ')}`);
}
await mongoose.connection.close();

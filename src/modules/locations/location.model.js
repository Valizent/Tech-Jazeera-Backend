/**
 * Location — the shared, admin-manageable "site / location" picklist behind
 * both Mobilisation's and Requirement's `site` field (see each model's own
 * `site` doc comment). Both keep storing the chosen value as a plain string
 * snapshot, same "reference at pick-time, snapshot for durable history" rule
 * as jobTitle/clientName — renaming or removing an entry here never rewrites
 * a past record's own text. No `isActive` flag (unlike JobTitle): a location
 * has no referential-integrity concern either, and the user's own explicit
 * ask was a real delete, not a soft-hide.
 */
import mongoose from 'mongoose';

const locationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, maxlength: 150 },
  },
  { timestamps: true }
);

export default mongoose.model('Location', locationSchema);

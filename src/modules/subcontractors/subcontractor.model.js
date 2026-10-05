/**
 * Subcontractor — a company a mobilisation is sometimes routed through (see
 * mobilisations/mobilisation.model.js). Mirrors Client's shape, deliberately
 * simplified: no sites, no approval workflow, no VAT/CR numbers — just enough
 * to identify who it is and reference them by id. Other schemas reference a
 * Subcontractor by ObjectId, never embed — same "reference, don't duplicate"
 * rule as Client.
 */
import mongoose from 'mongoose';

export const SUBCONTRACTOR_STATUSES = ['Active', 'Inactive'];

const subcontractorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    status: { type: String, enum: SUBCONTRACTOR_STATUSES, default: 'Active' },
    creditLimitDays: { type: Number, default: 30, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

subcontractorSchema.index({ name: 1 });
subcontractorSchema.index({ status: 1 });

export default mongoose.model('Subcontractor', subcontractorSchema);

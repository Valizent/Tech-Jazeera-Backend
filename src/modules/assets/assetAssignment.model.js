/**
 * AssetAssignment — one period of one asset being held by one employee.
 * A separate collection from Asset, not an embedded array, for the same
 * reason Deployment is separate from Employee: it is independently queried
 * (an employee's asset history, an asset's holder history) and the partial-
 * unique index below is the hard backstop against a double-assignment race,
 * which an embedded array can't express as a database-level constraint.
 */
import mongoose from 'mongoose';

export const ASSET_ASSIGNMENT_STATUSES = ['Active', 'Ended'];

const assetAssignmentSchema = new mongoose.Schema(
  {
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true },
    assetTag: { type: String, required: true }, // snapshot reads correctly even if the asset is later retired/renamed
    assetName: { type: String, required: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: { type: String, required: true },

    assignedAt: { type: Date, required: true },
    returnedAt: { type: Date, default: null },
    status: { type: String, enum: ASSET_ASSIGNMENT_STATUSES, default: 'Active' },

    conditionNote: { type: String, trim: true, maxlength: 300 },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// THE double-assignment guard: an asset may have at most one Active assignment.
assetAssignmentSchema.index(
  { asset: 1 },
  { unique: true, partialFilterExpression: { status: 'Active' }, name: 'uniq_active_asset' }
);
// An employee's own assigned-assets history, newest first.
assetAssignmentSchema.index({ employee: 1, assignedAt: -1 });
// An asset's holder history, newest first.
assetAssignmentSchema.index({ asset: 1, assignedAt: -1 });

export default mongoose.model('AssetAssignment', assetAssignmentSchema);

import mongoose from 'mongoose';
import { APPROVAL_STATUSES } from '../approvals/approvalLog.model.js';

const annualVacationSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    requestDate: { type: Date, default: Date.now },
    requestedDays: { type: Number, required: true, min: 1, max: 90 },
    reason: { type: String, trim: true, maxlength: 1000 },
    
    status: { type: String, enum: APPROVAL_STATUSES, default: 'PendingReview' },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    
    // Automatically populated snapshot of workflow upon submission
    workflowSnapshot: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

annualVacationSchema.index({ employee: 1, status: 1 });

export default mongoose.model('AnnualVacationRequest', annualVacationSchema);

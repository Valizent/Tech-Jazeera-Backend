/**
 * Client — a company we supply manpower / trade goods to.
 *
 * Schema choices, justified:
 *  - `sites` are EMBEDDED (an array of sub-documents). A site has no meaning
 *    outside its client and is never queried on its own, so it lives and dies
 *    with the client — our embed rule. Sub-documents keep their own `_id` so
 *    the deployment workflow (M6) can reference one specific site stably.
 *  - Employees reference a client (Employee.currentClient), NOT the other way
 *    around: a client relates to many employees, each with an independent
 *    lifecycle. So there is no `workers` array here — the "assigned workers"
 *    view is a query on Employee, which can never go stale.
 *  - `status` (Active/Inactive) is a small, immediately-useful addition beyond
 *    the raw field list: deployments should target active clients, and the
 *    list screen filters on it. It is not speculative.
 */
import mongoose from 'mongoose';

/** Single source of truth for status values — validation and UI import it. */
export const CLIENT_STATUSES = ['Active', 'Inactive'];

/**
 * Approval state, separate from `status` above. A Coordinator-created client
 * starts 'Pending' and is excluded from deployment/quotation client pickers
 * until decided — see client.service.js decideClient(). Admin/Manager-created
 * clients default straight to 'Approved' (they own the client relationship
 * already; there's nothing to approve).
 */
export const CLIENT_APPROVAL_STATUSES = ['Approved', 'Pending', 'Rejected'];

/** A physical location/project of the client. Keeps its own _id (default). */
const siteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  city: { type: String, trim: true },
  address: { type: String, trim: true },
});

const clientSchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    // Saudi tax identifiers. Stored as strings (they are identifiers, never
    // used in arithmetic, and may have leading zeros).
    vatNumber: { type: String, trim: true }, // 15 digits in KSA
    crNumber: { type: String, trim: true }, // Commercial Registration, 10 digits
    industry: { type: String, trim: true },
    sites: { type: [siteSchema], default: [] },
    status: { type: String, enum: CLIENT_STATUSES, default: 'Active' },
    creditLimitDays: { type: Number, default: 50, min: 0 },
    notes: { type: String, trim: true, maxlength: 2000 },
    approvalStatus: { type: String, enum: CLIENT_APPROVAL_STATUSES, default: 'Approved' },
    // Who created this record — null for records predating this field.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Who decided a Pending submission, and how — null until a decision is made.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// The list screen sorts by these; indexes keep those sorts off a full scan.
clientSchema.index({ companyName: 1 });
clientSchema.index({ createdAt: -1 });
// The approvals queue and the deployment/quotation picker's exclusion filter.
clientSchema.index({ approvalStatus: 1 });

export default mongoose.model('Client', clientSchema);

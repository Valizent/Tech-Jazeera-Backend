/**
 * ApprovalRole — an admin-defined role in the company's approval hierarchy
 * (e.g. "HR", "BDM", "MM", "COO", "FM"), fully decoupled from `User.role`
 * (auth/user.model.js). Membership is a plain list of staff Users —
 * deliberately NOT scoped to any particular login role, so an Admin can put
 * whichever real staff account they like into any approval role, matching
 * the company's actual org chart rather than the fixed 6-value login-role
 * enum. See docs — this is the "configurable approval hierarchy" the
 * company asked to define on their own, kept fully separate from the
 * existing fixed-role module permissions.
 *
 * Deactivate, never delete: an ApprovalWorkflow step and a frozen request's
 * `steps` snapshot both reference roles by id, so removing one out from
 * under them would either break a live workflow or corrupt history.
 */
import mongoose from 'mongoose';

const approvalRoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, maxlength: 300 },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Reserved roles ("Worker", "Staff" — see sectionAccess/selfService.constants.js) are the
    // ONLY roles whose members may be Worker/Staff self-service logins. Set by the system
    // (ensureSelfServiceRoles), never by the API: createApprovalRoleSchema does not carry it.
    allowsSelfService: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('ApprovalRole', approvalRoleSchema);

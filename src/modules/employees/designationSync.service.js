/**
 * Designation <-> Approval Role sync (2026-10-14, the user's ask).
 *
 * `Employee.designation` stays a plain string: either the NAME of an active
 * Approval Role ("HR", "FM"...) or free text for a trade with no role behind it
 * ("Welder"). Nothing is stored twice - the role's `members` list is the other
 * half, and these helpers keep the two halves in step:
 *
 *  - designation saved on an employee  -> their login joins that role (and
 *    leaves the role their previous designation named). Employees without a
 *    login, and Worker/Staff self-service logins, are left alone: those logins
 *    may only sit in the reserved Worker/Staff roles.
 *  - members changed on a role         -> the added people's designation
 *    becomes that role unless it already names another role they hold; a
 *    removed person whose designation was this role falls back to another
 *    role they still hold, or is left as it was (a designation is required
 *    and we never invent a trade).
 *  - role renamed                      -> designations carrying the old name follow.
 */
import ApprovalRole from '../approvals/approvalRole.model.js';
import User from '../auth/user.model.js';
import Employee from './employee.model.js';

const SELF_SERVICE_ROLES = ['Worker', 'Staff'];
const usable = { isActive: true, allowsSelfService: { $ne: true } };

/** Names the Designation pick-list offers. */
export async function listDesignationRoles() {
  const roles = await ApprovalRole.find(usable).select('name').sort({ name: 1 }).lean();
  return roles.map((r) => r.name);
}

/** An employee's designation was saved (or their login was just created). */
export async function syncLoginToDesignation(employee, previousDesignation = null) {
  const user = await User.findOne({ employee: employee._id }).select('_id role').lean();
  if (!user || SELF_SERVICE_ROLES.includes(user.role)) return;
  if (previousDesignation && previousDesignation !== employee.designation) {
    await ApprovalRole.updateOne({ name: previousDesignation, ...usable }, { $pull: { members: user._id } });
  }
  await ApprovalRole.updateOne({ name: employee.designation, ...usable }, { $addToSet: { members: user._id } });
}

/** A role's member list changed: `before`/`after` are arrays of user ids. */
export async function syncDesignationsToRoleChange(role, before, after) {
  if (role.allowsSelfService || role.isActive === false) return;
  const was = new Set(before.map(String));
  const now = new Set(after.map(String));
  const added = [...now].filter((id) => !was.has(id));
  const removed = [...was].filter((id) => !now.has(id));
  const holdings = async (userId) =>
    (await ApprovalRole.find({ members: userId, ...usable }).select('name').sort({ name: 1 }).lean()).map((r) => r.name);
  const employeeOf = async (userId) => {
    const user = await User.findById(userId).select('employee').lean();
    return user?.employee ? Employee.findById(user.employee).select('designation').lean() : null;
  };

  for (const userId of added) {
    const employee = await employeeOf(userId);
    if (!employee) continue;
    const held = await holdings(userId);
    if (!held.includes(employee.designation)) await Employee.updateOne({ _id: employee._id }, { designation: role.name });
  }
  for (const userId of removed) {
    const employee = await employeeOf(userId);
    if (!employee || employee.designation !== role.name) continue;
    const [fallback] = await holdings(userId);
    if (fallback) await Employee.updateOne({ _id: employee._id }, { designation: fallback });
  }
}

export async function renameDesignation(from, to) {
  await Employee.updateMany({ designation: from }, { designation: to });
}

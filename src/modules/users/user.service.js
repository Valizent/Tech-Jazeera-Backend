/**
 * Staff-user service — managing logins for staff roles (everything except
 * Worker). Creation moved to employee.service.js's createEmployeeLogin —
 * every login now starts from an Employee record, staff and Worker alike —
 * this module keeps the day-to-day admin actions on an EXISTING login.
 */
import User from '../auth/user.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import Employee from '../employees/employee.model.js';
import ApiError from '../../utils/ApiError.js';
import { hashPassword, generateTempPassword } from '../auth/auth.service.js';
import { logAudit } from '../audit/audit.service.js';

const PUBLIC_FIELDS = 'name email role isActive employee createdAt';

/** Listing for the Team admin screen, and for picker dropdowns (?role=Coordinator). */
export async function listStaffUsers({ role } = {}) {
  const filter = { role: { $ne: 'Worker' } };
  if (role) filter.role = role;
  return User.find(filter)
    .select(PUBLIC_FIELDS)
    .populate({
      path: 'employee',
      select: 'employeeId fullName manager',
      populate: { path: 'manager', select: 'name' },
    })
    .sort({ name: 1 })
    .lean();
}

/** Update role / active status for an existing staff login. Who this login's
 *  Employee reports to (manager/coordinator) is edited on the Employee
 *  record itself, not here — see employee.service.js's updateEmployee. */
export async function updateStaffUser(id, { role, isActive }, actor) {
  const user = await User.findById(id);
  if (!user || user.role === 'Worker') throw new ApiError(404, 'Staff user not found.');

  if (isActive === false && user._id.toString() === actor.userId) {
    throw new ApiError(400, 'You cannot deactivate your own account.');
  }

  if (role) user.role = role;
  if (isActive !== undefined) user.isActive = isActive;
  await user.save();

  await logAudit({
    user: actor.userId,
    action: 'user.update.staff',
    targetType: 'User',
    targetId: user._id,
    meta: {
      fields: Object.keys({ role, isActive }).filter((k) => ({ role, isActive })[k] !== undefined),
    },
    ip: actor.ip,
  });

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  };
}

/**
 * Admin resets a staff user's password — the recovery path for "I forgot
 * it" or "I think it's compromised", since there is no self-service email
 * flow (no email provider is configured for this project; see
 * docs/P2-M4-notes.md). Same one-time-temp-password shape as provisioning:
 * generated, returned once, only its hash stored. Every existing session for
 * that account is revoked, same as a self-service password change.
 */
export async function resetStaffPassword(id, actor) {
  const user = await User.findById(id);
  if (!user || user.role === 'Worker') throw new ApiError(404, 'Staff user not found.');

  const tempPassword = generateTempPassword();
  user.passwordHash = await hashPassword(tempPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await RefreshToken.deleteMany({ user: user._id });

  await logAudit({
    user: actor.userId,
    action: 'user.password.reset',
    targetType: 'User',
    targetId: user._id,
    meta: { email: user.email },
    ip: actor.ip,
  });

  return { tempPassword };
}

/**
 * Permanently remove a staff login (distinct from Deactivate, which is the
 * recommended default for a leaver — see the "soft on/off switch" comment on
 * the User model). Delete is for accounts that should never have existed at
 * all: a mistyped entry, a throwaway test account, provisioned-by-accident.
 *
 * Blocked when it would leave a dangling reference: a Coordinator still
 * assigned to employees, or a manager other employees still report to —
 * both would silently orphan real records. Reassign first, then delete.
 */
export async function deleteStaffUser(id, actor) {
  const user = await User.findById(id);
  if (!user || user.role === 'Worker') throw new ApiError(404, 'Staff user not found.');

  if (user._id.toString() === actor.userId) {
    throw new ApiError(400, 'You cannot delete your own account.');
  }

  if (user.role === 'Coordinator') {
    const teamCount = await Employee.countDocuments({ coordinator: user._id });
    if (teamCount > 0) {
      throw new ApiError(
        400,
        `${teamCount} employee(s) are still assigned to this coordinator. Reassign them first.`
      );
    }
  }

  const reportCount = await Employee.countDocuments({ manager: user._id });
  if (reportCount > 0) {
    throw new ApiError(
      400,
      `${reportCount} employee(s) report to this user as their manager. Reassign them first.`
    );
  }

  await User.findByIdAndDelete(id);
  await RefreshToken.deleteMany({ user: id });

  await logAudit({
    user: actor.userId,
    action: 'user.delete.staff',
    targetType: 'User',
    targetId: id,
    meta: { email: user.email, role: user.role },
    ip: actor.ip,
  });
}

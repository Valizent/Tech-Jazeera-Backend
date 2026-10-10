/**
 * Worker and Staff logins are self-service personas: they reach the ESS portal
 * (`/api/me`) and nothing else, and until 2026-10-10 they could not be members
 * of any approval role or hold any Section Access grant (the deny-by-default
 * floor in rbac.js and sectionAccess.service.js).
 *
 * 2026-10-10, the user's own ask: two reserved approval roles, "Worker" and
 * "Staff", that an Admin fills with individual logins and can then grant a
 * SAFE LIST of sections (Read and Write). Everything else stays unreachable
 * for these logins no matter what is ticked — the allow-list below is enforced
 * when a grant is saved AND again every time access is evaluated.
 */

/** Login roles that are self-service only. */
export const SELF_SERVICE_LOGIN_ROLES = ['Worker', 'Staff'];

/** The only approval roles whose members may be Worker/Staff logins. */
export const SELF_SERVICE_ROLE_NAMES = ['Worker', 'Staff'];

/**
 * Section keys a self-service login may ever be granted. Money, payroll-
 * adjacent data, employee personal/salary records and admin sections are
 * deliberately absent.
 */
export const SELF_SERVICE_GRANTABLE_KEYS = [
  'holidays',
  'assetsManage',
  'documentsManage',
  'attendanceSignInOut',
  'leaveRequests',
  'timesheetRequests',
  'dailyUpdatesOwn',
  'dailyUpdatesTeam',
  'requirementsOwn',
  'requirementsTeam',
];

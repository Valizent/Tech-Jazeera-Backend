/**
 * requireRoles — decides WHAT an authenticated user may do.
 *
 * Usage (always AFTER requireAuth in the chain):
 *   router.get('/', requireAuth, requireRoles('Admin', 'HR'), controller)
 *
 * Authentication (who are you) and authorization (what may you do) are kept
 * as two middlewares because most routes share the same requireAuth but
 * differ in allowed roles.
 */
import ApiError from '../utils/ApiError.js';
import { ROLES } from '../modules/auth/user.model.js';

export const requireRoles = (...allowedRoles) => {
  // Catch typos like requireRoles('Adm1n') at boot, not at request time.
  for (const role of allowedRoles) {
    if (!ROLES.includes(role)) {
      throw new Error(`requireRoles: unknown role "${role}". Valid roles: ${ROLES.join(', ')}`);
    }
  }

  return (req, res, next) => {
    if (!req.user) {
      // Programmer error: rbac ran before requireAuth. Fail loudly.
      throw new ApiError(500, 'Something went wrong. Please try again.');
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(403, 'You do not have permission to perform this action.');
    }
    next();
  };
};

/**
 * Staff = every role EXCEPT the self-service personas, Worker (P2-M1) and
 * Staff (the login role — confusingly named the same as this constant, but
 * distinct: STAFF_ROLES is "company-wide admin access", the `Staff` role is
 * "self-service only"), and the one remaining deny-by-default senior/narrow
 * role, Executive (see user.model.js's doc comments — allow-listed into
 * specific routes via requireStaffOrExecutive below, never blanket CRUD
 * access). The admin modules (employees, clients, deployments, attendance,
 * documents, quotations, dashboard) are staff-only; Worker and Staff logins
 * use the ESS portal (`/api/me`) instead, never these.
 *
 * Office Secretary moved INTO this set 2026-09-13 (see
 * docs/RBAC-notes.md's Office Secretary follow-up) — originally built
 * narrow like Executive (single-purpose: the Mobilisation module's
 * post-Coordinator review step), the user asked for her to get the full
 * staff floor instead once a second real use case (self-marking her own
 * attendance) came up. This alone grants her nothing beyond reaching the
 * same routers every other staff role reaches — actual visibility into any
 * given section still comes entirely from her real Section Access grants
 * (canAccessSection's own floor check is exactly this constant), same as a
 * freshly-created Coordinator with no grants yet would see nothing either.
 * `requireStaffOrOfficeSecretary` is gone — plain `requireStaff` already
 * covers her now.
 *
 * Derived from ROLES rather than hard-coded so a future self-service role is
 * excluded automatically. Mounted at the router level (`router.use(requireStaff)`)
 * so it covers every route in a module — including the READ routes that
 * otherwise ask only for requireAuth, which is exactly where a Worker/Staff
 * login would leak into company-wide data.
 */
export const STAFF_ROLES = ROLES.filter((role) => !['Worker', 'Staff', 'Executive'].includes(role));
export const requireStaff = requireRoles(...STAFF_ROLES);

/**
 * requireStaff, plus Executive — for the short, deliberate list of routes an
 * Executive login (GM/COO) may reach: the Dashboard, and the read + decide
 * endpoints of whichever request types the Configurable Approval Hierarchy
 * can route to senior leadership (Leave, Timesheet, SalaryAdvance,
 * Reimbursement) plus the Approval Log. Letting Executive through THIS gate
 * is safe by construction: the shared approval engine (approvalEngine.
 * service.js) re-checks real ApprovalRole membership per item regardless of
 * who cleared the router-level gate, so an Executive with no membership on a
 * given workflow step simply can't decide it — this only controls which
 * doors they can knock on, never what happens once they do.
 *
 * Deliberately NOT used for money-handling actions (repayments, marking a
 * claim paid) or any create/edit/delete route — see docs/RBAC-notes.md.
 */
export const requireStaffOrExecutive = requireRoles(...STAFF_ROLES, 'Executive');

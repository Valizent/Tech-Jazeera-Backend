/**
 * Employee routes.
 *
 * Role design: READ (list/get) is the generic, admin-configurable Section
 * Access mechanism (see sectionAccess.model.js), sectionKey 'employeeCreate'
 * at the 'read' level — its default mirrors the CREATE default below (an
 * explicit, deliberate choice: this key's write default is empty/Admin-only
 * by design, and Read now mirrors that exactly too, so reading the employee
 * register also starts Admin-only until an Admin grants Read to whoever
 * needs it). WRITE (update) is Admin/Manager/HR (the people who own
 * workforce data); DELETE is Admin/HR only — it destroys history, so the
 * circle is smaller. Status 'Exited' is the everyday alternative to delete.
 *
 * CREATE is 'employeeCreate' at the 'write' level — by default nobody but
 * Admin can add an employee ("until then only admin can add employees," the
 * user's own words). An Admin designates a real "office secretary" person
 * (any role — the whole point is it doesn't have to be a fixed role) by
 * putting them in an ApprovalRole and granting that role 'employeeCreate'
 * write access from the Section Access page. Coordinator's old
 * self-team-creation override in employee.service.js still exists and still
 * works, but is dormant unless an Admin explicitly re-grants 'Coordinator'
 * that access — it's no longer a blanket default.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles, requireStaff } from '../../middleware/rbac.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesSchema,
  employeeIdParamSchema,
  createLoginSchema,
  updateLoginRoleSchema,
} from './employee.validation.js';
import * as employeeController from './employee.controller.js';

const router = Router();

// Everything below requires a logged-in STAFF user. Workers (P2-M1) are the
// self-service persona and have no business in the workforce register — they
// get a clean 403 here and use the ESS portal (P2-M2) instead.
router.use(requireAuth);
router.use(requireStaff);

const canReadEmployees = requireSectionAccess('employeeCreate', 'read');

router.get('/', canReadEmployees, validate({ query: listEmployeesSchema }), asyncHandler(employeeController.list));
router.get(
  '/:id',
  canReadEmployees,
  validate({ params: employeeIdParamSchema }),
  asyncHandler(employeeController.get)
);
router.post(
  '/',
  requireSectionAccess('employeeCreate', 'write'),
  validate({ body: createEmployeeSchema }),
  asyncHandler(employeeController.create)
);
router.patch(
  '/:id',
  requireRoles('Admin', 'Manager', 'HR'),
  validate({ params: employeeIdParamSchema, body: updateEmployeeSchema }),
  asyncHandler(employeeController.update)
);
router.delete(
  '/:id',
  requireRoles('Admin', 'HR'),
  validate({ params: employeeIdParamSchema }),
  asyncHandler(employeeController.remove)
);

// Provision a login for this employee, any role except Admin — the ONE way
// to create a login in this app. Admin/HR only — the same circle that owns
// workforce data owns account creation for it. Returns a one-time temporary
// password for the admin to hand over.
router.post(
  '/:id/user',
  requireRoles('Admin', 'HR'),
  validate({ params: employeeIdParamSchema, body: createLoginSchema }),
  asyncHandler(employeeController.createLogin)
);

// Reset a login's password — the recovery path when a temp password is
// lost or forgotten. Same circle as provisioning the login in the first place.
router.post(
  '/:id/user/reset-password',
  requireRoles('Admin', 'HR'),
  validate({ params: employeeIdParamSchema }),
  asyncHandler(employeeController.resetLoginPassword)
);

// Correct an existing login's role — Worker vs Staff (or any other role)
// picked wrong at provisioning time. Same circle as the rest of login
// management; see employee.service.js's updateEmployeeLoginRole for why
// this lives here instead of the Users module.
router.patch(
  '/:id/user/role',
  requireRoles('Admin', 'HR'),
  validate({ params: employeeIdParamSchema, body: updateLoginRoleSchema }),
  asyncHandler(employeeController.updateLoginRole)
);

export default router;

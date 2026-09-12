/**
 * Zod schemas for employee endpoints — the write gate for all employee data.
 *
 * HTML forms send "" for every untouched field; the `emptyToUndef`
 * preprocessor turns those into undefined so optional fields stay truly
 * absent instead of storing empty strings.
 */
import { z } from 'zod';
import { EMPLOYEE_STATUSES, EMPLOYEE_TYPES } from './employee.model.js';
import { ROLES } from '../auth/user.model.js';

const emptyToUndef = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const optionalDate = z.preprocess(emptyToUndef, z.coerce.date().optional());

/** Like an objectId field, but "" means "unassign" (null), not "untouched". */
const nullableObjectId = (label) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`).nullable().optional()
  );

/** Like nullableObjectId, but for a number — "" means "clear it" (null). */
const nullableHours = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.coerce.number({ error: 'Enter a number of hours.' }).min(0).max(24).nullable().optional()
);

/** Like nullableHours, but for a SAR amount (basicSalary/housingAllowance/transportAllowance). */
const nullableAmount = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.coerce.number({ error: 'Enter an amount.' }).min(0).max(1_000_000).nullable().optional()
);

/** Day-of-week (0=Sun..6=Sat) for weeklyOffDay — "" means "no fixed off day" (null).
 *  No .default() here on purpose: updateEmployeeSchema is this schema made
 *  .partial(), and PATCH relies on an omitted key meaning "leave unchanged" —
 *  a Zod default would silently reset every unrelated PATCH to Friday. The
 *  Mongoose schema default handles "Friday for a brand new employee" instead. */
const nullableWeekday = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.coerce.number({ error: 'Pick a day of week.' }).int().min(0).max(6).nullable().optional()
);

// Loose international phone shape — real-world numbers are messy; we only
// reject obvious garbage, we don't try to fully parse them.
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{5,18}$/, 'Enter a valid phone number.');

/** One identity document: number + expiry, both optional (e.g. no iqama yet). */
const documentSchema = z
  .object({
    number: optionalStr(50),
    expiry: optionalDate,
  })
  .optional();

/** The plain object shape, without the create-only cross-field check below —
 *  `updateEmployeeSchema` is derived from THIS, not from createEmployeeSchema,
 *  since .partial() can't be chained after .superRefine() and a PATCH body
 *  wouldn't satisfy that create-only check anyway (see updateEmployeeSchema). */
const employeeObjectSchema = z
  .object({
    employeeId: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9-]+$/, 'Only letters, numbers and dashes.')
      .transform((s) => s.toUpperCase()),
    fullName: z.string().trim().min(2, 'Full name is required.').max(100),
    // 'Own' = internal staff (reports to a Manager); 'Outsourced'/'Subcontracted'
    // = workforce (see EMPLOYEE_TYPES in employee.model.js). Both workforce
    // types require the compliance fields below; only 'Outsourced' additionally
    // requires salary, and only 'Subcontracted' requires `subcontractor` —
    // see the superRefine at the bottom of this schema.
    type: z.enum(EMPLOYEE_TYPES).default('Outsourced'),
    nationality: optionalStr(60),
    mobile: z.preprocess(emptyToUndef, phone.optional()),
    email: z.preprocess(
      (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toLowerCase()) : v),
      z.email('Enter a valid email address.').optional()
    ),

    passport: documentSchema,
    visa: documentSchema,
    iqama: documentSchema,
    medical: documentSchema,
    drivingLicense: documentSchema,

    joiningDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
    designation: z.string().trim().min(2, 'Designation is required.').max(60),
    department: optionalStr(60),
    salary: z.preprocess(
      emptyToUndef,
      z.coerce.number({ error: 'Salary must be a number.' }).min(0).max(1_000_000).optional()
    ),
    // Optional WPS breakdown of `salary` — see employee.model.js. "" clears
    // it (nullableAmount), not "leave unchanged" — same rule as manager/weeklyOffDay.
    basicSalary: nullableAmount,
    housingAllowance: nullableAmount,
    transportAllowance: nullableAmount,
    accommodation: optionalStr(100),
    // Early-sign-out warning threshold for this employee (My Attendance). "" means
    // "no threshold" (null), not "leave unchanged" — same rule as manager.
    expectedDailyHours: nullableHours,
    weeklyOffDay: nullableWeekday,
    status: z.enum(EMPLOYEE_STATUSES).default('Active'),

    emergencyContact: z
      .object({
        name: optionalStr(100),
        phone: z.preprocess(emptyToUndef, phone.optional()),
        relation: optionalStr(50),
      })
      .optional(),
    notes: optionalStr(2000),
    // NOTE: `coordinator` is deliberately absent (Milestone 5) — it's no
    // longer client-settable via these endpoints at all. It's fully derived
    // from Mobilisation state now (null while standby, set to a real
    // Coordinator's id only while an active Mobilisation places the
    // employee) — see mobilisation.service.js's createMobilisation/
    // completeMobilisation. Zod strips this key silently if a hand-crafted
    // request still sends it (no .strict() needed).
    // The Admin/Manager this employee reports to. Universal across both
    // types (every 'Own' employee has one; an 'Outsourced' employee may have
    // one alongside or instead of a coordinator). Validated in the service.
    manager: nullableObjectId('manager'),
    // Configurable Approval Hierarchy: overrides the company-wide default
    // ApprovalWorkflow for this employee's requests. "" clears it (null),
    // not "leave unchanged" — same rule as manager/weeklyOffDay.
    approvalWorkflow: nullableObjectId('approval workflow'),
    // Who supplied this worker — required only when type is 'Subcontracted'
    // (see the superRefine below); referential integrity (must be a real
    // Subcontractor) is checked in the service, same as manager.
    subcontractor: nullableObjectId('subcontractor'),
    // NOTE: currentClient / currentSite are deliberately absent — they are set
    // by the deployment workflow (M6), and unknown keys are stripped by Zod,
    // so a hand-crafted request can't smuggle an assignment through this form.
  });

/** CREATE: the object shape plus the type-driven cross-field check —
 *  mirrors the Mongoose conditional `required`s on the model exactly:
 *  nationality/mobile/joiningDate for both workforce types, salary only for
 *  'Outsourced', `subcontractor` only for 'Subcontracted'. */
export const createEmployeeSchema = employeeObjectSchema.superRefine((data, ctx) => {
  if (data.type === 'Own') return;
  if (!data.nationality) ctx.addIssue({ code: 'custom', path: ['nationality'], message: 'Nationality is required.' });
  if (!data.mobile) ctx.addIssue({ code: 'custom', path: ['mobile'], message: 'Enter a valid mobile number.' });
  if (!data.joiningDate) ctx.addIssue({ code: 'custom', path: ['joiningDate'], message: 'Joining date is required.' });
  if (data.type === 'Outsourced' && data.salary == null) {
    ctx.addIssue({ code: 'custom', path: ['salary'], message: 'Salary is required.' });
  }
  if (data.type === 'Subcontracted' && !data.subcontractor) {
    ctx.addIssue({ code: 'custom', path: ['subcontractor'], message: 'Select who supplied this worker.' });
  }
});

/** PATCH: any subset of the same fields, same rules — minus the create-only
 *  cross-field check above, which can't be evaluated against a partial body
 *  (a PATCH that only touches `salary` never resends `type`).
 *
 *  `type` and `status` are re-declared here without their `.default()` —
 *  same reasoning as `nullableWeekday` above: Zod's `.partial()` only makes a
 *  field optional, it does NOT stop `.default()` from firing when the key is
 *  omitted, so a bare `.partial()` here would silently reset `type` to
 *  'Outsourced' (and `status` to 'Active') on every PATCH that doesn't resend
 *  them — e.g. a PATCH that only touches `joiningDate` would quietly turn a
 *  'Subcontracted' or 'Own' employee into 'Outsourced'. An omitted key on
 *  PATCH must mean "leave unchanged," never "reset to default." */
export const updateEmployeeSchema = employeeObjectSchema.partial().extend({
  type: z.enum(EMPLOYEE_TYPES).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
});

export const listEmployeesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: optionalStr(100),
  status: z.preprocess(emptyToUndef, z.enum(EMPLOYEE_STATUSES).optional()),
  // 'Own' | 'Outsourced' — powers the Employees list filter, the deployment
  // assign-worker picker (Outsourced only), and the Records grid (Outsourced only).
  type: z.preprocess(emptyToUndef, z.enum(EMPLOYEE_TYPES).optional()),
  // String enum, NOT z.coerce.boolean() — that coerces the string "false" to
  // true (any non-empty string is truthy), a classic query-string trap.
  alerts: z.preprocess(emptyToUndef, z.enum(['true', 'false']).optional()),
  // Filter to one client's workforce — powers the client profile's
  // "Assigned Workers" tab (M5). Set by the deployment workflow (M6).
  client: z.preprocess(
    emptyToUndef,
    z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid client id.').optional()
  ),
  // P2-M2: a Manager passes 'mine' to see only their coordinators' employees.
  // A Coordinator is scoped to their own team automatically — no param needed.
  team: z.preprocess(emptyToUndef, z.enum(['mine']).optional()),
  // 'Coordinator' → only employees created by a Coordinator account. Powers
  // the Coordinator Activity page.
  createdByRole: z.preprocess(emptyToUndef, z.enum(['Coordinator']).optional()),
  // Only employees whose OWN linked login has this role — e.g. 'Worker', so
  // Mobilisation's "Own Employee" picker offers real field workers, not
  // whichever staff role (Manager/Coordinator/HR/Accounts/...) an Own
  // employee happens to log in as. An Own employee with no login at all is
  // excluded too — deliberate, matches "mobilisable" meaning "a real
  // field worker," not "any payroll record."
  loginRole: z.preprocess(emptyToUndef, z.enum(ROLES).optional()),
  // P2-M2: override the default 30-day expiry-alert window (customizable per
  // viewer — see docs/P2-M2-notes.md). Only meaningful together with alerts=true.
  thresholdDays: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(365).optional()),
  sortBy: z.enum(['fullName', 'joiningDate', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const employeeIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid employee id.'),
});

/** Every role a login can be provisioned with from an Employee's profile — any
 *  role except Admin, which has no Employee and is never created this way. */
export const EMPLOYEE_LOGIN_ROLES = ROLES.filter((role) => role !== 'Admin');

/**
 * Body for provisioning a login for this employee. `email` is optional: the
 * service defaults to the employee's own email and only needs this when the
 * record has none. Same preprocess as the employee email so "" → undefined.
 * `role` picks what the login can do — any non-Admin role, not just Worker.
 */
export const createLoginSchema = z.object({
  email: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toLowerCase()) : v),
    z.email('Enter a valid email address.').optional()
  ),
  role: z.enum(EMPLOYEE_LOGIN_ROLES, {
    error: `Role must be one of: ${EMPLOYEE_LOGIN_ROLES.join(', ')}.`,
  }),
});

/** Body for correcting an existing login's role — same allowed set as
 *  creation (any non-Admin role). Needed because a role picked at
 *  provisioning time (e.g. 'Worker' vs 'Staff' for an internal employee)
 *  isn't always the right one, and there was previously no way to fix it
 *  short of deleting the User document directly in the database. */
export const updateLoginRoleSchema = z.object({
  role: z.enum(EMPLOYEE_LOGIN_ROLES, {
    error: `Role must be one of: ${EMPLOYEE_LOGIN_ROLES.join(', ')}.`,
  }),
});

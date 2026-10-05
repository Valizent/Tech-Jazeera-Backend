/**
 * Employee — the person record for everyone in the company except Admin
 * (NOT a login account; that's User — see user.model.js. `type` below is
 * what used to be this model's whole reason for existing: it only ever
 * represented the deployed/supplied workforce. Every internal login
 * (Manager/HR/Accounts/Coordinator) now gets one too).
 *
 * Schema choices, justified:
 *  - `type` splits the population this record can represent: 'Outsourced' is
 *    the original meaning (workforce supplied to clients — visa/iqama-tracked,
 *    salary counted in payroll); 'Own' is internal staff (Manager/HR/IT/
 *    Office roles), who may have none of that compliance paperwork. See the
 *    conditional `required` on nationality/mobile/joiningDate/salary below.
 *  - Documents (passport/visa/iqama/medical/driving license) are EMBEDDED:
 *    they live and die with the employee and are never queried on their own,
 *    which is exactly our embed-vs-reference rule. Same for emergencyContact.
 *  - currentClient is a REFERENCE (ObjectId → Client): clients have their own
 *    independent lifecycle (M5), and one client relates to many employees.
 *    In M4 it stays null — assignment is the deployment workflow's job (M6),
 *    not an HR form field, so guards against double-assignment live there.
 *  - No soft-delete flag: status 'Exited' is the business-level "gone";
 *    hard delete stays for records created by mistake.
 */
import mongoose from 'mongoose';

/** Single source of truth for status values — validation and UI import it. */
export const EMPLOYEE_STATUSES = ['Active', 'On Leave', 'Exited'];
/** 'Own' = internal staff (reports to a Manager). 'Outsourced' = the
 *  company's own workforce supplied to clients (mapped to a Coordinator
 *  and/or a Manager). 'Subcontracted' = a worker sourced from an outside
 *  Subcontractor (their employer of record, not this company) and placed
 *  with a client — full compliance/attendance record, but never this
 *  company's payroll (see `salary`'s own required-check below, which is
 *  deliberately narrower than the other compliance fields'). */
export const EMPLOYEE_TYPES = ['Own', 'Outsourced', 'Subcontracted'];
/** The "not internal staff" set — every module that means "the workforce
 *  we track on-site" (Attendance, the Coordinator team scope, etc.) should
 *  import this instead of re-deriving it, so a future fourth type doesn't
 *  need finding every inline `!== 'Own'` check. */
export const WORKFORCE_TYPES = ['Outsourced', 'Subcontracted'];

/** Both workforce types carry the compliance/attendance fields below as
 *  required — only 'Own' (internal staff) is exempt. */
function requiredForWorkforce() {
  return this.type !== 'Own';
}

/** Only 'Outsourced' is paid through this company's own Payroll — a
 *  Subcontracted worker's pay is the subcontractor's business, never
 *  aggregated here (see payroll.service.js / dashboard.service.js, both of
 *  which filter on `type: 'Outsourced'` explicitly and must stay that way). */
function requiredForOwnPayroll() {
  return this.type === 'Outsourced';
}

/** A Subcontracted employee must name who supplied them. */
function requiredForSubcontracted() {
  return this.type === 'Subcontracted';
}

/**
 * Reusable sub-schema for an identity/compliance document. _id disabled —
 * these are plain value objects, not entities.
 */
const documentSchema = new mongoose.Schema(
  {
    number: { type: String, trim: true },
    expiry: { type: Date },
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema(
  {
    // Company-assigned code (e.g. AJ-0042). Uppercased for consistent lookups;
    // the unique index also backs duplicate detection (409 via error handler).
    employeeId: { type: String, required: true, unique: true, trim: true, uppercase: true },
    fullName: { type: String, required: true, trim: true },
    // 'Own' = internal staff; 'Outsourced'/'Subcontracted' = workforce (see
    // EMPLOYEE_TYPES above for the distinction between the two).
    type: { type: String, enum: EMPLOYEE_TYPES, required: true, default: 'Outsourced' },
    nationality: { type: String, required: requiredForWorkforce, trim: true },
    mobile: { type: String, required: requiredForWorkforce, trim: true },
    // Optional — many field workers have no email. NOT unique for that reason.
    email: { type: String, trim: true, lowercase: true },

    passport: { type: documentSchema, default: () => ({}) },
    visa: { type: documentSchema, default: () => ({}) },
    iqama: { type: documentSchema, default: () => ({}) },
    medical: { type: documentSchema, default: () => ({}) },
    drivingLicense: { type: documentSchema, default: () => ({}) },

    // Additional user-defined documents (e.g. certificates, passes)
    additionalDocuments: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          number: { type: String, trim: true },
          expiry: { type: Date },
        },
      ],
      default: [],
    },

    joiningDate: { type: Date, required: requiredForWorkforce },
    contractStartDate: { type: Date, default: null },
    contractEndDate: { type: Date, default: null },
    designation: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    // Monthly salary in SAR. Number (not string) so M10 can aggregate costs.
    // Required only for Outsourced — this is the figure Monthly Payroll sums, and
    // that figure is deliberately scoped to the supplied workforce we pay
    // ourselves, never a Subcontracted worker's pay (see dashboard.service.js).
    salary: { type: Number, required: requiredForOwnPayroll, min: 0 },
    // Optional WPS-style breakdown of `salary` (P2-M5) — null/unset means
    // "not broken down"; Payroll then treats the whole `salary` as Basic
    // rather than guessing a split percentage that was never agreed. Set
    // these only once the real Basic/HRA/Transport split for this employee
    // is known — never inferred from a standard-looking ratio.
    basicSalary: { type: Number, default: null, min: 0 },
    housingAllowance: { type: Number, default: null, min: 0 },
    transportAllowance: { type: Number, default: null, min: 0 },
    accommodation: { type: String, trim: true },

    // The minimum shift length before My Attendance warns this Worker on an
    // early sign-out (e.g. 9.5). Per-employee because it genuinely varies by
    // role/contract — null means no warning is shown for them at all, not a
    // fallback to some hardcoded company-wide number. Set by Admin/Manager/HR
    // from the employee form, same write circle as the rest of the record.
    expectedDailyHours: { type: Number, default: null, min: 0, max: 24 },

    // The single fixed day this employee is normally off (0=Sun..6=Sat,
    // matching Date#getUTCDay() and attendance.dates.js's isWeekend
    // convention). Defaults to Friday (5) for anyone no one has explicitly
    // configured; null means "no fixed weekly off" (e.g. rotating shifts).
    // The Records grid uses this to INFER an Off day when no real Attendance
    // record exists — never written to Attendance itself, and a real record
    // for that day always wins over this default.
    weeklyOffDay: { type: Number, default: 5, min: 0, max: 6 },

    // Managed by the deployment workflow from M6 — never set via the HR form.
    currentClient: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
    currentSite: { type: String, trim: true, default: null },

    // Who supplied this worker — required only for 'Subcontracted'. A
    // reference, not a snapshot (same convention as coordinator/manager
    // below): this record is looked up live, not duplicated, since it's
    // populated on every read rather than needing durable point-in-time
    // history the way Mobilisation's own subcontractor snapshot does.
    subcontractor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subcontractor',
      default: null,
      required: requiredForSubcontracted,
    },

    // P2-M2: the Coordinator user responsible for this employee's day-to-day
    // (leave decisions, expiry follow-up). Optional — HR/Manager/Admin assign
    // it from the employee form, same write circle as the rest of the record.
    // Referential integrity (must actually be a 'Coordinator' user) is checked
    // in the service layer, not here — Mongoose refs don't validate the target.
    coordinator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // The Admin/Manager this employee reports to — universal across both
    // types: every 'Own' employee has one (Coordinator/HR/IT/Office all
    // report to a Manager), and an 'Outsourced' employee may have one too,
    // alongside or instead of a coordinator. Referential integrity (must be
    // Admin or Manager) is checked in the service layer, same as coordinator.
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Configurable Approval Hierarchy (post-Phase-3): which ApprovalWorkflow
    // governs THIS employee's Leave/SalaryAdvance/Reimbursement/Timesheet
    // requests, overriding the company-wide default for each type (see
    // ApprovalWorkflow.appliesTo and approvals.service.js's
    // resolveApprovalWorkflow). null = no override — use the company
    // default if one exists, otherwise the original single-level flow.
    // Referential integrity (must be a real, active workflow) is checked in
    // the service layer, same as coordinator/manager above.
    approvalWorkflow: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow', default: null },
    // Who created this record — null for records predating this field. Lets
    // Admin/Manager/HR see, at a glance, which employees a Coordinator added
    // themselves (self-service, no approval — see docs/PHASE2-PLAN.md).
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    status: { type: String, enum: EMPLOYEE_STATUSES, default: 'Active' },

    emergencyContact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      relation: { type: String, trim: true },
    },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// The list screen sorts by these; without indexes every sort is a full scan.
employeeSchema.index({ fullName: 1 });
employeeSchema.index({ createdAt: -1 });
// A coordinator's team, and the "my team" scoping filter (P2-M2).
employeeSchema.index({ coordinator: 1 });
// A manager's direct reports, and the type filter used across dashboard/
// attendance/deployment scoping (see employee.service.js listEmployees).
employeeSchema.index({ manager: 1 });
employeeSchema.index({ type: 1 });
// Who's currently placed with a client (client profile's "Assigned Workers"
// tab, the Standby List, and listEmployees' own `client`/`standby` filters)
// — read/filtered on every one of those, with no supporting index until now.
employeeSchema.index({ currentClient: 1 });

export default mongoose.model('Employee', employeeSchema);

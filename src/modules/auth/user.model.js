/**
 * User — a login account for the ERP.
 *
 * Deliberately separate from Employee: a User is credentials + a role; an
 * Employee is the person record (workforce details, documents, org
 * placement). Every non-Admin User is linked to exactly one Employee
 * (`employee` below) — the person's full details live there, not here.
 * Admin is the one exception: a pure system-access account with no workforce
 * presence, so it has no Employee. The two stay separate collections (not
 * merged into one) because logins and people still have independent
 * lifecycles — a person can exist with no login at all, and a login is
 * revoked/deactivated without deleting the person record it came from.
 */
import mongoose from 'mongoose';

/**
 * Role list, exported as the single source of truth — rbac middleware,
 * validation schemas, and the seed script all import it from here so a new
 * role is added in exactly one place.
 *
 * `Worker` (added in P2-M1) and `Staff` (added alongside the Subcontracted
 * employee type) are both self-service personas — a login that can see ONLY
 * its own data via the ESS portal (`/api/me`), never the company-wide admin
 * modules. They are deliberately the last two entries and the odd ones out
 * — every OTHER role is "staff" in the STAFF_ROLES sense (see the rbac
 * middleware), and the admin modules are staff-only. `Worker` is for a
 * deployed workforce employee (Client/Subcontracted type); `Staff` is the
 * same self-service mechanism for an internal Own-type employee (e.g. office
 * staff with no company-wide access) — same ESS shell, same routes, just a
 * different Employee.type backing it.
 *
 * `Coordinator` (added in P2-M2) is staff, but scoped: they see and act on
 * only the Employees assigned to them (Employee.coordinator), not the whole
 * company. Everything else (Admin, Manager, HR, Accounts) keeps its existing
 * company-wide visibility — adding Coordinator does not narrow anyone else's
 * access.
 *
 * `Executive` (added for GM/COO-level logins) is the opposite kind of
 * narrowing from Coordinator: NOT in STAFF_ROLES (see rbac.js), so it is
 * denied every CRUD module by default — the same deny-by-default posture as
 * Worker/Staff, not an opt-out from an ever-growing role list. It is then
 * explicitly allow-listed, one route at a time, into read + decide access on
 * the request types the Configurable Approval Hierarchy actually routes to
 * senior leadership (Leave/Timesheet/SalaryAdvance/Reimbursement, the
 * Approval Log, and the company Dashboard) via `requireStaffOrExecutive`.
 * Real authorization for *deciding* any specific item still comes from
 * ApprovalRole membership exactly as it does for every other role — this
 * role only controls which doors an Executive login can reach, never what
 * they can do once through one. Before `Executive` existed, GM/COO/BDM/
 * Marketing-Manager/Finance-Manager logins had no narrower option than the
 * broad, CRUD-everywhere `Manager` role — seeing (and being able to edit)
 * the entire company's operational data was simply the only login shape on
 * offer, not a deliberate choice for those titles.
 *
 * `Operations` and `Viewer` were removed after P2-M2 — never had a real
 * account and weren't part of the intended role set going forward. IT is an
 * Employee.designation value, not a role — someone in that position logs in
 * as whichever of the roles above actually matches their system access
 * (typically HR, Accounts, or the self-service `Staff`).
 *
 * `Office Secretary` (added for the Mobilisation module's post-Coordinator
 * review stage) started narrow like `Executive` — excluded from
 * STAFF_ROLES, denied every CRUD module by default, reaching a specific
 * mobilisation only via ApprovalRole membership on its current workflow
 * step. Moved INTO STAFF_ROLES 2026-09-13 (see rbac.js's own doc comment
 * and docs/RBAC-notes.md) once a second real use case — self-marking her
 * own attendance — came up: full company-wide floor now, same as
 * Coordinator/HR/Manager/Accounts, gated the normal way by real Section
 * Access grants rather than being structurally unreachable.
 */
export const ROLES = [
  'Admin',
  'Manager',
  'HR',
  'Accounts',
  'Coordinator',
  'Executive',
  'Office Secretary',
  'Staff',
  'Worker',
];

/** Roles eligible to be an Employee's `manager` (Employee.manager / .coordinator's manager). */
export const MANAGER_ELIGIBLE_ROLES = ['Admin', 'Manager'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // lowercase + unique index: 'Ali@x.com' and 'ali@x.com' are one account.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // `select: false` — the hash NEVER leaves the DB unless a query opts in
    // with .select('+passwordHash'). Prevents accidentally serializing it.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    // Soft on/off switch: deactivate a leaver instead of deleting them, so
    // their audit history keeps pointing at a real user.
    isActive: { type: Boolean, default: true },
    // Self-service profile photo — a public Cloudinary URL, or null. Every
    // role can set their own; see auth.service.js updateAvatar/removeAvatar.
    avatarUrl: { type: String, default: null },
    // Links a login to its person record. Universal for every non-Admin
    // login (Own or Client Employee.type alike) — null only for Admin.
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    // Set on every password change/reset (self-service or Admin-initiated),
    // never on any other update (added 2026-09-14, a real QA-audit-found
    // gap): requireAuth compares this against an access token's own `iat`
    // claim and rejects a token issued before the last password change. A
    // reset previously only revoked refresh sessions — an already-issued
    // access token stayed valid until its own short expiry regardless, so
    // "reset because this credential is compromised" didn't actually
    // guarantee the credential stopped working immediately. `null` (no
    // password change on record yet, e.g. seed-admin's first run) never
    // rejects anything — see requireAuth's own comment on the null check.
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One employee ↔ at most one login. A plain `unique: true` would treat every
// staff user's `employee: null` as a colliding duplicate; the partial filter
// applies the constraint ONLY to documents where employee is an ObjectId, so
// unlimited staff can coexist with null while linked employees stay unique.
userSchema.index(
  { employee: 1 },
  { unique: true, partialFilterExpression: { employee: { $type: 'objectId' } } }
);

export default mongoose.model('User', userSchema);

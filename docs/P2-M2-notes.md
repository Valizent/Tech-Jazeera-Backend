# P2-M2 — Employee Self-Service portal, Coordinator hierarchy, Leave & configurable alerts

Built as one integrated change rather than four separate stops, because each
piece is the reason the next one is useful: a worker portal needs something
to *do* once logged in (leave), leave needs someone to route to (a
coordinator), and a coordinator needs to actually be able to get an account
(staff-user management) and see what needs attention (configurable alerts).
Still verified and documented as four distinct, separately-reviewable slices
— see the breakdown below.

## What was built

**Backend**
```
auth/user.model.js          # + 'Coordinator' role, + User.managedBy
employees/employee.model.js # + Employee.coordinator (ref User)
modules/users/               # NEW — staff-login provisioning (Admin only),
                              #   the prerequisite Coordinator needed: there
                              #   was no in-app way to create ANY staff login
                              #   before this (only the seed:admin CLI).
modules/me/                  # NEW — the ESS API surface: GET /me,
                              #   GET/download /me/documents, /me/leave (list,
                              #   submit, cancel). Every route resolves off
                              #   req.user.employee — no id in these URLs the
                              #   client could tamper with.
modules/leave/                # NEW — LeaveType (configurable policy) +
                              #   LeaveRequest (the eligibility engine)
employees/employee.service.js # + Coordinator-scoped listEmployees/getEmployee,
                              #   Manager's team=mine filter, coordinator
                              #   assignment validation
dashboard/dashboard.service.js # + thresholdDays override, Coordinator-scoped
                              #   expiringDocuments (every other figure stays
                              #   company-wide)
middleware/upload.js, documents/document.controller.js
                              # contentDisposition() extracted to
                              #   utils/contentDisposition.js — the /me file
                              #   route needed the exact same header logic
```

**Frontend**
```
app/layouts/EssLayout.jsx     # NEW — the Worker shell (3 links, not the
                              #   20-item admin sidebar with everything hidden)
app/router.jsx                # role-split: Worker → /me/*, everyone else →
                              #   the existing admin shell (+ /team, /leave)
features/auth/AuthContext.jsx # removed the P2-M1 "Worker has no web portal
                              #   yet" gate — it does now
features/ess/                 # NEW — MyProfilePage, MyDocumentsPage (+ preview
                              #   modal), MyLeavePage (submit + own history)
features/users/               # NEW — Team page: create staff logins
                              #   (reuses the P2-M1 one-time-password-reveal
                              #   pattern), deactivate/reactivate
features/leave/                # NEW — LeavePage: LeaveType config (Admin/
                              #   Manager) + the staff review queue (decide/
                              #   acknowledge)
features/employees/           # EmployeeForm: + Coordinator picker;
                              #   EmployeeListPage: + "My team" filter (Manager)
features/dashboard/           # ExpiringDocuments: + alert-window control,
                              #   persisted to localStorage per browser
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/users?role=` | Admin, Manager, HR | list staff logins |
| POST | `/api/users` | Admin | provision a staff login (any role but Worker) — returns `{ user, tempPassword }` once |
| PATCH | `/api/users/:id` | Admin | role / manager link / active status |
| GET | `/api/me` | Worker | own employee profile |
| GET | `/api/me/documents` , `/api/me/documents/:id/file` | Worker | own documents, own file bytes |
| GET/POST | `/api/me/leave` | Worker | own leave history / submit |
| PATCH | `/api/me/leave/:id/cancel` | Worker | cancel own future, undecided leave |
| GET | `/api/leave-types` | any authenticated | list (Worker needs this for the submit form) |
| POST/PATCH | `/api/leave-types` | Admin, Manager | configure policy |
| GET | `/api/leave` | any staff | review queue, Coordinator auto-scoped to their team |
| PATCH | `/api/leave/:id/decide` , `/acknowledge` | Admin, Manager, HR, Coordinator (own team) | approve/reject, or clear an auto-approved notice |
| GET `/api/employees` | +`team=mine`, `thresholdDays=` | — | Manager's team filter, alert-window override |
| GET `/api/dashboard` | +`thresholdDays=` | — | same override; Coordinator's `expiringDocuments` auto-scoped |

## Key decisions & why

- **Coordinator is scoped, everyone else is unchanged.** Admin/HR/Operations/
  Accounts/Viewer keep exactly the company-wide visibility they had before
  this milestone. Only the new `Coordinator` role is restricted by default
  (their own assigned employees). Manager keeps full visibility but gains an
  opt-in `team=mine` filter — retrofitting Manager into a restricted role
  would have broken an established workflow no one asked to change.
- **The eligibility engine is real, not a stub.** Three `LeaveType.recurrence`
  shapes — `Annual` (rising to a tier after N years, e.g. Saudi Labor Law's
  21→30 day pattern), `ContractCycle` (a one-time grant every N years, the
  "2-year contract → home leave" case), `Manual` (always reviewed) — are all
  computed server-side from the employee's real `joiningDate` and actual
  leave history, never trusted from the client, exactly like quotation
  totals. The computed eligibility is frozen onto the request at submission
  time so a later policy edit can't retroactively rewrite why a past request
  was decided the way it was.
- **Auto-approval is a notice, not silence.** An eligible request flips to
  `AutoApproved` immediately (entitlement is a right, computed correctly —
  it doesn't need a human gate), but it still lands in the coordinator's
  queue with an `acknowledgedByManager: false` flag they clear explicitly.
  Same idiom the app already uses for expiry alerts — a read-signal, not a
  new notification system.
- **A prerequisite the plan didn't call out: staff-user management didn't
  exist.** Before this milestone there was no way to create an Admin,
  Manager, HR, Operations, Accounts, or Viewer login from inside the app —
  only the `seed:admin` CLI script. Adding `Coordinator` without this would
  have shipped a role nobody could actually be granted through the product.
  The new Users module reuses the exact P2-M1 pattern (generated temp
  password, shown once, only its hash stored).
- **`GET /api/users` is Admin/Manager/HR, not Admin/Manager.** HR is in
  `EMPLOYEE_WRITE_ROLES` and assigns an employee's coordinator from the
  employee form — they need the Coordinator list to populate that picker.
  Caught during browser verification, not design.
- **Alert threshold is a client-side preference, not a new server setting.**
  `thresholdDays` is a query param with a request-scoped default
  (`EXPIRY_WARNING_DAYS = 30`), remembered in `localStorage` per browser.
  No new dependency, no email/push infrastructure — deliberately deferred;
  see "Deferred" below.
- **LeaveType has no delete endpoint, only `isActive`.** A `LeaveRequest`
  keeps a `leaveType` reference plus a `leaveTypeName` snapshot; deleting the
  type would either orphan the reference or (if cascaded) silently corrupt
  history. Same precedent as Employee's `status: 'Exited'` over hard delete.

## Deferred (deliberately, out of this milestone's scope)

- **Client-facing portal.** Everything here is the *employee/worker* side.
  The user's original idea also mentioned a client-company portal — that
  needs its own data model (client contacts aren't Employee records) and is
  Phase 3, not a P2-M2 add-on.
- **Email/push notifications.** The "notice" a coordinator/manager gets is
  in-app only (the review queue + the acknowledge flag). Real push
  notifications are a genuine new-dependency decision (an email provider) —
  not added without asking, per the project's hard rule against inventing
  infrastructure.
- **Coordinator scoping elsewhere.** Attendance, deployments, documents, and
  quotations are NOT scoped by coordinator — only Employees, Leave, and the
  dashboard's expiring-documents panel are. Extending it further is a
  reasonable future milestone, not assumed here.
- **Staff filing leave on behalf of an employee.** Only the linked Worker
  submits their own leave (`/api/me/leave`); staff review and decide but
  don't create requests for someone else in this pass.

## Common beginner mistakes (found during this build)

- **Async `<select>` options racing `react-hook-form`'s `defaultValues`.**
  The Coordinator picker on `EmployeeForm` loads its options from a
  `useQuery` that resolves *after* the form mounts. RHF applies
  `defaultValues` to the DOM `<select>` once, at mount — if the matching
  `<option>` doesn't exist yet, the browser silently falls back to the first
  option, and adding the right `<option>` later does **not** retroactively
  select it. Fixed with a `useEffect` that re-applies `setValue('coordinator',
  …)` once the options actually arrive. Caught only by checking the DOM's
  actual `<select>.value` in the browser — the page *looked* fine.
- **A new role needs a way to be created, not just a way to be checked.**
  Adding `Coordinator` to `ROLES` and writing the RBAC guards was the easy
  90%; the missing 10% (an actual admin UI to grant it) was found only by
  asking "how would someone actually get this role?" before writing UI code.

## Verified (2026-08-24)

**curl**, against a throwaway `Admin` + a real Coordinator/Worker/Employee
(all deleted after, DB left pristine — see cleanup below): staff-user create
→ tempPassword returned → Coordinator login works · Coordinator sees only
their assigned employee in `GET /employees` (403 on write) · dashboard 200
for Coordinator · Worker `GET /me` returns own profile with populated
coordinator · Worker `GET /employees` → 403 (still staff-only) · three leave
types (Annual/ContractCycle/Manual) created · submitted requests correctly
auto-approve (Annual: 5/21 days used-none; ContractCycle: exactly the
"2-year contract → home leave" case, 1 cycle completed) or route to review
(Manual, always) · overlapping request → 409 · Coordinator decides the
PendingReview one → Approved · acknowledges the AutoApproved one · Worker
cancels a future AutoApproved request → Cancelled, cancelling an
already-decided one → 400 · dashboard threshold override works, invalid
value (>365) correctly 400s.

**Browser** (`npm run dev`, real click-through, not just curl): staff login
→ dashboard renders with the new alert-window control · `/team` and `/leave`
render and are role-gated (Coordinator sees no LeaveType config panel) ·
Employee edit form's Coordinator picker — bug found and fixed (see above) —
now shows the correct pre-selected coordinator · Worker login → **redirects
straight to `/me`**, no admin sidebar ever mounts · My Documents empty state
· My Leave: submitted a real Annual Leave request through the form → toast →
AutoApproved → appears in history with a working Cancel button · logged in
as Coordinator → `/leave` correctly scoped to "Requests from your assigned
employees" with a "Mark as seen" button on the fresh AutoApproved request ·
console clean (only the pre-existing React Router future-flag warning and
the expected pre-login 401 from session-restore).

**Cleanup:** throwaway Admin/Coordinator/Worker accounts, the test employee,
all 4 test leave requests, and the 3 test leave types were all deleted
(exact counts confirmed via a one-off script, then the script itself
deleted — nothing committed). Audit-log rows recording these actions were
left in place, same policy as the security audit: tampering with the audit
trail is worse than a few test-attributed entries.

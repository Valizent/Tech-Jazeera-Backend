# Workforce model: Subcontracted employee type + Staff login role

A post-Phase-3 addition, prompted by real usage: the Attendance Records grid
showed zero worker rows because it (correctly) filtered on
`Employee.type: 'Client'` and every one of the 15 employees on file was
`type: 'Own'`. That surfaced a broader gap in conversation with the user
(voice-dictated, clarified over several rounds of `AskUserQuestion`): besides
the company's own on-site labour (`type: 'Client'`, already fully built) and
internal office staff reporting to a Manager (already fully supported via
`Employee.manager`), there's a third real relationship — a worker sourced
from an outside **Subcontractor** (their actual employer) and placed with a
client. And separately, office employees sometimes need a login for their
own self-service only, never the company-wide staff modules Coordinator/HR/
Manager/Accounts get.

## What was built

**Part 1 — `Employee.type: 'Subcontracted'`**

```
server/src/modules/employees/
  employee.model.js       # EMPLOYEE_TYPES += 'Subcontracted'; new
                            # WORKFORCE_TYPES = ['Client', 'Subcontracted'];
                            # requiredForWorkforce() replaces the old
                            # Client-only compliance-field gate; new
                            # `subcontractor` ref field (required only for
                            # Subcontracted, service-layer enforced)
  employee.validation.js  # subcontractor field + superRefine mirrors the
                            # model exactly; updateEmployeeSchema fix (below)
  employee.service.js     # assertValidSubcontractor(); Coordinator create
                            # branch only forces Own→Client, lets Client/
                            # Subcontracted through as submitted; populates
                            # subcontractor on read

server/src/modules/dashboard/dashboard.service.js
                          # Coordinator team scope + workforce counts now
                            # `type: { $in: WORKFORCE_TYPES }`; payroll-cost
                            # aggregate stays `type: 'Client'` only (deliberate)

client/src/lib/constants.js               # EMPLOYEE_TYPES, EMPLOYEE_TYPE_LABELS,
                                            # WORKFORCE_TYPES
client/src/features/employees/
  components/EmployeeForm.jsx             # label map, per-type helper text,
                                            # conditional Subcontractor picker
  employees.schema.js                     # mirrors the server superRefine
  pages/EmployeeListPage.jsx               # filter blank-option label
  pages/EmployeeProfilePage.jsx           # WorkerDeploymentPanel gate widened
                                            # to `type !== 'Own'`
client/src/features/attendance/components/RecordsGrid.jsx
                                            # drops the `type: 'Client'` query
                                            # param, filters `type !== 'Own'`
                                            # client-side instead
client/src/features/deployments/pages/DeploymentNewPage.jsx
                                            # same query/filter fix
```

Payroll (`payroll.service.js`) and the dashboard's payroll-cost aggregate
were deliberately left untouched — both stay `type: 'Client'` only, since a
Subcontracted worker's pay is the subcontractor's responsibility, never this
company's payroll. Attendance/Deployment/EOSB/Mobilisation needed no server
changes at all — all four were already type-agnostic (Attendance keys on the
employee id, Deployment's `assignWorker` has no type check, EOSB only needs
`joiningDate`+`salary`, Mobilisation's worker picker accepts any Employee).

**Part 2 — `Staff` login role**

```
server/src/modules/auth/user.model.js   # ROLES += 'Staff' (before 'Worker')
server/src/middleware/rbac.js           # STAFF_ROLES excludes both
                                          # 'Worker' and 'Staff' now
server/src/modules/me/me.routes.js      # requireRoles('Worker', 'Staff')
client/src/app/router.jsx               # RoleRouter/WorkerRouter check
                                          # SELF_SERVICE_ROLES = ['Worker','Staff']
client/src/lib/constants.js             # EMPLOYEE_LOGIN_ROLES += 'Staff'
```

`Staff` reuses the existing `/api/me` ESS portal verbatim — the exact same
mechanism `Worker` already uses — rather than carving a self-submit exception
into `requireStaff`. The staff self-submit routes Coordinator/HR/Manager/
Accounts use today are structurally fused to the same broad `requireStaff`
gate that also covers the company-wide review queues on those same routers
(in `timesheet.routes.js` it's a single router-wide `requireStaff`, not even
per-route) — giving `Staff` access to submit would mean giving it
`requireStaff` generally, which is exactly what "self-service only" rules
out. The ESS portal, by contrast, is gated by one literal `requireRoles`
check, completely independent of `requireStaff`/`STAFF_ROLES`, and its pages
are already written generically against "the logged-in employee," not
Worker-specific. Server-side `EMPLOYEE_LOGIN_ROLES` (in
`employee.validation.js`, which drives the login-provisioning endpoint's
allowed-role list) needed no change — it's derived as `ROLES.filter(r => r
!== 'Admin')`, so `Staff` was included automatically.

## Key decisions & why

- **A Coordinator's create request is only overridden when it says `'Own'`**,
  not force-set to `'Client'` unconditionally as before. A Coordinator still
  can't create internal-staff records, but can now choose either `'Client'`
  or `'Subcontracted'` for their own team — both are "their deployable
  team," just with a different employer of record.
- **`subcontractor` is a plain reference, not a snapshot**, matching the
  existing `coordinator`/`manager` convention on this model (populated on
  read, not duplicated) — unlike Mobilisation's own subcontractor field,
  which snapshots the name for durable history. The two live at different
  layers: an Employee's subcontractor link is an ongoing operational fact
  that should reflect the current record if the Subcontractor's name is
  corrected, while a Mobilisation is a point-in-time commercial record.
- **Salary stays gated on `type === 'Client'` only, not the new
  `requiredForWorkforce()`.** A Subcontracted worker's pay is set and paid by
  the subcontractor, never tracked in this company's Payroll — splitting the
  "compliance fields" gate (nationality/mobile/joining date, needed for
  attendance/visa tracking regardless of who employs them) from the
  "payroll fields" gate (salary, Client-only) was the crux of this feature.
- **The Salary field itself stays visible for every type**, only its
  required-asterisk is conditional — an existing pattern this form already
  used, left alone rather than hiding the field outright for Subcontracted
  (an admin can still record a reference number/estimate if useful; it's
  simply never required or paid through this app).

## A real bug found and fixed during verification

While curl-testing the Subcontracted work, a PATCH that only touched
`joiningDate` silently turned a test `'Own'` employee into `'Client'`.
Root cause: `employee.model.js`'s `type` field and `status` field both carry
Zod-level `.default('Client')` / `.default('Active')`, and
`updateEmployeeSchema` was derived as a blind `employeeObjectSchema.partial()`.
In Zod v4, `.partial()` only makes a field optional — it does **not** stop
`.default()` from firing when the key is omitted from the input. This file
had already hit this exact class of bug once before and fixed it correctly
for `weeklyOffDay` (see the `nullableWeekday` comment in
`employee.validation.js`: *"No `.default()` here on purpose... a Zod default
would silently reset every unrelated PATCH to Friday"*) — `type` and `status`
had simply never gotten the same treatment.

This wasn't introduced by this session's changes (the `.default()` calls
predate the Subcontracted work), but the new `Subcontracted` type made it
far more dangerous: any admin editing a Subcontracted employee's phone
number, notes, or any other unrelated field without resending `type` would
silently discard the `subcontractor` reference's *meaning* (the record would
still have `subcontractor` set, but `type` would read `'Client'`, and the
employee would incorrectly start appearing in Payroll). Fixed by
re-declaring `type` and `status` in `updateEmployeeSchema` without their
defaults:

```js
export const updateEmployeeSchema = employeeObjectSchema.partial().extend({
  type: z.enum(EMPLOYEE_TYPES).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
});
```

`createEmployeeSchema` (which still needs the defaults) was left untouched —
the fix only changes the derived update schema. Regression-tested directly:
a PATCH containing only `{ "designation": "..." }` now leaves `type`
unchanged, confirmed both via an isolated Zod script and against the live
API on a real test employee.

## Verified (2026-09-03)

**curl** (throwaway admin + throwaway Coordinator, deleted after):

- `Own` created with only `employeeId`/`fullName`/`type`/`designation` → 201,
  no compliance fields required.
- `Client` with no nationality/mobile/joiningDate/salary → 400, all four
  flagged. Same request but `type: 'Subcontracted'` → 400 flagging
  nationality/mobile/joiningDate/subcontractor, but **not** salary.
- A real Subcontractor created, then a full `Subcontracted` employee
  referencing it → 201, `salary` correctly never required. A fake/nonexistent
  subcontractor id → 400 ("Selected subcontractor is not valid.").
- `GET` the created Subcontracted employee → `subcontractor` populated as
  `{ _id, name }`, matching the existing `coordinator`/`manager` populate
  pattern.
- Coordinator-role token: submitting `type: 'Own'` → silently created as
  `'Client'` (unchanged behavior); submitting `type: 'Subcontracted'` with a
  real subcontractor id → created as `'Subcontracted'` (new, previously would
  have been force-set to `'Client'`).
- A payroll run created for the test month included only the two
  `'Client'`-type test employees — both `'Subcontracted'` test employees
  (including the one a Coordinator created) were correctly excluded.
- The `updateEmployeeSchema` bug above: reproduced, fixed, and
  regression-tested (see previous section).

**Browser** (throwaway admin, deleted after): the Add Employee form's Type
select showed all three real labels; switching to Subcontracted revealed a
"Select a subcontractor…" picker with accurate helper text and correctly
dropped the Salary field's required asterisk; switching to Own showed
"Nationality, mobile, joining date and salary are optional." with no
required asterisks on any of those fields. The Records grid and the
Deployment "Assign worker" picker both hit the API with no `type` query
param (confirmed via network inspection) and rendered their correct
zero-Client/Subcontracted-employees empty states against real production
data without error.

**Staff role** (throwaway Own-type employee + Staff login, deleted after):
provisioned via the existing employee login endpoint with `role: 'Staff'`;
logged in and landed on the ESS "My Workspace" shell (not the admin panel);
submitted a real Leave request through `/api/me/leave`, which appeared
correctly under "My Leave"; `/api/me/payslips` returned a clean empty list
(no payroll run had ever included the test employee) rendered as "No
payslips yet," not an error; direct navigation to `/employees` while logged
in as Staff redirected back to the ESS shell; `GET /api/employees` and
`GET /api/clients` with the Staff token both returned 403. `STAFF_ROLES`
confirmed (via a one-off script import) to be exactly `['Admin', 'Manager',
'HR', 'Accounts', 'Coordinator']` — Coordinator/HR/Manager/Accounts/Admin
access is completely unchanged.

**Cleanup**: every curl-created employee (`M1-*`, `M2-STAFF-1`), the test
Subcontractor, the test payroll run, the test Leave request, both throwaway
admins, the throwaway Coordinator, the Staff login and its refresh tokens,
and the browser throwaway admin were all removed by direct Mongoose scripts
after verification. No test data or scratch scripts remain in the repo.

## Not done / deliberately out of scope

- No `docs/PHASE*-PLAN.md` line item — like Mobilisation and Sick Pay, this
  is a post-Phase-3 addition prompted by real usage, not a planned milestone.
- Payroll and the dashboard's payroll-cost figure remain `Client`-only by
  design — extending them to Subcontracted workers would mean this company
  paying wages it has no obligation to pay.
- `Staff` gets no scoping beyond "self-service only" (no team-visibility
  concept, unlike Coordinator) — confirmed with the user as the intended
  scope; nothing was found that would need one.

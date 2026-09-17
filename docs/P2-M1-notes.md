# P2-M1 — Worker accounts & account linking

The foundation of Phase 2 self-service: give an `Employee` (workforce record) a
`User` (login), introduce the `Worker` role, and lock every existing admin
module so a Worker can't reach staff data. No worker-facing web UI yet — that's
the ESS portal in P2-M2. This milestone makes worker logins *exist* and *safe*.

## What was built

**Backend**
```
auth/user.model.js         # + 'Worker' role; + employee link; partial unique index
middleware/rbac.js         # + STAFF_ROLES + requireStaff (every role except Worker)
middleware/auth.js         # req.user now carries `employee` (linked record or null)
auth/auth.service.js       # + generateTempPassword() (readable, look-alike-free)
employees/employee.service.js   # + createEmployeeLogin(); getEmployee() adds `login`
employees/employee.controller.js # + createLogin (POST /:id/user)
employees/employee.validation.js # + createLoginSchema (optional email)
employees/employee.routes.js     # + provisioning route; requireStaff on the module
<7 module routers>         # requireStaff applied: employees, clients, deployments,
                           #   attendance, documents, quotations, dashboard
```

**Frontend**
```
features/employees/employees.api.js            # + createEmployeeLogin()
features/employees/components/WorkerLoginPanel.jsx  # admin-only Account card + reveal modal
features/employees/pages/EmployeeProfilePage.jsx    # renders the panel (Admin/HR only)
features/auth/AuthContext.jsx                  # web is staff-only: Worker login refused
features/auth/pages/LoginPage.jsx              # shows the gate message
lib/constants.js                               # + ACCOUNT_PROVISION_ROLES
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| POST | `/api/employees/:id/user` | Admin/HR | provision a Worker login; returns `{ user, tempPassword }` once |

Plus a behavioural change to **every** existing admin route: a `Worker` now gets
`403` (they were previously allowed to *read* via `requireAuth`). `GET
/api/employees/:id` responses now include a `login` summary (`null`, or
`{ id, email, role, isActive }`).

## Key decisions & why

- **`User` and `Employee` stay separate collections, linked by a reference.**
  Their lifecycles differ (an accountant is a `User` with no `Employee`; most
  deployed workers were `Employee`-only). P2-M1 just adds an optional
  `User.employee` pointer — references-over-embedding, exactly as Phase 1.
- **Partial unique index, not `unique: true`.** A plain unique index would treat
  every staff user's `employee: null` as a duplicate. The partial filter
  (`employee: { $type: 'objectId' }`) applies the one-employee-one-login rule
  *only* to linked users, letting unlimited staff keep `null`.
- **`requireStaff` is derived from `ROLES`, not hard-coded**, and mounted at the
  router level so it also covers the READ routes that ask only for
  `requireAuth` — precisely where a Worker would otherwise leak into
  company-wide data. A future staff role is included automatically; `Worker` is
  the single exception.
- **Temp password is generated, surfaced once, never stored or logged.** We
  never invent credentials (hard rule #4): the server generates a random
  14-char password from a look-alike-free alphabet (no `0/O`, `1/l/I`), returns
  it in the *response body* for the admin to hand over, stores only its bcrypt
  hash, and puts only the account's identity (not the password) in the audit
  log.
- **Provisioning lives on the employees router** (`POST /employees/:id/user`)
  because it's an employee-scoped workflow, but password mechanics
  (`hashPassword`, `generateTempPassword`) stay in `auth.service` — clean module
  ownership.
- **The web client is staff-only for now (an honest gate, not a stub).** A
  Worker's login *authenticates* server-side and gets real tokens — that's how
  the ESS portal will work in P2-M2 — but this SPA has no worker screens yet, so
  `AuthContext` refuses the session (at both login and session-restore) with a
  clear message rather than dropping them onto admin pages that 403.

## Deferred to P2-M2 (deliberately, per our no-dead-code rule)

The plan lists a reusable **ownership-guard middleware**
(`req.user.employee === resource.owner`) under M1. In M1 a Worker can't reach
any per-record route (they're 403'd everywhere by `requireStaff`), so that
middleware would have **no consumer** — which would be dead code. Its first real
consumers are M2's `/api/me/*` routes; it will be built there, "once, well".
`req.user.employee` (the anchor it compares against) is wired up now.

## Common beginner mistakes

- **`unique: true` on an optional link field.** The second `null` collides. Use
  a partial index scoped to non-null values.
- **Only guarding write routes.** The existing read routes used bare
  `requireAuth`; a new low-privilege role silently gains read access to
  everything unless you lock reads too. Verified: a Worker gets 403 on all seven
  modules.
- **Storing or logging the temp password.** Only the bcrypt hash is stored; the
  plaintext is returned once and never audited.
- **Letting the worker's web session linger after the gate.** `AuthContext.login`
  calls `logoutRequest()` to kill the just-created server session before showing
  the block, and session-restore drops any Worker cookie — otherwise a reload
  would loop the worker back in.

## Verified (2026-07-23)

**curl** (against throwaway test data, deleted afterward — DB left pristine):
admin login · create employee · **provision → tempPassword returned** · worker
logs in with it (role `Worker`) · worker **403 on all 7 modules** (employees,
clients, deployments, attendance, documents, quotations, dashboard) · worker
can't provision (403) · duplicate provision **409** · no-email employee **400** ·
admin-supplied email **201** · email-taken **409** · invalid email **400** ·
no-token **401** · `getEmployee` shows the `login` summary after provisioning.

**Browser:** Account card renders ("No login" → **Create worker login**) · click
→ **one-time modal** with email + temp password (Copy/Done) · card flips to
**"Login active · Worker"** · log out → worker login refused with *"Worker
accounts don't have web access yet…"* · no console errors.

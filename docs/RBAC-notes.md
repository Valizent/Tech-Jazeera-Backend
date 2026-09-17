# RBAC tightening: Leave/Holiday policy off Manager + a new Executive role

Prompted by the user reviewing their own real usage: "why does the Manager
have Leave Type configuration — that's the Admin's job." Pulling that thread
across the whole app surfaced a bigger pattern, not a one-off mistake:
`Manager` is the **only** fixed role broad enough to fit a BDM, GM, COO,
Marketing Manager, or Finance Manager — none of those titles exist as their
own `User.role`. Since `Manager` sits in nearly every module's write-role
array (Employees, Clients, Deployments, Quotations, Invoices, Expenses,
Assets, Documents, Payroll, EOSB…), anyone with one of those titles inherited
near-Admin-level company-wide CRUD by default, whether their actual job
needed it or not. This work does two things about it: moves genuine
*policy configuration* off Manager, and gives senior leadership (GM/COO) a
role shaped like what they actually do — see data, approve what's already
routed to them, touch nothing else.

## Part 1 — Leave Type & Holiday config: Admin/HR only

Small, mechanical, no new concepts:

```
server/src/modules/leave/leave.routes.js      # POST/PATCH /leave-types: Admin,Manager → Admin,HR
server/src/modules/holidays/holiday.routes.js # POST/PATCH/DELETE /: Admin,Manager,HR → Admin,HR
client/src/lib/constants.js                   # LEAVE_TYPE_MANAGE_ROLES, HOLIDAY_MANAGE_ROLES mirrored
```

Deciding a leave request (`LEAVE_DECIDE_ROLES`) is untouched — that's the
operational job a Manager/Coordinator actually does day to day. Only
*defining new leave categories and the company calendar* moved, since
neither is something an operational manager should need to invent.

## Part 2 — the `Executive` role

### The core design decision: deny-by-default, not opt-out

Every existing role except Worker/Staff is `STAFF_ROLES` — one array,
subtracted from `ROLES`, that every CRUD module's `router.use(requireStaff)`
trusts completely. That's exactly the mechanism that let Manager's access
grow unchecked: a module that forgets to narrow itself is wide open to
`STAFF_ROLES` by default. `Executive` deliberately inverts this:

- **Excluded from `STAFF_ROLES`** (`server/src/middleware/rbac.js`) — so
  every CRUD module rejects it with zero extra code, by construction. A
  future module that adds `router.use(requireStaff)` and forgets Executive
  entirely still does the right thing automatically.
- **Explicitly allow-listed**, one route at a time, via a new
  `requireStaffOrExecutive` — only where an Executive actually belongs:
  the Dashboard, and the list/submit/decide endpoints of Leave, Timesheet,
  Salary Advance, and Reimbursement (the four types the Configurable
  Approval Hierarchy governs), plus the Approval Log.

### Why letting Executive through those gates is still safe

`requireStaffOrExecutive` only answers "can this login knock on this door."
*What happens once they're in* is unchanged: `decideApprovalStep`
(`approvalEngine.service.js`) re-checks real `ApprovalRole` membership for
every single decide call, regardless of who cleared the router. An
Executive with no membership on a workflow's current step gets the exact
same 403 ("You are not an approver for the current step of this request.")
anyone else would — confirmed live against a real workflow during
verification (see below). This is what makes the router-wide `requireStaff`
→ `requireStaffOrExecutive` swap safe for Timesheet's whole router (which
also covers `/bulk-approve` and `/monthly-report`) without auditing every
sub-route individually: the real gate was never the router in the first
place.

Money-handling actions — advance repayments, marking a reimbursement paid,
downloading a receipt — deliberately keep their original
`Admin/Manager/HR/Accounts`-only gate (`canHandleMoney` in
`financialRequests.routes.js`). Deciding whether to approve something and
actually handling the cash it releases are different levels of access, and
Executive only ever gets the first one.

### What was deliberately left out of this pass

- **Mobilisation** — its whole router is one `router.use(requireStaff)`
  covering create/edit/decide together (no per-route split today), so
  giving Executive read+decide without also opening create/edit would need
  restructuring that router first. Not done here; a reasonable follow-up if
  Executive needs to sit in a Mobilisation approval chain.
- **Client decide** — never part of the Configurable Approval Hierarchy to
  begin with (hardcoded `Admin`/`Manager` only, no `ApprovalRole` check at
  all). Unrelated to this change; would need its own bespoke gate.

### The client side: an "opt-in" nav, not another `roles` filter

`DashboardLayout`'s sidebar (`navConfig.js` + `NAV_GROUPS`) treats a nav item
with no `roles` array as visible to *anyone* who reaches the shell — which
is exactly how a Manager ends up seeing almost the whole app. Adding
Executive to a `roles` array here and there would still leak every one of
those unguarded items (Clients, Deployments, Quotations, Documents, Assets,
Approval Log…) for free. Instead, `Sidebar()` (`DashboardLayout.jsx`)
special-cases `user.role === 'Executive'` entirely and renders a short, flat,
explicitly-defined list (`EXECUTIVE_NAV_ITEMS` in `navConfig.js`): Leave,
Timesheets, Financial Requests, Approval Log — no hub pages to drill into,
nothing to opt out of. `router.jsx`'s Worker/Staff-only `SELF_SERVICE_ROLES`
check needed no change — Executive was never in it, so it already falls
through to the normal `DashboardLayout` shell (not the ESS portal), which is
what makes company-wide Dashboard visibility work at all.

Each of the four pages Executive can reach behaves correctly with zero
page-level changes: `LeaveTypesPanel` is already gated by
`LEAVE_TYPE_MANAGE_ROLES` (Admin/HR, Executive excluded); the "submit your
own request" panels on Leave/Timesheet/Advance/Reimbursement are gated by
`user.role !== 'Admin'`, so Executive gets it (they're a real Employee, so
they can request their own leave — deliberately allowed, a person
self-referentially requesting isn't the CRUD/config access this change is
about restricting); `canDecideCurrentStep` (server-computed, per
`annotateCanDecide`) simply comes back `false` on every row until an Admin
actually puts them in an `ApprovalRole`, so no Approve/Reject buttons render
— matching "just sees data" until the org chart says otherwise.

### Provisioning an Executive login

`EMPLOYEE_LOGIN_ROLES` (`client/src/lib/constants.js`) now includes
`'Executive'`, so it's selectable from an Employee profile's login panel
exactly like Manager/HR/Accounts/Coordinator. Server-side
`EMPLOYEE_LOGIN_ROLES` (`employee.validation.js`) is derived from `ROLES`
automatically and needed no change.

## Part 3 — "are you sure?" on every decide action

`components/shared/ConfirmDialog.jsx` gained an optional `confirmVariant`
prop (default `'danger'`, so every existing delete-confirmation call site is
unaffected) — Approve now renders it as `'primary'` so the button doesn't
look like a destructive red action. Wired into all four review queues'
Approve/Reject buttons (Leave, Timesheet — including its bulk-approve
action, Salary Advance, Reimbursement), each with a specific message naming
the request being decided. This was a real, pre-existing gap: every decide
button fired its mutation immediately on click, for every role, with no
confirmation at all — not just an Executive-specific precaution.

## Verified (2026-09-05)

**Build**: `npm run build` clean, client and server syntax-checked.

**curl, live against real data** (throwaway Admin + a throwaway Executive +
a throwaway Manager, all deleted after): Executive got 403 on
`GET /employees` and `GET /clients` (deny-by-default confirmed) but 200 on
`GET /dashboard`, `GET /leave`, `GET /timesheets`,
`GET /financial-requests/{advances,reimbursements}` (the explicit allow-list
confirmed); 403 on `POST /financial-requests/advances/:id/repayments`,
`PATCH .../reimbursements/:id/pay`, and the receipt download (money-handling
correctly excluded). Executive successfully submitted their own leave
request into a real configured 3-step workflow (HR→BDM→Management), then
correctly got 403 ("You are not an approver for the current step of this
request") attempting to decide it themselves — proving the router-level
allow-list and the engine's real per-item authorization are independent
layers, not one relying on the other. Separately, Manager got 403 creating
a Leave Type and a Holiday (previously 201); Admin still succeeded at both.

**Browser** (same throwaway accounts): logged in as Executive — sidebar
showed exactly Dashboard/Leave/Timesheets/Financial Requests/Approval Log,
nothing else; the Leave page showed no Leave Types panel, showed the
"submit your own request" panel, and showed zero Approve/Reject buttons
(no ApprovalRole membership yet) on a page listing requests company-wide.
Logged in as Admin on the same data — clicking Approve on the Executive's
own pending request opened the confirmation dialog with the correct
specific wording and a primary-styled (not red) Approve button; Cancel
closed it without deciding anything.

**Cleanup**: every throwaway user (Admin/Executive/Manager), employee, leave
request, test leave type, and the real HR-role notifications the test
submissions generated were all removed after verification; no scratch
scripts remain in the repo.

## Not done / deliberately out of scope

- Mobilisation and Client decide flows (see "What was deliberately left out"
  above) — flagged as follow-ups, not silently dropped.
- No further role-splitting (separate BDM/Marketing-Manager/Finance-Manager
  roles) — the user's ask was specifically the Leave Type-style leakage and
  a GM/COO-shaped role; Manager's remaining operational access (Clients,
  Deployments, Quotations, Payroll, Invoices, Assets, deciding requests)
  was reviewed and judged genuinely needed, not further clutter.

## Follow-up (2026-09-13): Office Secretary moved from deny-by-default into the full staff floor

Found via a real user report while testing the new Section Access drill-down:
an Admin granted the "Office Secretary" Approval Role Write access on
"Attendance — Sign In/Out," logged in as the real Office Secretary account
(Riyaj Ansari) to check it, and saw only the Mobilisations nav item — no
Dashboard, no Attendance, nothing else, regardless of the grant.

Root cause, confirmed by reading the code, not guessing: `Office Secretary`
was two things sharing one name — a **login role**, deny-by-default since
its creation (excluded from `STAFF_ROLES` in `rbac.js`, denied every
company-wide module by design — built single-purpose for the Mobilisation
module's post-Coordinator review step, per `user.model.js`'s own doc
comment), and a separate **Approval Role** an Admin can name anyone into.
`canAccessSection`'s own floor checks `actor.role` FIRST — Office Secretary
(the login role) failed that check unconditionally, before her Approval
Role membership was ever even looked up. So the grant on the Attendance
card was genuinely inert for her: selecting "Office Secretary" as an
Approval Role member could never do anything for someone whose actual login
role was the deny-by-default one, no matter which Approval Roles they
belonged to. Her nav was the same story — a hardcoded, one-item flat list
(`OFFICE_SECRETARY_NAV_ITEMS` = Mobilisations only), completely independent
of any Section Access grant.

Put to the user directly, with the original narrow-by-design reasoning
explained first: keep her narrow and just fix the misleading pill, open a
small scoped exception for the one new use case, or move her into the full
staff floor like Coordinator/HR/Manager/Accounts. They chose the full floor.

**What changed:**
- `rbac.js`: `STAFF_ROLES` no longer excludes `'Office Secretary'` — she's
  now `ROLES.filter(role => !['Worker', 'Staff', 'Executive'].includes(role))`.
  This one change ripples correctly everywhere `STAFF_ROLES`/`requireStaff`/
  `requireStaffOrExecutive` is already used (Dashboard included — she'd
  never been allow-listed into `GET /api/dashboard` before, which is why
  `/` always 403'd for her and RoleRouter had to bounce her away from it).
- `requireStaffOrOfficeSecretary` removed — it was `requireRoles(...STAFF_ROLES,
  'Office Secretary')`, now identical to plain `requireStaff`. Its two real
  call sites (`deployment.routes.js`, `mobilisation.routes.js`) swapped to
  `requireStaff` directly.
- Client: `OFFICE_SECRETARY_NAV_ITEMS` removed; `DashboardLayout.jsx`'s
  Office-Secretary-specific branch removed, she now falls through to the
  same grouped-nav logic every other staff role uses (a group shows if she
  can reach at least one real item inside it — same mechanism, same
  Section-Access-driven visibility, nothing role-specific left). `router.jsx`'s
  `RoleRouter` no longer redirects her to `/mobilisations` — `/` and
  anything else she's actually granted now work like any other staff login.
- This grants her nothing by itself beyond ELIGIBILITY — actual visibility
  into any section still comes entirely from real Section Access grants,
  same as a freshly-created Coordinator with zero grants sees nothing
  either. The Attendance Sign-In/Out grant that started this now genuinely
  works: confirmed directly against her real account via `canAccessSection`
  before touching the UI.
- Deliberately **untouched**: every hardcoded, per-feature Office-Secretary
  business-logic exception in Mobilisation/Deployment (self-mobilise-for-a-
  busy-Coordinator, the monthly-hours-entry bypass, the step-0-reviewer
  Section-1-edit right, commercial-field stripping for step 0). These are
  business rules keyed to her login role for a specific, still-valid reason
  each, unrelated to the STAFF_ROLES floor question — none were
  short-circuited or made redundant by this change, so none were removed.
  `officeSecretaryBypass` on `RequireSectionRead` also stays — it covers a
  different, still-real gap (a hardcoded server-side read exception on
  Deployments that doesn't depend on her actual Section Access grant either
  way).

**Verified**: `STAFF_ROLES` confirmed to include her via a direct script
check; `canAccessSection('attendanceSignInOut', {role:'Office Secretary',
userId: <Riyaj's real id>}, 'write')` now returns `true` (was structurally
impossible before); a throwaway Office-Secretary-role account (zero
Employee link, zero Approval Role membership — the empty baseline) logged
into the real app in the browser: Dashboard loaded cleanly with no 403 and
no redirect, sidebar showed the normal grouped nav (Dashboard/Workforce/
Sales & Clients/Admin & Tools — Financial correctly absent, since nothing
inside it is reachable with zero grants), and Mobilisations still loaded
exactly as before. `node --check` on every touched server file; a clean
client build. Throwaway account fully removed afterward. A recurring,
already-documented environment gotcha (the local `node --watch` dev server
holding a stale Mongo connection after a burst of file edits — same
port-5000 issue CLAUDE.md's own environment notes describe) caused two
false "invalid password" scares during this verification; both resolved by
killing the stale process and restarting clean, unrelated to any code
change here.

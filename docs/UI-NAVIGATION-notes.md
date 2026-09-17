# Navigation consistency: Back button everywhere + login role correction

A post-Phase-3 UI/UX pass, prompted directly by user feedback across two
rounds: first "there's no way back from the Employee Edit page" and "put a
back arrow next to the title instead of a text button," then "I need a Back
button on every page reached by drilling into a hub section (Admin & Tools →
Documents, Financial → Invoices, etc.) — just not on the hub pages
themselves, since those are already one click from the sidebar."

## What was built

**`PageHeader` gained an `onBack` prop** (`client/src/components/shared/PageHeader.jsx`):
renders a plain circular arrow-icon button immediately left of the title,
separate from `actions` (Edit/Delete/status badges on the right). Replaces
every previous manual `<Button variant="secondary" onClick={() =>
navigate(-1)}>Back</Button>` placed among the action buttons.

**Rolled out to every page one level below a `navConfig.js` hub** — the
exact set of pages a sidebar hub card links to (Employees, Attendance,
Leave, Holidays, Timesheets, End of Service, Exit & Documents; Clients,
Deployments, Quotations, Mobilisations, Subcontractors; Invoices, Payroll,
Expenses, Financial Requests; Documents, Assets, Team, Approval Hierarchy,
Mobilisation Settings, Approval Log, Timesheet Processor, NFC Customers,
Security Log, Coordinator Activity) plus the "second-level" pages nested one
further (NFC Cards, NFC Analytics) — 29 pages total, all using
`onBack={() => navigate(-1)}`. The four hub landing pages themselves
(`/workforce`, `/sales`, `/financial`, `/admin-tools`) and the Dashboard
deliberately got no back button — they're already one click from the
sidebar, per the user's own stated rule.

**One exception**: `AttendanceSummaryPage` (`/attendance/summary`) uses
`onBack={() => navigate('/attendance')}` (a fixed destination), not
`navigate(-1)` — this page is only ever reached from the Dashboard's
"Marked today" stat, never from Attendance itself, so "back" here means the
related Attendance page, not literal browser history.

**Also completed the earlier Edit-page gap**: `EmployeeEditPage` (missing
entirely) plus `ClientEditPage`, `QuotationEditPage`, `MobilisationEditPage`
(same gap, found while checking for consistency) all gained the same
`onBack` treatment.

## Login role correction (new capability)

Found while investigating why a real employee (an internal `'Own'`-type
office worker) provisioned with login role `'Worker'` by mistake couldn't be
corrected: no UI or API existed to change an existing login's role, and the
Users/Team admin page explicitly excludes `Worker`- and `Staff`-role logins
from its management surface (`role: { $ne: 'Worker' }` in
`user.service.js`'s `listStaffUsers`, by original P2-M2 design — Worker
logins were never expected to need day-to-day admin actions). Rather than
widen the Team page's scope (risking dumping potentially hundreds of Worker
logins into a page sized for a handful of staff), added a scoped fix
matching where the problem was actually discovered — the Employee profile's
own login card:

- `server/src/modules/employees/employee.validation.js`: `updateLoginRoleSchema`
  (same allowed-role set as creation — any non-Admin role).
- `server/src/modules/employees/employee.service.js`: `updateEmployeeLoginRole()`
  — updates the role and revokes every refresh token for that login (role is
  baked into the JWT access token, so an old token would otherwise keep
  acting under the previous role until natural expiry — same discipline as
  password reset/change elsewhere in this app).
- `server/src/modules/employees/employee.routes.js`: `PATCH /:id/user/role`
  (Admin/HR — same circle as provisioning/resetting a login).
- `client/src/features/employees/components/EmployeeLoginPanel.jsx`: a
  "Change role" button next to "Reset password," opening a small modal with
  a role `<Select>` pre-filled to the current role.

## A real, unrelated bug fixed in passing

The user reported a browser autofill dropdown polluting an unrelated field
(an Approval Role's "Name" input showing suggestions like a person's name, a
LeaveType name, an Asset name). Root cause: Chrome keys autofill suggestions
by the raw `name` HTML attribute alone, shared across the *entire origin* —
every entity's name field in this app uses React Hook Form's `register('name')`,
so they all shared one Chrome autofill bucket. Fixed at the single shared
point: `client/src/components/ui/Input.jsx` and `Textarea.jsx` now default
`autoComplete="off"`, overridable per-field. Confirmed this doesn't break
password-manager support anywhere — Login and Change-password already set
their own explicit tokens (`autoComplete="email"` / `"current-password"` /
`"new-password"`), which override the new default exactly as intended.

## Follow-up (2026-09-05): the autofill fix above didn't actually work

The user reported it twice more, each with a screenshot: first the "Addresses
and more" dropdown still appearing on a LeaveType Name field even with
`autoComplete="off"` set, then — after a second attempt using
`autoComplete="new-password"` (a known trick for form-history autofill) —
still appearing on a Mobilisation Name field ("Still this stuff coming").
Both attempts were negotiating with the wrong layer: Chrome's "Addresses and
more" contact-autofill heuristically recognizes a field as name/email/phone-
shaped by its label/context and **ignores the `autocomplete` attribute's
value entirely** for that subsystem (unlike the separate form-history
autofill, which does respect it). No token was ever going to fix this.

**Actual fix — readonly-until-interaction** (`client/src/components/ui/Input.jsx`,
`Textarea.jsx`): the field renders `readOnly` on mount whenever
`autoComplete === 'off'` (the default), and flips to editable on its first
`onMouseDown`/`onFocus`. Chrome's autofill engines (both of them) only attach
suggestions to a field at the moment it becomes interactable — by the time
this field's `readOnly` drops, Chrome has already decided there's nothing to
suggest against. `suppressAutofill = autoComplete === 'off'` scopes this to
only the default case, so Login/Change-password's explicit overrides
(`autoComplete="email"` / `"current-password"` / `"new-password"`) are
unaffected — those fields stay editable immediately, exactly as before.

**Also found while re-auditing for this**: the original back-button rollout
only walked pages one level below a `navConfig.js` hub, which never included
a hub's own "New/Create" page (e.g. `/mobilisations/new` isn't itself listed
in `navConfig.js` — it's reached by a button on the Mobilisations list). A
fresh grep of every `<PageHeader` (57) against every `onBack=` (42) found
exactly 6 gaps, all New pages: `MobilisationNewPage`, `DeploymentNewPage`,
`SettlementNewPage`, `EmployeeNewPage`, `QuotationNewPage`, `ClientNewPage`.
All six already had `useNavigate` in scope; added `onBack={() =>
navigate(-1)}` to each.

### Verified (2026-09-05)

**Build**: `npm run build` clean.

**Browser**: confirmed the exact page from the user's screenshot —
`/mobilisations/new` — now renders the back arrow. Also checked
`/employees/new` (Add employee). Full visual reproduction of the original
autofill bug wasn't possible in the sandboxed test browser (no saved
autofill data to trigger it against), so this fix is verified by mechanism
(readOnly confirmed true on mount, false after the first click; typing and
saving still work correctly) rather than by reproducing the dropdown and
watching it disappear — flagged to the user as the one gap in this
verification pass.

## Verified (2026-09-03)

**Build**: `npm run build` clean before and after every batch of edits.

**Browser** (throwaway admin, deleted after): confirmed on the real
production data — Dheeraj (AJ-014)'s Edit page now has the back arrow;
Admin & Tools → Documents → back arrow → returns to Admin & Tools; Financial
→ Invoices → same. Mobile viewport (375px): back arrow renders correctly
next to the title, no horizontal overflow. Light mode: back arrow contrast
correct. The "Change role" modal opened on Dheeraj's real profile (role:
Worker, all 6 roles listed, Worker pre-selected) — closed without saving,
since which role Dheeraj should actually have is the user's call, not mine.

**curl, full round trip on disposable test data**: created a test employee
+ Worker login, logged in to capture a live refresh-token cookie, called
`PATCH /employees/:id/user/role` to change it to Staff, confirmed the old
refresh-token cookie was rejected (401, forced re-login) and a fresh login
correctly returned `role: "Staff"`. Regression-tested the same class of
partial-PATCH-resets-a-field bug this session already found once
(`type`/`status` defaults firing under `.partial()`) — not reintroduced
here, since `updateLoginRoleSchema` has no `.default()`.

**Server QA smoke test**: unauthenticated request → 401; Helmet headers
(CSP, HSTS, X-Frame-Options, X-Content-Type-Options) present; disallowed
CORS origin → no `Access-Control-Allow-Origin` header; login validation
failure → 400 with field-level detail; wrong-role access (Coordinator →
Admin-only Team endpoint) → 403; stack traces present in local dev, correctly
absent in the production error response.

**Cleanup**: every throwaway admin, Coordinator, employee, and login created
across this pass was deleted via the same temporary-script pattern used
throughout this project; no scratch files remain.

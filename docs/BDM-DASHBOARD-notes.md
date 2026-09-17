# BDM/Manager dashboard narrowing, attendance fixes, and two real bugs found

Prompted by the user reviewing the Manager (BDM job-title) dashboard and
attendance screens directly and flagging what didn't belong there.

## Dashboard — Manager-specific narrowing

`dashboard.service.js` gained a `hideFinance = isCoordinator || isManager`
flag alongside the existing Coordinator-only scoping:

- **Hidden for Manager**: Pipeline card (approved revenue/pipeline/monthly
  payroll), Profit card (revenue/payroll cost/expenses/net + 6-month
  trend), Recent Activity — all stay Admin/Executive territory (GM/COO/
  Marketing/Financial Manager all log in as `Executive` today).
- **"Pending quotations" becomes personal** for Manager — their own Draft
  quotations, not the company-wide Draft count. Required adding a real
  `createdBy` field to `Quotation` (was previously untracked entirely) —
  verified via a live API round-trip (create → check `createdBy` matches
  the actor → delete).
- **Unchanged for Manager**: Workforce by status, Quotations by status
  (counts, not $ figures), Expiring Documents, Quick Actions, the
  pendingClientApprovals banner.
- **New for everyone** (not Manager-only): a "Waiting on you" widget —
  real per-viewer counts across Leave/Timesheet/SalaryAdvance/
  Reimbursement/Mobilisation, computed via the same `annotateCanDecide`
  authorization check the review-queue pages already use (not a
  re-derived approximation), each linking straight to its module. Verified
  live: correctly showed a real pending Mobilisation to Admin, correctly
  hid it from a freshly-created Manager with no ApprovalRole membership
  (that Mobilisation's legacy fallback is `Admin`-only).

## Attendance

- **Manager can now self-mark attendance** — added to
  `STAFF_SELF_ATTENDANCE_ROLES` (was Coordinator/HR/Accounts only; Admin
  stays exempt by design). Verified live: a throwaway Manager login sees
  the Sign In/Out tab's punch card and can reach the "Sign in" action,
  which a Manager could not do before this fix.
- **"Missing employee" was not a bug** — Shamal Khalid N P (employee #13 of
  15, sorted by creation date) was simply on page 2 of the 10-per-page
  Employees list. No code change; confirmed via a direct DB query.
- **Native scrollbar bug, root-caused via computed styles, not guessing**:
  a small white up/down-arrow box kept appearing next to every page's tab
  bar (both the shared `Tabs.jsx` component and Attendance's own hand-
  rolled Records/Sign-In-Out/Office-Location bar). Two prior attempts at a
  fix (suppressing `type="date"` spin buttons) missed it because the real
  cause was structural: `overflow-x-auto` alone, per the CSS overflow
  spec, forces the OTHER axis's computed value to `auto` too — so a tab
  row that's even a sub-pixel taller than its own shrink-wrapped height
  (font hinting, zoom, OS DPI — all things a local headless browser won't
  reproduce identically to a real Windows Chrome install) grows a real
  native vertical scrollbar. Confirmed directly via
  `getComputedStyle(...).overflowY === 'auto'` on the exact element at the
  exact screenshot coordinates the user reported, on both tab bars. Fixed
  by adding `overflow-y-hidden` alongside `overflow-x-auto` in both
  `Tabs.jsx` and `AttendancePage.jsx`; re-confirmed `overflowY: 'hidden'`
  post-fix on both.

## Two real bugs found during verification (neither was the thing being tested)

- **Query cache leaked across logins in the same tab.** `AuthContext`'s
  `logout()`/`login()` never cleared TanStack Query's cache — since query
  keys aren't scoped by user id, a new login in the same browser tab could
  briefly render the PREVIOUS user's cached dashboard data (a Manager
  briefly saw an Admin-only "Waiting on you" entry that wasn't really
  theirs) until the background refetch replaced it. Fixed by calling
  `queryClient.clear()` in `login()`, `logout()`, the inactivity
  auto-logout, and the session-expired handler.
- **A crashed dev server produced a false negative during Section Access
  testing** — unrelated to the dashboard/attendance work, logged in
  `docs/SECTION-ACCESS-notes.md` (missing `asyncHandler` on
  `requireSectionAccess`).

## Verification

Three throwaway logins (Admin, a fresh Manager employee+login created via
the real Employee-creation + login-provisioning flow, and a second Manager
used for the attendance re-check), each cleaned up (including refresh
tokens and any StaffAttendance rows) after use. `npm run build` clean on
the client at each step; server restarted clean after every server-side
edit per this project's own documented `node --watch` gotcha (hit it twice
this session, including once mid-verification here).

## Follow-up (2026-09-13): hardcoded `isManager`/`isCoordinator` finance-hiding replaced with real Section Access read grants

The user's own instruction, part of a broader Section Access rework: "the
dashboard should reflect relevant data from whatever [read] access they
have... the dashboard should make sense." The `hideFinance = isCoordinator
|| isManager` rule this doc's own earlier work introduced had already
drifted out of sync with reality by this point in the project — a Manager
still saw Pipeline/Quotations on the dashboard even after losing
`quotationsManage`/`invoices` Section Access read in the same day's
login-role-removal migration (see `docs/SECTION-ACCESS-notes.md`) — and it
never applied to Executive at all, who saw full company financials on the
dashboard completely unconditionally, quietly contradicting Executive's own
carefully deny-by-default design from the RBAC-tightening work.

Replaced with real `canAccessSection(key, actor, 'read')` checks — the
exact same grant each figure's own module page is already gated by — for
every widget: Employees (workforce counts), Deployments, Clients,
Quotations, Payroll, Audit Log, Attendance, and Documents (one of two
independently-gated sources feeding Expiring Documents, the other being
Employees' identity-doc data). `profit` requires read on all three of
Invoices/Payroll/Expenses at once — the user's own explicit call, put to
them directly before building: a profit figure assembled from only some of
its real inputs would be an actual number meaning something else entirely,
worse than not showing it. Coordinator's existing TEAM-SCOPING (their
dashboard narrowed to their own employees/deployments/clients) is
unrelated to this and was left untouched — it's a data-scoping rule tied to
the real `Employee.coordinator` hierarchy, not an access-grant question;
only the "is this widget visible AT ALL" decision moved from a hardcoded
role check to a real grant check.

**Real, expected consequence, not a bug**: because most roles' current
real Section Access grants are narrower than the old hardcoded rule
assumed, several dashboards got noticeably sparser — a Coordinator with no
`employeeCreate`/`attendanceManage` read (true for the real Coordinators in
this company today) now sees neither their team's workforce counts nor
"marked today," which they always saw before; a Manager who's a member of
an org-chart Approval Role like "MM" or "FM" sees only what THAT role's own
grants cover, not a fixed Manager-shaped subset. This is the system working
exactly as asked — access is now centrally configurable from the Section
Access page (including its own new "Save all changes" button, see
`docs/SECTION-ACCESS-notes.md`'s own 2026-09-13 follow-up) — but worth
knowing before wondering where a widget went: grant the relevant section's
Read tier to restore it for a given role/person.

**Verified**: a script called `getDashboard()` directly for 4 real users
against their REAL, current Section Access grants (queried first, not
assumed) — Admin (everything visible), a Manager who is "MM" (Deployments/
Clients/Attendance visible via that role's real grants, Employees/Payroll/
Quotations/Profit/Audit correctly hidden), a real Coordinator (Deployments/
Clients visible and team-scoped, Employees/Attendance/Profit/Audit/
Quotations correctly hidden — a real, deliberate behavior change from
before), and a Manager who is "FM" (Payroll visible, but Profit still
correctly hidden since "FM" isn't granted Invoices read even though it has
Payroll+Expenses) — 26/26 checks passed exactly matching the real grants.
Browser: Admin's dashboard rendered fully populated (Pipeline, Profit,
both breakdowns, Recent Activity, Expiring Documents, Quick Actions); a
throwaway Manager with ZERO Approval Role memberships (the extreme case —
everything hidden) rendered with no crash, no console errors, and no
broken layout — just the header and an empty Expiring Documents panel,
exactly as designed. Both throwaway logins removed afterward.

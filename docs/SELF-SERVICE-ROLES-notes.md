# Worker and Staff roles in Section Access (2026-10-10)

The user's ask: add two roles, "Worker" (our own employees) and "Staff" (other
people who work for the company without being mobilised, e.g. a driver), to
Section Access so they can be given access to parts of the system.

## Before

Worker and Staff logins are self-service personas. They reach the employee
portal (`/api/me`) and nothing else: they could not be members of any approval
role (`SELF_SERVICE_ROLES` in `approvals.service.js`), Section Access ignored
them entirely (`canAccessSection` / `getMySectionAccess` returned nothing for
anyone outside the staff roles), and every staff router sat behind
`requireStaff`.

## What it is now (answers the user gave)

- **Two roles you fill by picking people.** "Worker" and "Staff" are ordinary
  approval roles (Approval Hierarchy page), created automatically at server
  start (`ensureSelfServiceRoles`) and flagged `allowsSelfService`. You choose
  which individual logins are in each (e.g. only Dheeraj). They are the only
  roles whose members may be Worker/Staff logins; every other role still
  refuses them.
- **A safe list of sections only** (`selfService.constants.js`,
  `SELF_SERVICE_GRANTABLE_KEYS`): Holidays, Assets, Documents, Attendance
  sign-in/out, Leave requests, Timesheet requests, Daily Updates (own, team),
  Requirements (own, team). Money, payroll-adjacent data, employee records,
  admin and every other section can never be reached by these roles, whatever
  is ticked: the grant is refused when saved (with the list in the message) and
  re-checked every time access is evaluated.
- **Read and Write both allowed** inside that list.

## How it works

- `canAccessSection` / `getMySectionAccess` let Worker/Staff logins through
  only for the safe-list keys, then evaluate role membership as for anyone.
- `requireStaffOrSelfServiceGrant(...keys)` (sectionAccess.middleware.js)
  replaces `requireStaff` on the five routers whose section is on the list
  (assets, attendance, documents, daily updates, requirements). A self-service
  login passes only with Read on one of the router's keys; each route's own
  `requireSectionAccess` still decides what it may do. Leave, Timesheets and
  Holidays had no `requireStaff` floor, so they work through the change above.
- Web: a granted Worker/Staff login still lands on `/me`; the portal sidebar
  gains a "Workspace" link per module group, and the staff shell shows only
  their granted modules plus a "My portal" link (the dashboard is staff-only).
  The Section Access page offers the Worker/Staff pills only on safe-list
  sections; the role editor shows Worker and Staff logins for these two roles.
- Phone app: More lists the granted modules; they open the normal staff screens.

## Things to know

- Documents Read exposes the whole Documents module to whoever is in the role
  (it was on the safe list by the user's choice). Add people deliberately.
- Daily Updates / Requirements "own" workspaces still belong to Coordinator
  logins by design, so for a Worker/Staff the useful grant there is the "team"
  oversight key; ticking "own" opens the module but an own board needs a
  coordinator identity.
- A reserved role can be deactivated (grants stop at once) but not renamed.

## User action

Approval Hierarchy -> open "Worker" / "Staff" and choose the logins. Then
Section Access -> grant the roles on the sections they should see. Do the
same on staging and production (roles are created automatically, grants are
per database).

## Verified

15 server test files (85 tests), including `selfServiceRoles.test.js`.
Against the dev database with throwaway logins: a Staff login with Assets Read
got 200 on assets and 403 on documents, employees, EOSB, dashboard, users and
Section Access; a Worker login with Holidays Write was refused everywhere else.
Browser: the Staff login lands on the portal, sees only the Assets tile,
opens the assets list, and is refused `/employees`; the Admin sees the Worker
and Staff pills only on safe sections. Everything restored afterwards
(role members, both grant documents, counters, no notifications).

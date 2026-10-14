# Annual Vacation (2026-10-10)

Built from the half-finished endpoint the 6 October audit flagged (V2-S01 and
V2-F09). The old `POST /api/financial-requests/annual-vacation` accepted a
request but had no review queue, no decision step and no screen, and its
ownership check compared fields that do not exist. It is gone; this is the
replacement, on web, server and the phone app.

## What it is

An employee asks for annual vacation once a contract period has ended: first
day + number of days (1 to 90), optional reason. The end date is derived
server-side (inclusive calendar days, the same counting Leave uses).

Eligibility (unchanged from the original endpoint): the employee has a
contract end date and it has passed, or the contract was renewed (current
contract started more than 30 days after joining). An exited employee cannot
file. Also refused: a start date in the past, a second request while one is
still pending, and dates that overlap existing leave or another vacation.

## Approval

Runs through the Configurable Approval Hierarchy engine
(`approvals/approvalEngine.service.js`), request type `AnnualVacation`
(already in `APPROVAL_REQUEST_TYPES`; now also in the web/mobile constants so
Approval Hierarchy can route it). No workflow = the original single-level
decision by Admin/Manager/HR; with a workflow, step-by-step by role membership.

**Final approval records an approved leave.** The engine's new `onApproved`
hook creates an approved `LeaveRequest` (leave type "Annual Vacation",
recurrence Manual, created on first use) and stores it as `linkedLeaveRequest`,
so attendance and Leave show the employee as on leave. If that fails (e.g. leave
was filed over the same dates meanwhile) the approval is reverted to pending and
the reviewer sees a 409 — nobody is told "approved" for something that did not
complete. Same pattern Mobilisation uses for its Deployment.

## Who can do what

| Action | Who |
|---|---|
| File for yourself | any login with a linked employee: Worker/Staff via `/api/me/annual-vacation`, any staff login via `POST /api/annual-vacation` (no grant) |
| File for someone else | Section Access `annualVacation` **Write** + Coordinator team scope |
| See the review queue | Section Access `annualVacation` **Read** |
| Approve / reject | Section Access `annualVacation` **Write**, then the engine's step authority |
| Cancel | the employee, while still pending |

New Section Access key `annualVacation` (Workforce → Annual Vacation). Admin
only until an admin ticks roles on the Section Access page — see "User action".

## Endpoints

- `GET /api/annual-vacation` queue (Read) · `POST /api/annual-vacation` file ·
  `GET /api/annual-vacation/mine` · `PATCH /api/annual-vacation/:id/cancel` ·
  `PATCH /api/annual-vacation/:id/decide`
- ESS: `GET|POST /api/me/annual-vacation`, `PATCH /api/me/annual-vacation/:id/cancel`

Also wired in: the Approval Log, the dashboard's "Waiting on you" counts, and
notifications (reviewers on submit, the employee on the decision).

## Screens

- Web: `/annual-vacation` (tabs: Requests / File a request / My requests),
  `/me/annual-vacation` for Worker/Staff. English and Arabic.
- Phone app: `annual-vacation` (staff) and `me/annual-vacation` (self-service).

## User action still needed

Tick the roles that should use it on **Section Access → Workforce → Annual
Vacation**: Read for whoever sees the queue (HR, managers), Write for whoever
files for others and decides. This lives in each database, so do it on staging
and production too. To route it through an approval chain, add a workflow for
request type "Annual Vacation" on the Approval Hierarchy page.

## Verified

Service tests (`annualVacation.service.test.js`, 11): eligibility, the
ownership guard, overlap rules, cancel, approve records the leave and
notifies, reject records nothing, the revert-on-conflict path. Browser
click-through on the web against the dev database with throwaway data:
Worker files in the ESS portal, Admin reviews in the queue (approval trail
shown), approves, the approved leave is recorded, Admin files on behalf of a
login-less employee, Arabic/RTL renders. Everything cleaned up (counters
unchanged, no notification left for a real user).

## 2026-10-14: contract days, Accounts' tickets and re-entry visa, FM, and who is told

**Flow (all configured in Approval Hierarchy, nothing hard-coded to a role name):**
HR (duty `HrReview`) -> Accounts (duty `TravelDocuments`) -> FM (ordinary last step). The workflow's `notifyRoles` ("Told, not asked") hear about it at submission and at approval.

- **Days:** `Employee.annualVacationDays` (HR, 1-90). The request's `requestedDays` always starts from it (a client-sent value is ignored; no value on the record = request refused). `contractDays` snapshots it on the request. At the HR step `PATCH /api/annual-vacation/:id/days` changes the days for that one request and records `daysChange {from, to, note, by, at}`; the end date and the overlap check are re-run.
- **Accounts step:** `POST /api/annual-vacation/:id/tickets` (files + `travelDate`; travel day on or before the last vacation day) attaches tickets and raises one `ExitReentryRequest` (Single, status Approved, `annualVacation` back-link) from the travel day to travel day + vacation days (vacation days + 1 days counting the travel day). `POST /api/annual-vacation/:id/visa` uploads the issued visa document (+ optional reference), marking that request Issued. When tickets and visa are both in, the step is approved by itself on behalf of whoever finished; approving it by hand before then is refused. Both need "Can change" on Annual Vacation and membership of the step's roles (Admin overrides).
- **Approval:** FM's approval records the leave as before, links the visa request to it, and informs the roles.
- **Reading:** `GET /api/annual-vacation/:id/tickets/:fileId/file` and `.../visa/file` for the employee's own request or any reader of the section (Coordinators team-scoped); `/api/me/...` for Worker/Staff. Storage ids never leave the server.
- **Setup in production (toggles only):** Approval Hierarchy: a workflow with the three steps and the duties, "Told" = Marketing Manager role, default for Annual Vacation; a second one with FM as "Told" routed for the Accounts department. Section Access: Annual Vacation "Can change" = HR, Accounts and FM roles. Employees: HR fills in the contract days.

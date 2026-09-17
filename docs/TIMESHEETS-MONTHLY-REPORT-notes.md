# Timesheets: killed the weekly submit/review workflow, replaced with a real Monthly Report browser

## What changed

The old Timesheets page had three tabs: Requests (the P2-M3b approval queue),
Submit Timesheet (a staff member submitting their own week), and Monthly
Report (a bare employee dropdown + a blind `.xlsx` download button, no
on-screen preview). Per the user's own instruction, Requests and Submit are
gone from the client entirely; Monthly Report became the whole page — a real
list → view → export flow:

- **List**: every `'Own'`-type employee (internal staff — Coordinator/HR/
  Manager/Accounts). A deployed/mobilised field worker (`Outsourced`/
  `Subcontracted`) is deliberately excluded — they already have their own
  timesheet on the Deployment record's monthly-hours ledger, a completely
  separate, untouched feature.
- **Detail**: pick a month/year, see every day — a real punch always wins;
  otherwise Holiday, then the employee's own `weeklyOffDay` (e.g. Friday) —
  with a "Single Punch" day (signed in, never signed out) called out in its
  own color (`danger`, shared with `Absent` — the badge's own text still
  disambiguates the two at a glance) rather than folded into the generic
  "Deficient" color. Export as `.xlsx` from the same view, same visual
  format the Timesheet Processor's device-import export already uses —
  PDF export is a deliberately later step, per the user's own "for now,
  Excel" instruction.

## The real technical wrinkle this surfaced

`buildMonthlyAttendanceReport` (in `monthlyReport.service.js`) already
existed and already did almost everything asked — weekly-off/holiday
inference, single-punch detection, the shared `.xlsx` renderer — but it only
ever read from the Employee-keyed `Attendance` collection. An `'Own'`-type
employee never gets an Attendance record at all: they self-punch through the
separate, User-keyed `StaffAttendance` collection instead (see
`staffAttendance.model.js`'s own doc comment on why it's kept separate —
"can never skew Active Workers, Monthly Payroll, or any workforce report").
Since the new list is `'Own'`-type only, building the report unchanged would
have shown "No Attendance" for literally everyone, every day.

Fixed by having `buildMonthlyAttendanceReport` branch its data source on
`employee.type`: `'Own'` → find the linked `User` (`User.findOne({employee})`)
→ query `StaffAttendance` by that user id; anything else → the original
Employee-based `Attendance` query, unchanged. No change to the day-by-day
classification loop itself — a `StaffAttendance` record has no `status`
field at all (no Absent/Leave/Sick concept for a self-punch; those go
through the Leave module entirely), so `record.status === 'Leave'` etc.
simply evaluate false for it and fall through to the same Present/Single
Punch/Overtime/Deficient branch that already existed, unmodified. Verified
directly against real data: Sarmad Shabir (a real Coordinator) has zero
Employee-based Attendance docs and exactly one real `StaffAttendance` record
(a Sep 8 check-in with no check-out) — the new report correctly shows that
exact day as "Single Punch" at 08:04 Riyadh time, every other day correctly
"No Attendance," Fridays "Off," and the real company holiday on the 23rd —
and does so via the new source path, confirmed by directly querying both
collections to rule out a coincidental match against a leftover Attendance
record.

## New endpoint, not a new page's worth of backend

The old client only ever POSTed straight to a blob-download endpoint — there
was no way to preview the data first. Added `GET /api/timesheets/monthly-
report` (same query shape, same eligibility floor — Admin or a real Approval
Role member, the same dynamic "sits somewhere in the hierarchy" check the
Approval Log uses) returning the JSON `buildMonthlyAttendanceReport` result
for the on-screen grid; the existing `POST` (same path, `.xlsx` blob) is
untouched and still does the export. Both share one `assertReportEligible`
helper now instead of the same three-line check being duplicated.

## What was deliberately NOT touched — and the real consequence

The underlying server-side Timesheet **model**, **service**
(`timesheet.service.js`'s submit/decide/bulk-approve/overtime computation),
and **routes** (`/api/timesheets` POST/`:id/decide`/`bulk-approve`) are
still there, byte-for-byte. Only the client UI/API-client glue that used to
call them was removed (`ReviewQueue`, `SubmitTimesheetPanel`, and their
`timesheets.api.js` wrappers — confirmed zero other consumers before
deleting). This was a deliberate, narrower cut than deleting the whole
subsystem, for one specific reason: **P3-E's real overtime pay calculation
in Payroll is computed from an APPROVED Timesheet record** — ripping out the
model/service too would have broken Payroll's overtime figure immediately
and irreversibly, in the same response, with no chance to plan around it.

The real, unavoidable consequence of removing the UI alone: nothing in this
app can generate a NEW Timesheet record anymore (no Submit button exists,
no Requests queue to approve one even if it existed). Historical data and
Payroll runs already computed are untouched, but **going forward, Payroll's
overtime component will stay at whatever it last was — effectively zero for
any future pay period** unless a follow-up decision is made about where
overtime should be sourced from instead. This was surfaced to the user
directly before building (the question they answered explicitly named this
consequence) — flagged here as the standing open item, not silently patched
over. A worker's own ESS timesheet submission (`features/ess/ess.api.js`,
`/api/me/timesheets`) is a completely separate flow and is untouched by any
of this.

The `ApprovalWorkflow` engine's `'Timesheet'` request type, and
`TIMESHEET_STATUSES`/`TIMESHEET_STATUS_VARIANT` (still used by the Worker
ESS's own timesheet status display), were left exactly as they were for the
same reason — no reason to touch what Payroll and the Worker ESS still
depend on until the overtime-sourcing decision is made.

## Small, incidental fixes made along the way

- `Badge.jsx` now spreads `...rest` onto its rendered `<span>` (e.g. `title`
  for a tooltip) — previously any prop besides `variant`/`className`/
  `children` was silently dropped. Purely additive; no existing caller is
  affected.
- `TIMESHEET_DECIDE_ROLES` (client `constants.js`) removed — a pre-existing
  orphan with zero consumers even before this change, noticed while working
  in the same file.
- A real, unrelated environment issue found and fixed during verification:
  the locally running dev server (`node --watch`) had been alive long enough
  that its in-memory Mongo connection had drifted from what `.env` currently
  points to — every login attempt 401'd with a *correct* password (confirmed
  by comparing the hash directly, bypassing HTTP entirely). Killing the
  stale process and restarting cleanly fixed it — the exact, already-
  documented port-5000 gotcha in `CLAUDE.md`'s own environment notes, not a
  new bug.

## Verification

`node --check` on every touched server file; a clean `npm run build` on the
client. Browser, logged in as a throwaway Admin: employee list showed all 15
real `'Own'`-type staff; opened Sarmad Shabir's September report and
confirmed every cell against a direct DB read of his real `StaffAttendance`
history (one real single-punch day, everything else correctly "No
Attendance," Fridays "Off," the real company holiday inferred) with zero
Employee-based Attendance docs in play at all; confirmed the Single Punch
badge renders in the distinct `danger` color with a tooltip explaining what
it means; triggered the `.xlsx` export and confirmed the server returns
`200` from the same underlying builder. Throwaway admin (login, refresh
tokens, audit rows) fully removed afterward. An unrelated 400 found and
fixed live during this same pass: the new employee-list query asked for
`limit: 200`, above the server's own `listEmployeesSchema` cap of 100.

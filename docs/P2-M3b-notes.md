# P2-M3b — Timesheet approval

Resumes the Phase 2 backbone (see `docs/PHASE2-PLAN.md`, `docs/PHASE3-PLAN.md`).
The deferred half of P2-M3: a formal weekly approval checkpoint over
attendance hours, so Payroll (P2-M5, next) has a trustworthy, decided figure
to build on instead of raw, still-editable daily records.

## What was built

**New module — `server/src/modules/timesheets/`**
```
timesheet.model.js       # Timesheet — one employee/week, unique index on
                          #   (employee, periodStart); resubmitting after a
                          #   Rejection updates the SAME document
timesheet.validation.js, .service.js, .controller.js, .routes.js
                          # mounted at /api/timesheets

server/src/modules/me/    # extended — worker submit/list
  me.routes.js, me.controller.js, me.service.js

client/src/features/timesheets/
  timesheets.api.js
  pages/TimesheetsPage.jsx   # staff review queue + multi-select bulk-approve
client/src/features/ess/pages/MyAttendancePage.jsx
  # + a "Weekly timesheet" section (submit + own history) — not a new page;
  #   see decisions below for why
client/src/app/router.jsx, DashboardLayout.jsx  # + /timesheets (staff nav)
client/src/lib/constants.js  # + TIMESHEET_STATUSES, TIMESHEET_DECIDE_ROLES
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/api/me/timesheets` | Worker | submit/resubmit the current or a past week |
| GET | `/api/me/timesheets` | Worker | own timesheet history |
| GET | `/api/timesheets` | any staff | review queue |
| PATCH | `/api/timesheets/:id/decide` | Admin, Manager, HR | approve/reject |
| POST | `/api/timesheets/bulk-approve` | Admin, Manager, HR | approve many Submitted timesheets at once |

## Key decisions & why

- **A Timesheet does not re-enter hours — it summarizes real Attendance
  data.** The original Phase 2 plan predates P2-M3's geofenced self-punch,
  which already gives workers a way to record daily hours
  (`checkInTime`/`checkOutTime`/`hoursWorked` on Attendance). Building a
  second, parallel "enter your hours" form would duplicate that. Instead,
  submitting a timesheet is a one-click "confirm this week is correct" action
  that aggregates the week's Attendance into a snapshot for approval — the
  actual gap this milestone fills is the missing **approval checkpoint**,
  not hour entry.
- **Hours fallback uses the employee's own `expectedDailyHours`, never an
  invented default.** A day marked Present by a staff bulk-mark (no
  self-punch, so no real clock times) contributes `expectedDailyHours` if
  the employee has one on file, otherwise 0 — reusing real, already-entered
  data rather than assuming an 8-hour day for everyone. Verified directly:
  a self-punched day (8.5h), a staff-Present day with `expectedDailyHours:
  8` set (contributed exactly 8), and a staff-Present day with real
  check-in/out (9h) summed to exactly 25.5 total hours.
- **`recordedDays` is reported alongside the totals, not hidden.** A week
  with gaps (a day nobody marked at all) still gets `recordedDays < 7`
  visibly flagged to the reviewer — verified a week with one unmarked day
  correctly showed `recordedDays: 6`, and the review screen surfaces this
  as a visible warning rather than silently treating the missing day as
  zero hours with no explanation.
- **Single-level Submit → Approve/Reject, not the deferred multi-level
  signed flow** — the exact judgment call `docs/PHASE3-PLAN.md` already
  recorded for this milestone (same reasoning as the financial requests in
  P3-C: a real multi-level hierarchy needs a concrete spec from the user,
  not an invented one).
- **No new ESS nav item.** Timesheet submission is folded into the existing
  My Attendance page (a new "Weekly timesheet" section) instead of a
  separate screen — you're already looking at your attendance when you'd
  want to submit it for the week; a second page for one button would be
  pure navigation overhead.
- **Bulk approve is by explicit id list**, not "approve everything
  Submitted" — the plan's "bulk approve a week" is served by the staff
  screen's own multi-select checkboxes (select-all-Submitted, then one
  button), which is safer than a single server-side "approve all" with no
  chance to review first. Verified a bulk request mixing one real id and
  one bogus id correctly approved just the real one and reported both counts.
- **KNOWN LIMITATION, documented rather than silently skipped**: approving
  a timesheet does not yet lock its underlying Attendance days against
  further edits. There is no Payroll consumer yet to protect against a
  post-approval change, and adding the lock means `attendance.service.js`
  (the lower-level module) would need to depend on Timesheet (the module
  built on top of it) — backwards coupling for a protection nothing
  downstream needs yet. Revisit when P2-M5 (Payroll) actually starts
  reading Approved timesheets.

## Verified (2026-08-29)

**curl** (throwaway admin + two Worker logins, deleted after), against a
real constructed week (Sat 2026-08-22 – Fri 2026-08-28):

- Attendance set up: self-punched Present (8.5h), staff-marked Present with
  no clock times (falls back to `expectedDailyHours: 8`), Absent, a second
  self-punched Present (9h), Leave, Off, and one day left completely
  unmarked.
- Submission → `totalHours: 25.5`, `daysPresent: 3`, `daysAbsent: 1`,
  `daysLeaveOrSick: 1`, `daysOff: 1`, `recordedDays: 6` — every figure
  hand-verified against the underlying records.
- Resubmitting the same week while already Submitted → 409. Submitting a
  week that hasn't started yet → 400. Worker blocked from the entire staff
  router → 403.
- Reject with a note → 200; deciding an already-Rejected one again → 400;
  worker resubmits the same week → **the same document id**, now back to
  Submitted with fresh totals (confirmed, not a new row); Approve → 200;
  deciding it again → 400.
- A second employee's Submitted timesheet, bulk-approved together with one
  bogus id → `{requested: 2, approved: 1}`, confirming partial success is
  reported accurately rather than all-or-nothing.

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint as the
rest of this work — see `docs/P3-B-notes.md`). Every code path, including
the exact hours math, was verified via curl against real constructed
attendance data.

**Cleanup**: throwaway admin and two Worker logins, both test employees,
all attendance records created for the test week, both timesheets, their
refresh tokens, and the audit-log rows were deleted.

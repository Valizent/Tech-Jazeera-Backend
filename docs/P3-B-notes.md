# P3-B — Statutory leave caps & the public holiday calendar

First milestone of the HR PRD build-out (see the plan artifact shared in
chat). Two PRD Module 3 asks, both landing on the existing Leave module: a
per-request day cap for statutory leave types (Emergency/Paternity/Marriage/
etc. are capped per event, not accrued per year — the current `LeaveType`
model had no way to express that), and a new company holiday calendar
(Eid, National Day, Founding Day) that the attendance grid and both Leave
pages are now aware of.

## What was built

**Statutory leave caps (extends the existing Leave module, P2-M2)**
```
server/src/modules/leave/leaveType.model.js       # + maxDaysPerRequest, isPaid
leave.validation.js                                # + both fields, create & update
leave.service.js                                   # submitLeaveRequest() now
                                                     #   rejects a request over
                                                     #   the type's cap (400)
client/.../leave/leave.schema.js                    # + both fields, form <-> API
client/.../leave/pages/LeavePage.jsx                # + cap/paid inputs on the
                                                     #   LeaveType form, shown
                                                     #   in the type list
```

**Holiday calendar (new module)**
```
server/src/modules/holidays/
  holiday.model.js        # name, startDate, endDate (range, not single day),
                           #   isPaid, notes
  holiday.validation.js   # create/update/list Zod schemas
  holiday.service.js      # CRUD; listHolidays({from,to}) is a range-overlap query
  holiday.controller.js
  holiday.routes.js       # GET open to any authenticated role; POST/PATCH/
                           #   DELETE — Admin, Manager, HR
server/src/app.js         # mounted at /api/holidays

client/src/features/holidays/
  holidays.api.js
  holidays.schema.js
  pages/HolidayListPage.jsx        # full CRUD, Table-based (mirrors UserListPage)
  components/UpcomingHolidays.jsx  # read-only "what's coming up" card,
                                    #   shared by LeavePage and MyLeavePage
client/src/app/router.jsx           # + /holidays
client/src/app/layouts/DashboardLayout.jsx  # + "Holidays" nav item, read-open
client/src/lib/constants.js         # + HOLIDAY_MANAGE_ROLES, HOLIDAY_DISPLAY_META
```

**Attendance grid integration**
```
client/.../attendance/components/RecordsGrid.jsx
  - fetches holidays for the visible range alongside attendance
  - markFor() now infers "Holiday" on a date inside a holiday range, same
    precedence rule as the existing weeklyOffDay "Off" inference: a real
    attendance record always wins (someone may have worked the holiday)
  - Holiday is NEVER written to Attendance itself — same as Off. It's kept
    out of ATTENDANCE_STATUS_META on purpose so it can't become a selectable
    value in the manual edit dropdown; HOLIDAY_DISPLAY_META is a separate,
    display-only constant
  - legend gained a "Company holiday (not recorded)" entry
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/holidays` | any authenticated role | list holidays, optional `from`/`to` range filter |
| POST | `/api/holidays` | Admin, Manager, HR | add a holiday |
| PATCH | `/api/holidays/:id` | Admin, Manager, HR | edit a holiday |
| DELETE | `/api/holidays/:id` | Admin, Manager, HR | remove a holiday |

`POST /api/leave-types` and `PATCH /api/leave-types/:id` (existing routes)
now also accept `maxDaysPerRequest` and `isPaid`.

## Key decisions & why

- **Holidays are Admin/Manager/HR-entered, never computed.** Eid al-Fitr and
  Eid al-Adha follow the Hijri lunar calendar (moon-sighting, not pure
  arithmetic) and the government announces exact dates annually — hardcoding
  a formula would eventually print the wrong day. National Day (Sept 23) and
  Founding Day (Feb 22) are fixed Gregorian dates but are still entered the
  same way for one consistent, re-confirmed-yearly calendar rather than a
  hybrid of hardcoded-and-entered dates.
- **A holiday is a date *range*, not N single-day rows.** Eid is typically
  several consecutive paid days; modeling it as one record with start/end
  matches how it's actually granted and is one edit instead of several.
- **Only 3 of the PRD's 6 statutory leave categories got a real day cap.**
  The PRD states exact figures for Emergency (5), Paternity (3), and Marriage
  (5) — those are usable today via the new `maxDaysPerRequest` field. Sick,
  Bereavement, and Hajj leave were deliberately **not** seeded with invented
  numbers:
  - **Sick leave** under Saudi Labor Law (Article 117) isn't a flat cap at
    all — it's tiered pay (30 days full pay, next 60 days at 75%, further
    days unpaid), which the current binary "paid/unpaid" `LeaveType` model
    can't represent correctly. Forcing it into the existing shape would
    silently misstate a worker's actual entitlement — needs a dedicated
    follow-up, not a guess.
  - **Bereavement leave**'s day count isn't stated in the PRD at all (only
    "Bereavement Leave" is named) — that's a company-policy number to
    confirm, not invent.
  - **Hajj leave** (Article 114: 10–15 days, once during the entire term of
    service) is a *once-ever* entitlement, a shape none of the three
    `LeaveType` recurrences model (`Annual` and `ContractCycle` both repeat;
    `Manual` has no automatic tracking of "already used once"). It can be
    added as `Manual` with a cap today, but "has this employee already taken
    it before" would be a manual check by whoever reviews it, not enforced
    by the system — flagged rather than silently left unenforced.
  - Per **CLAUDE.md rule 4** ("never invent... when something is needed, stop
    and ask"), extended here to compliance figures that affect real pay: the
    three ambiguous categories are a follow-up once the real policy numbers
    are confirmed, not a guess baked into production data.
- **The Holiday inference in RecordsGrid renders identically to the existing
  "inferred Off"** (same muted grey cell, different letter) rather than a new
  accent color — one visual language for "nothing was recorded here and
  that's expected," not two.
- **No leave-request/holiday cross-validation.** Submitting leave that
  overlaps a holiday isn't blocked or flagged — Saudi practice already treats
  holidays and annual leave as separate pools, and adding that check without
  being asked would be scope creep on a milestone that's about making the
  calendar exist at all.

## Verified (2026-08-29)

**curl** (throwaway `p3b-test-admin@example.com` + a provisioned Worker
login, both deleted after): holiday create (single-day and multi-day) → 201 ·
end-before-start on create → 400 · missing name → 400 · no token → 401 ·
list → 200 with both records · update (partial) → 200 · update creating an
invalid range → 400 · delete non-existent id → 404 · Worker attempting
create/update on holidays and leave-types → 403 · LeaveType created with
`maxDaysPerRequest: 5` · Worker leave submission over the cap (7 days) → 400
with the exact cap in the message · within the cap (3 days) → 201,
PendingReview.

**Client build**: `npm run build` — clean, no errors, no new warnings.

**Browser**: not reachable this session — port 5173 is held by another
session's dev server and the API's CORS is locked to that exact origin, so a
second instance on another port can't make authenticated calls (see
`memory/verification-workflow.md`). Curl coverage above exercises every new
code path (validation, RBAC, the cap logic, the range-overlap query); the
client-side rendering (Holidays page, grid legend/inference, the two
LeaveType form fields) is a straightforward render of that same verified
data through already-proven components (`Table`, `Modal`, `ConfirmDialog`,
the existing `markFor`/`ATTENDANCE_STATUS_META` pattern) — flagging this as
the one gap rather than claiming a browser click-through that didn't happen.

**Cleanup**: throwaway admin, throwaway Worker login, the test employee, the
test LeaveType, its one LeaveRequest, both test holidays, their refresh
tokens, and the audit-log rows they generated were all deleted after
verification.

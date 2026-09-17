# P3-E — Overtime & Ramadan shifts

Continues the Phase 3 build-out (see `docs/PHASE3-PLAN.md`). Turns P2-M3b's
Timesheet hours into real overtime pay (Labor Law Article 107) and adds the
configurable Ramadan reduced-hours calendar (Article 98) that changes what
counts as overtime during that period. Depends on P2-M3b, as planned.

## What was built

**New module — `server/src/modules/ramadan/`**
```
ramadanPeriod.model.js   # RamadanPeriod — a Hijri-year date range + its
                          #   dailyHours/weeklyHours caps (default 6/36,
                          #   editable — mirrors Holiday's own "admin
                          #   re-confirms every year" discipline, P3-B)
ramadanPeriod.validation.js, .service.js, .controller.js, .routes.js
                          #   mounted at /api/ramadan-periods, read-open to
                          #   any staff, write gated Admin/Manager/HR
                          #   (identical role split to Holiday)
```

**Extended — not new modules**
```
server/src/modules/timesheets/
  timesheet.model.js      # + overtimeHours (frozen at submission, same
                            #   discipline as totalHours)
  timesheet.service.js    # + NORMAL_WEEKLY_HOURS=48 (Article 98) and the
                            #   Ramadan-overlap check in computeTotals()

server/src/modules/payroll/
  payrollRun.model.js     # + overtimeHours/overtimePay per line
  payroll.service.js      # + HOURLY_WAGE_DIVISOR=240, OVERTIME_RATE=1.5;
                            #   overtimePay now folds into grossPay
  payroll.pdf.js           # + an "Overtime (Xh @ 1.5×)" earnings line

client/src/features/ramadan/
  ramadanPeriods.api.js, ramadan.schema.js
  components/RamadanPeriodsSection.jsx  # embedded into HolidayListPage.jsx,
                                          #   not a new nav item — see below
client/src/features/timesheets/pages/TimesheetsPage.jsx     # + overtime hours shown
client/src/features/ess/pages/MyAttendancePage.jsx           # + overtime hours shown
client/src/features/payroll/pages/PayrollRunPage.jsx         # + overtime pay/hours shown
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/ramadan-periods` | any authenticated user | list (optional `from`/`to` overlap filter) |
| POST | `/api/ramadan-periods` | Admin, Manager, HR | add a period |
| PATCH | `/api/ramadan-periods/:id` | Admin, Manager, HR | edit |
| DELETE | `/api/ramadan-periods/:id` | Admin, Manager, HR | remove |

No new Timesheet/Payroll endpoints — `overtimeHours` rides along on the
existing Timesheet submit response, and `overtimePay`/`overtimeHours` ride
along on the existing PayrollRun line shape.

## Key decisions & why

- **The normal 48-hour week (Article 98) is a fixed constant;
  only the Ramadan cap is configurable**, exactly matching the plan's own
  wording ("configurable Ramadan hour caps") — a company might legitimately
  run shorter Ramadan hours than the statutory default, or the figure might
  be revised, but the ordinary week's 48-hour threshold isn't something this
  app should let drift from the law by admin mistake.
- **Overtime is computed WEEKLY, from the same Timesheet a supervisor
  already approves** — not a second calculation over raw daily Attendance.
  `overtimeHours = max(0, totalHours − threshold)`, where threshold is 48,
  or the smallest Ramadan `weeklyHours` cap among any RamadanPeriod that
  week's Sat–Fri range overlaps. Computed and frozen at submission time,
  same reasoning as `totalHours`: if HR corrects the Ramadan calendar later,
  an already-decided week's overtime doesn't silently change underneath it.
  **Known limitation, documented rather than glossed over**: if HR adds or
  fixes a Ramadan period AFTER some weeks in it were already approved, those
  weeks keep whatever threshold was in effect when they were computed —
  same class of limitation P2-M3b already accepted for its own attendance-lock
  gap.
- **Overtime pay uses Article 107's 1.5× rate on an hourly wage of
  `basicSalary ÷ 240`** (30 days × 8 hours — the same "turn a monthly wage
  into a smaller unit" convention P3-A's EOSB calculator already established
  with its `DAILY_WAGE_DIVISOR = 30`, just one level further down to hours).
  This is a fixed, published Labor Law figure — not invented — same category
  as EOSB's Article 84/85 percentages, not the "never invent a rate" caution
  that applies to GOSI (which genuinely varies by nationality/coverage and
  has no single correct constant).
- **Overtime pay is folded into `grossPay`, not shown as a separate
  informational figure.** Article 107 overtime is real earned compensation,
  not a bonus or a deduction offset — P2-M5's `approvedHours` was
  deliberately informational-only because there was no overtime *rate* logic
  yet; that's exactly the gap this milestone closes, so it has to actually
  move money now, not just display a number.
- **Overtime is NOT user-editable on a payroll line.** `updatePayrollLine`
  still only accepts `otherAllowances`/`gosiDeduction`/`otherDeductions` —
  overtime is derived from real approved timesheet data, the same "never
  trust a computed figure from the client" rule as `basicSalary` itself.
- **If multiple Ramadan periods somehow overlap a week (a data-entry
  mistake — periods aren't meant to overlap), the SMALLEST weekly cap wins**,
  the more worker-protective reading rather than an arbitrary "first match."
  Verified this exact scenario directly (see below), not just written and
  assumed correct.
- **No new sidebar item for Ramadan periods.** It's folded into the existing
  Holidays page (retitled "Holidays & Ramadan") as a second section — both
  are company-calendar configuration owned by the same Admin/Manager/HR
  circle, and a whole new nav entry for one small settings list would be
  pure navigation overhead, the same call P2-M3b made for timesheet
  submission (folded into My Attendance rather than a new ESS page).

## Verified (2026-08-30)

**curl** (throwaway admin + two Worker logins, deleted after), a real
employee (salary 4,800 → hourly wage 20), and controlled attendance (8h/day
× 7 days = 56h/week, via `PATCH /attendance/adjust`'s real checkIn/checkOut
computation, not a fallback default):

- A week with **no** Ramadan overlap → `overtimeHours: 8` (56 − 48).
- The **same 56 hours**, but a week overlapping a configured Ramadan period
  (weeklyHours 36) → `overtimeHours: 20` (56 − 36) — isolating that the
  Ramadan cap, and only the cap, changed the result.
- **Two overlapping** Ramadan periods (36 and 30) over the same week → a
  fresh employee's timesheet correctly used the smaller cap:
  `overtimeHours: 26` (56 − 30), confirming the "smallest wins" rule against
  real overlapping data, not just read from the code.
- Payroll run for the month: `approvedHours: 112` (56+56),
  `overtimeHours: 28` (8+20), `overtimePay: 840` (28 × 20 × 1.5 — hand
  checked), `grossPay: 5,640` (4,800 basic + 840 overtime), `netPay: 5,640`
  — every figure exact, not approximately right.
- The generated payslip PDF was downloaded and read back: an
  "Overtime (28h @ 1.5×)  SAR 840.00" line appears between allowances and
  gross pay, and the employee-summary line reads "Approved hours this
  period: 112 (incl. 28 overtime)" — both exactly as coded, not just
  present.
- Ramadan period validation: end date before start → 400; `dailyHours: 0`
  (below the 1–8 range) → 400.
- Roles: a Worker was rejected (403) creating a Ramadan period but could
  still read the list (200) — the same read-open/write-gated split as
  Holiday, verified directly rather than assumed identical.

**Browser** (both dev servers started fresh this session — the previous
session's servers had stopped): logged in with a throwaway admin, confirmed
the "Holidays & Ramadan" page renders both sections with correct empty
states, opened the "Add Ramadan period" modal (all 5 fields present,
dailyHours/weeklyHours pre-filled 6/36), filled and submitted it — a real
`POST /api/ramadan-periods → 201 Created` followed by an automatic
list refetch, the new period appearing in the table — then deleted it
through the UI's own confirm dialog and confirmed the empty state
returned. Full create→display→delete round trip through real network
requests, not simulated.

**Client build**: `npm run build` — clean, no errors.

**Cleanup**: both throwaway admin logins (one curl, one browser), two
Worker logins, both test employees, all 21 attendance records, all 3
timesheets, the one payroll run, both test Ramadan periods, their refresh
tokens, and every audit-log row generated were removed by a temporary
`server/cleanup-tmp.mjs` (deleted after each run). Re-attempting a login
with either throwaway admin's credentials afterward confirmed both are gone.

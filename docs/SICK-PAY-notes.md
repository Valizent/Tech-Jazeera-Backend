# Tiered Sick Pay (Labor Law Article 117)

A post-Phase-3 addition, not part of the `docs/PHASE3-PLAN.md` numbering —
Phase 3 (P3-A through P3-G) was already complete when this was requested.
Prompted by the PRD audit: Saudi Labor Law Article 117 tiers sick pay (the
statutory default is 30 days at 100%, the next 60 at 75%, the remainder
unpaid), and the existing Leave module only tracked days taken, not pay
impact. Follows P3-E's precedent — "compute from approved records, then fold
the result into real payroll pay" — this time for sick leave instead of
overtime.

## What was built

**Extended — not new modules**

```
server/src/modules/leave/
  leaveType.model.js       # + 'Sick' recurrence, sickPayTiers: [{days, payPercent}]
                            #   (_id: false, matches deductionSchema/repaymentSchema)
  leave.validation.js      # + Zod schema for sickPayTiers, required (>=1 tier)
                            #   only when recurrence === 'Sick'
  leave.service.js         # + allocateSickDays() — the tier-allocation algorithm,
                            #   exported so payroll.service.js reuses the exact
                            #   same math; evaluateSick() eligibility function;
                            #   submitLeaveRequest() now freezes payBreakdown
                            #   into eligibility at submission time
  leaveRequest.model.js    # + eligibility.payBreakdown: [{days, payPercent}]

server/src/modules/payroll/
  payroll.service.js       # + expandSickPayBreakdown(), sickLeaveDeductionForMonth();
                            #   buildLineTotals() and createPayrollRun() fold the
                            #   result into totalDeductions/netPay
  payrollRun.model.js      # + sickLeaveDeduction, sickLeaveNote per line
  payroll.pdf.js           # + a "Sick leave" deductions-section line

client/src/lib/constants.js          # + 'Sick' recurrence, DEFAULT_SICK_PAY_TIERS
client/src/features/leave/leave.schema.js            # + sickPayTiers array field
client/src/features/leave/pages/LeavePage.jsx         # + dynamic tier editor UI
client/src/features/payroll/pages/PayrollRunPage.jsx  # + sick deduction shown
```

No new API endpoints or nav items — everything rides the existing
`LeaveType`/`LeaveRequest`/`PayrollRun` create/read paths.

## Key decisions & why

- **Tiers are fully configurable, not hardcoded to 30/60/rest.** The user was
  asked directly whether to hardcode Article 117's numbers and said to let
  the company set this themselves — the same "never invent a company policy
  number" discipline already applied to Bereavement/Hajj leave (left
  unseeded) and to GOSI (never calculated). The client pre-fills Article
  117's statutory tiers as a sensible starting point for a *new* Sick leave
  type, but every number is editable before saving, and an *existing* type
  always shows its own real stored tiers.
- **Tiers are consumed in array order across the whole leave year, not
  per-request.** Article 117's "first 30 days" means the first 30 sick days
  a worker takes that year in total, regardless of how many separate
  requests they came from — so a worker's third sick request this year might
  start mid-tier or straddle two tiers. `allocateSickDays(usedDays,
  requestedDays, tiers)` takes the days already used this leave year as an
  offset into the tier list, exactly mirroring how `evaluateAnnual` already
  tracks `usedDays` for annual leave.
- **A request exceeding the remaining balance still gets a full
  `payBreakdown`, tapering to 0% — never silently full-pay by omission.**
  Found via testing: the first version of `allocateSickDays` only allocated
  days that fit inside the defined tiers, so an over-cap request had days
  simply missing from `payBreakdown` (payroll would have then treated it as
  fully paid, the opposite of Article 117's intent that pay tapers to zero
  past the cap). Fixed by pushing the overflow as an explicit `{days,
  payPercent: 0}` entry (merged into an existing trailing 0%-tier entry
  rather than creating two adjacent zero-pay lines).
- **`payBreakdown` is frozen into `eligibility` at submission time**, same
  discipline as every other frozen snapshot in this app (quotation totals,
  EOSB, invoice line items, `LeaveRequest.eligibility` itself before this
  change) — if HR edits the tiers later, an already-decided request's pay
  impact doesn't silently change underneath it.
- **Payroll reconstructs real calendar dates from `payBreakdown` to handle a
  request spanning a month boundary**, rather than assuming a request falls
  entirely within one payroll month. `payBreakdown` only stores day *counts*
  per tier, not which calendar dates they land on — but since tiers are
  always consumed in order starting from the request's real `startDate`,
  `expandSickPayBreakdown()` can walk the days back out in sequence and
  attach a real date to each one, then `sickLeaveDeductionForMonth()` filters
  to just the days that actually fall inside the target payroll month.
  Verified directly with a 6-day request crossing Aug 29 → Sep 3: only the
  1 day that landed in September was deducted from the September run.
- **The deduction only ever reduces pay for the reduced/no-pay portion** —
  `dailyWage × (100 − payPercent) / 100`, using the same `DAILY_WAGE_DIVISOR
  = 30` already established for EOSB. Full-pay tier days contribute 0
  deduction (they're already inside `basicSalary`), so `sickLeaveDeduction`
  only shows up on a payslip when a worker has actually exceeded the
  full-pay tier for the year.
- **Not user-editable on a payroll line**, same rule as `overtimePay`
  (P3-E) and `basicSalary` itself — it's derived from real approved leave
  records, never trusted from the client.
- **A Rejected or Cancelled sick request never reaches payroll** — the same
  `status: { $in: ['AutoApproved', 'Approved'] }` filter every other
  eligibility/usage query in this module already uses.

## Verified (2026-08-30)

**curl** (throwaway admin + two Worker logins, one "Test Sick Leave" type
with tiers `[5@100, 5@50, 5@0]`, deleted after):

- Employee A (salary 3,000 → daily wage 100): three sequential sick requests
  totaling `sickLeaveDeduction: 950` for the month, matching a hand
  calculation exactly (2 days@50% = 100, then 3 days@50% + 7 days@0% = 850 on
  a request that ran past the remaining balance) — confirmed both in the API
  response and in the actual generated payslip PDF.
- **Overflow-beyond-cap fix, re-verified**: a 10-day request with only 8
  days of balance remaining now correctly returns `payBreakdown: [{3,50%},
  {7,0%}]` (all 10 days accounted for; before the fix, 2 of the 10 days were
  missing from the breakdown entirely).
- **Month-boundary case**: Employee B (salary 6,000 → daily wage 200)
  submitted a 6-day request Aug 29 → Sep 3, returning `payBreakdown:
  [{5,100%}, {1,50%}]`. The August payroll run showed `sickLeaveDeduction: 0`
  for this employee (all 5 full-pay days were in August); the September run
  showed `sickLeaveDeduction: 100` (exactly 1 day × 200 × 50% = 100) —
  isolating that only the single day actually falling in September was
  counted.
- **Validation**: creating a Sick-recurrence LeaveType with no tiers → 400
  ("At least one pay tier is required for a Sick leave type.").
- **Roles**: a Worker attempting to create a LeaveType (Sick or otherwise) →
  403, unchanged from the existing `LEAVE_TYPE_MANAGE_ROLES` gate.

**Browser** (throwaway admin, deleted after): opened "Add leave type",
selected "Sick (tiered pay)" — the tier editor pre-filled Article 117's
defaults (30@100%, 60@75%, 30@0%), "Add tier" appended a blank row, the row's
"✕" removed it, and the list-item summary rendered
`Sick (tiered pay) · 120 days/yr (30d @ 100%, 60d @ 75%, 30d @ 0%)` after
saving — a real create → display round trip, not simulated.

**Client build**: `npm run build` — clean, no errors.

**Cleanup**: both curl-created employees (SICK-001, SICK-002), their Worker
logins, the "Test Sick Leave" LeaveType, all 4 associated LeaveRequests, both
PayrollRuns (August — finalized, September — draft), the curl throwaway
admin, the browser throwaway admin, the browser's "UI Verify Sick Leave"
LeaveType, and every refresh token / audit-log row generated were removed by
temporary `server/cleanup-tmp.mjs` scripts (deleted after each run).
Re-attempting a login with either throwaway admin's credentials afterward
confirmed both are gone. The three pre-existing real employees were
untouched and confirmed still present.

## Known, pre-existing, out of scope

While verifying the leave-types list in the browser, the real "Annual Leave"
type displays "· unpaid" — its stored `isPaid` is `false`. This is existing
production data, not something this change touched or introduced (the only
edit to that display line was adding a `recurrence !== 'Sick'` guard so Sick
types show their own tiered-pay description instead of a redundant "unpaid"
suffix). Worth the company checking whether `isPaid: false` on Annual Leave
is intentional.

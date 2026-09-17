# P2-M5 — Payroll & payslips

Continues the Phase 2 backbone (see `docs/PHASE2-PLAN.md`). Turns real
employee salaries and P2-M3b's approved hours into an actual monthly
payroll run and a downloadable payslip — the PRD's "WPS Payslip Viewing"
requirement, minus the two figures this app has no honest way to compute
(see decisions below).

## What was built

**New module — `server/src/modules/payroll/`**
```
payrollRun.model.js       # PayrollRun — one per calendar month (unique
                            #   index), embedded per-employee `lines`, every
                            #   money figure computed server-side
payroll.validation.js, .service.js, .controller.js, .routes.js
                            # mounted at /api/payroll
payroll.pdf.js             # payslip PDF — same minimal-letterhead
                            #   discipline as certificate.pdf.js

server/src/modules/employees/
  employee.model.js, .validation.js   # + optional basicSalary,
                                        #   housingAllowance,
                                        #   transportAllowance (WPS
                                        #   breakdown of `salary`)
client/.../employees/components/EmployeeForm.jsx
  # + the three breakdown fields, clearly marked optional

server/src/modules/me/     # extended — worker payslip viewing
  me.routes.js, me.controller.js, me.service.js

client/src/features/payroll/
  payroll.api.js, payroll.schema.js
  pages/PayrollListPage.jsx   # every run + "Run payroll" for a month
  pages/PayrollRunPage.jsx    # one run's lines, edit (Draft only),
                                #   finalize, per-employee payslip PDF
client/src/features/ess/pages/MyPayslipsPage.jsx
  # worker: own finalized payslips only
client/src/app/router.jsx, DashboardLayout.jsx, EssLayout.jsx
  # + /payroll, /payroll/:id, /me/payslips
client/src/lib/constants.js  # + PAYROLL_* roles/statuses, MONTH_NAMES
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/me/payslips` | Worker | own finalized payslip history |
| GET | `/api/me/payslips/:runId/pdf` | Worker (own) | own payslip PDF |
| GET | `/api/payroll` \| `/:id` | Admin, Manager, HR, Accounts | list / view a run |
| POST | `/api/payroll` | Admin, Manager, Accounts | build a Draft for a month |
| PATCH | `/api/payroll/:id/lines/:lineId` | Admin, Manager, Accounts | edit a Draft line's allowances/deductions |
| PATCH | `/api/payroll/:id/finalize` | Admin, Manager | lock the run, publish payslips |
| DELETE | `/api/payroll/:id` | Admin, Manager | remove a Draft (never a Finalized run) |
| GET | `/api/payroll/:id/lines/:lineId/pdf` | Admin, Manager, HR, Accounts | any employee's payslip |

## Key decisions & why

- **GOSI is entered, never calculated.** GOSI contribution rates differ by
  nationality and coverage status and change over time; this app has no
  verified current rate to apply. Same "don't compute a legally exact
  figure without a confirmed source" rule as the EOSB exit-reason scoping
  and the unconfirmed statutory leave day-caps — defaults to 0 with an
  explicit note on the edit form ("not calculated automatically") rather
  than a plausible-looking guess.
- **The Basic/Housing/Transport split is optional, on the Employee record,
  not invented per payroll run.** Most manpower-supply workers here likely
  have one flat monthly figure (`salary`), not a formal WPS breakdown — so
  Payroll falls back to treating the whole salary as Basic unless HR has
  actually configured a real split for that employee. Verified both paths
  directly: an employee with no breakdown correctly showed the full salary
  as Basic; one configured with Basic/Housing/Transport showed the exact
  real numbers, summing to the same gross.
- **Approved hours are informational, not wired into the pay math.**
  P2-M3b's Timesheets are the "make hours available to payroll" half of the
  original plan; multiplying overtime hours into net pay at the Saudi 1.5×
  rate is P3-E's job (not yet built). A month's approved hours are computed
  and shown on the payslip (a real timesheet's hours were verified to
  appear correctly), but adding them to pay before the actual overtime
  Saudi-law calculation exists would be guessing at the rate.
- **A week is counted toward the month its Saturday (periodStart) falls
  in** — a documented approximation for weeks that straddle a month
  boundary, not a day-by-day split. Simple, and the actual figure only
  matters for display, not for pay, given the point above.
- **A PayrollRun is one document per month with embedded lines**, not a
  document per employee. One real limit exists as a result: `updatePayrollLine`
  can only touch a Draft run, and a Finalized run can never be deleted —
  verified both locks directly (an edit attempt after finalizing, and a
  delete attempt on a finalized run, both correctly rejected).
- **Deduction editing is a generic itemized list** (label + amount), not a
  built-in link to the Salary Advance ledger (P3-C). HR can add "Advance
  repayment — SAR X" as a line here as a record, but recording the actual
  repayment still happens in Financial Requests — the same forward-looking
  connection point P3-C's own notes already flagged, not yet wired
  automatically to avoid an implicit cross-module side effect this pass
  didn't ask for.
- **Eligible employees mirror the dashboard's existing "Monthly Payroll"
  figure exactly** (`type: 'Client'`, not Exited, a salary on file) —
  reusing that established rule rather than inventing a second one that
  could quietly disagree with it.

## Verified (2026-08-29)

**curl** (throwaway admin, HR, and Worker logins, deleted after), with two
constructed employees — one with a flat salary only, one with a real
Basic/Housing/Transport breakdown — plus one Approved P2-M3b timesheet:

- Building the Draft run for August 2026 produced exactly the expected two
  lines: the flat-salary employee showed `basicSalary: 3000` (the whole
  salary, correctly defaulted) with `approvedHours: 8` (from the real
  timesheet); the broken-down employee showed `basicSalary: 2000,
  housingAllowance: 600, transportAllowance: 400` (gross 3000, matching)
  with `approvedHours: 0` (no timesheet submitted).
- A second run for the same month → 409.
- Editing a Draft line (`otherAllowances: 200, gosiDeduction: 150, otherDeductions: [{Advance repayment, 100}]`)
  recomputed to exactly `grossPay: 3200, totalDeductions: 250, netPay: 2950`,
  and the run-level totals summed both lines correctly (`totalGross: 6200,
  totalNet: 5950`).
- The worker's own payslip list/PDF correctly 404'd **before** finalizing
  and became available immediately **after** — the actual PDF bytes were
  read back and visually confirmed (correct name, period, earnings,
  deductions, net pay, minimal letterhead, blank signature line).
- Post-finalize: editing a line → 400; finalizing again → 400; deleting the
  run → 400. A Worker was blocked from the entire staff router (403); an
  HR login could list/view (200) but not create or finalize (403 both).

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint noted
throughout this work — see `docs/P3-B-notes.md`). Every code path,
including the exact pay math and the real generated PDF, was verified via
curl.

**Cleanup**: throwaway admin/Worker/HR logins, all three test employees,
the attendance record, the timesheet, the payroll run (both its lines), their
refresh tokens, and the audit-log rows were deleted. No other employees in
the system matched the payroll-eligibility filter, so no real data was
touched.

### Follow-up (2026-09-13): `otherDeductions` gains a real auto-populated source

`createPayrollRun` now seeds each eligible employee's `otherDeductions`
from any Approved client-timesheet deduction their Deployment(s) carried
for that exact month (a client-imposed absence penalty, most commonly) —
the first thing that's ever populated this array automatically; previously
it only ever started empty and was built up by hand. A genuine new
dependency from this module onto Deployment's service (one-directional, no
circularity risk — Deployment has no reason to ever call into Payroll).
Same snapshot-at-creation limitation every other auto-computed figure here
already has (`approvedHours`, `overtimeHours`, `sickLeaveDeduction`): a
deduction entered or approved after a run already exists for that month is
not retroactively pulled in — HR/Accounts can still add it by hand via the
existing `otherDeductions` editing, while the run is still Draft. See
`docs/DEPLOYMENT-notes.md`'s 2026-09-13 follow-up for the full design and
verification.

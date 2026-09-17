# P3-A — End of Service (EOSB) & vacation-pay settlement calculator

Second milestone of the HR PRD build-out (see `docs/PHASE3-PLAN.md`). A
standalone module: given an exiting employee, computes and permanently
records the Labor Law Article 84/85 end-of-service award plus the
encashment of their unused annual leave, and generates a PDF.

## What was built

**New module**
```
server/src/modules/eosb/
  settlement.model.js        # Settlement — every input snapshotted
                              #   (employeeName, joiningDate, monthlyWage…)
                              #   so the record reads the same even if the
                              #   Employee is later edited or deleted
  settlement.validation.js   # create/list Zod schemas — no money field
                              #   accepted from the client, ever
  settlement.service.js      # computeEosb() — the Article 84/85 math
                              #   (pure function); createSettlement() also
                              #   pulls the unused-leave encashment
  settlement.pdf.js          # pdfkit, mirrors quotation.pdf.js's layout
  settlement.controller.js
  settlement.routes.js       # mounted at /api/eosb
server/src/modules/leave/leave.service.js
                              # monthsOfService() now exported — the EOSB
                              #   calculator reuses the Leave module's exact
                              #   tenure formula instead of a second one
server/src/app.js            # + settlementRoutes

client/src/features/eosb/
  eosb.api.js
  eosb.schema.js
  pages/SettlementListPage.jsx
  pages/SettlementNewPage.jsx   # employee/exit-date/reason form; accepts
                                 #   ?employee=<id> to preset
  pages/SettlementViewPage.jsx  # full breakdown, PDF, delete
  components/SettlementPdfButton.jsx  # mirrors QuotationPdfButton
client/src/app/router.jsx       # + /eosb, /eosb/new, /eosb/:id
client/src/app/layouts/DashboardLayout.jsx  # + "End of Service" nav item
client/src/lib/constants.js     # + EXIT_REASONS, EOSB_VIEW_ROLES, EOSB_WRITE_ROLES
client/.../employees/pages/EmployeeProfilePage.jsx
                                 # + "Calculate EOSB" button → /eosb/new?employee=<id>
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/eosb` | Admin, Manager, HR, Accounts | list settlements |
| GET | `/api/eosb/:id` | Admin, Manager, HR, Accounts | one settlement |
| GET | `/api/eosb/:id/pdf` | Admin, Manager, HR, Accounts | download the settlement PDF |
| POST | `/api/eosb` | Admin, Manager, HR | compute & save a settlement |
| DELETE | `/api/eosb/:id` | Admin, Manager, HR | remove a settlement |

## Key decisions & why

- **Only three exit reasons are modeled**: `Resignation` (Article 85 tiering
  applies), `TerminationByEmployer`, and `EndOfContract` (both get the full
  Article 84 award, no reduction) — exactly what the PRD specifies. Article
  80 (termination for an employee's serious misconduct, which can forfeit
  the award entirely) is deliberately **not** offered as a reason: it's a
  distinct, contentious legal category with its own strict grounds that this
  app has no business silently adjudicating. If it's needed, that's a
  conscious follow-up, not something to fold in quietly.
- **No client-side preview of the money figure.** Quotation's form can show
  a live running total because everything it needs (the line items) is
  already in the form. Here, half the total — the unused-leave encashment —
  depends on a real server-side leave-balance query the client can't
  replicate. Rather than show a "close enough" client estimate next to a
  legally real payroll number, the form computes and saves in one step; the
  very next screen shows the authoritative breakdown.
- **A settlement is delete-and-recompute, not editable.** Like a financial
  document that's already been finalized, silently editing a saved EOSB
  figure in place is the wrong shape for something this consequential — if
  a number was wrong, delete it and compute a correct one, leaving a clear
  audit trail either way (every create/delete is logged).
- **Every input is snapshotted onto the Settlement** (name, joining date,
  monthly wage) — identical reasoning to Quotation's `clientName`: the
  record must keep reading correctly regardless of what happens to the
  Employee afterward.
- **Tenure precision matches the existing Leave engine** (whole completed
  months via the now-exported `monthsOfService`), not a new day-level
  standard — reusing one formula rather than risking two that drift apart.
  This means the very last partial year isn't prorated to the day; flagged
  as a known limitation, not silently different from how the rest of the
  app already measures service length.
- **Unused-leave encashment sums every active `Annual`-recurrence LeaveType**
  a company might have, evaluated exactly as of the exit date (not today) via
  the Leave module's own `evaluateEligibility` — so it automatically
  respects each type's real policy (minimum service, tier upgrades). This
  was directly verified against the project's actual "Annual Leave" policy
  (22 days/year, 26 after 2 years, needs 24 months to qualify) during
  testing, not just a synthetic one — see Verified below.
- **The daily-wage divisor is 30**, the standard Saudi Labor Law convention
  for turning a monthly wage into a daily figure for leave/EOSB math — not
  the employee's actual working days in a month.

## Verified (2026-08-29)

**curl** (throwaway `p3a-test-admin@example.com` + provisioned Accounts and
Worker logins, all deleted after), against four real employees spanning
every Article 85 band:

| Employee | Tenure | Exit reason | Gross | Reduction | Net EOSB |
|---|---|---|---|---|---|
| A | 12 yr | Resignation | 28,500 | full | 28,500 |
| B | 3 yr | Resignation | 4,500 | 1/3 | 1,500 |
| C | 1 yr | Resignation | 1,500 | forfeited | 0 |
| D | 7 yr | TerminationByEmployer | 13,500 | full | 13,500 |

All four matched hand-calculated Article 84/85 figures exactly. Leave
encashment was cross-checked against the **real, already-configured**
"Annual Leave" policy (22 days/yr, tiered to 26 after 2 years, 24-month
minimum): employees A/B/D (≥3 yr tenure, past both gates) correctly got 26
days from it; employee C (1 yr, under the 24-month gate) correctly got 0
from it — plus a second test-only Annual type in every case, confirming the
sum-across-all-Annual-types logic works with more than one policy active.

Also verified: exit date before joining date → 400 · missing exit reason →
400 · unknown employee id → 404 · no token → 401 · Worker role → 403 on the
entire module · Accounts role → 200 on list/get, 403 on create/delete · PDF
downloads as a valid single-page `application/pdf` · delete → 200, then a
second GET on the same id → 404.

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint as
P3-B — see `docs/P3-B-notes.md` and `memory/verification-workflow.md`).
Curl coverage exercises every code path including the exact money math; the
client pages are a direct render of that same data through already-verified
components (`Table`, `PageHeader`, `ConfirmDialog`, the `QuotationPdfButton`
pattern reused as `SettlementPdfButton`).

**Cleanup**: throwaway admin/Accounts/Worker logins, the four test
employees, the test LeaveType, all four settlements, their refresh tokens,
and the audit-log rows they generated were deleted. The real "Annual Leave"
policy and all other production data were read-only throughout and
untouched.

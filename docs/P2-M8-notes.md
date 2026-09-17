# P2-M8 — Dashboard v2 (real profit)

Closes out the Phase 2 backbone (see `docs/PHASE2-PLAN.md`). Replaces the
Phase 1 "profit needs cost data" placeholder with a real, computed profit
figure, now that Invoices (P2-M6), finalized Payroll (P2-M5), and Expenses
(P2-M7) all exist.

## What was built

**Extended, not new** — the whole feature lives inside the existing
`server/src/modules/dashboard/` module, which already reads across every
other module for the single overview call.
```
dashboard.service.js   # + resolveMonth(), computeMonthProfit(),
                        #   getProfitOverview() — the real month-by-month P&L;
                        #   wired into getDashboard()'s existing parallel
                        #   batch and returned as finance.profit
dashboard.validation.js  # + month ("YYYY-MM") on dashboardQuerySchema
dashboard.controller.js  # + passes req.query.month through

client/src/features/dashboard/
  dashboard.api.js         # getDashboard() takes an optional month now
  components/ProfitCard.jsx  # NEW — month selector, 4 headline figures,
                              #   a 6-month diverging-bar trend (no chart
                              #   library, same ~20-line-div approach as
                              #   the existing StatusBreakdown)
  pages/DashboardPage.jsx    # month state, renders ProfitCard, old finance
                              #   card relabeled "Pipeline" to distinguish
                              #   it from the new real P&L
```

## API

`GET /api/dashboard` (unchanged route, same `requireStaff` gate) gains one
query param:

| Param | Format | Purpose |
|---|---|---|
| `month` | `YYYY-MM` | Which calendar month the Profit section computes. Defaults to the current month. Rejected with 400 if malformed. |

Response shape addition — `finance.profit` (null for a Coordinator, same
visibility line as the three existing finance fields):
```json
{
  "month": "2026-08",
  "revenue": 23000,
  "payrollCost": 4000,
  "expenses": 1500,
  "net": 17500,
  "trend": [ { "month": "2026-03", "revenue": 0, ... }, ..., /* 6 entries, oldest→newest, selected month last */ ]
}
```

## Key decisions & why

- **One consistent "what happened in this month" methodology across all
  three legs**, not a mix of accrual and cash-basis figures that wouldn't
  add up to anything real:
  - **Revenue** = sum of `Invoice.grandTotal` for invoices whose `date`
    falls in the month — i.e. what was actually **billed** that month, not
    the old `approvedRevenue` (any Approved quotation, whether ever invoiced
    or not, which is now relabeled "Pipeline" and kept as a separate,
    still-useful estimate).
  - **Payroll cost** = the **Finalized** `PayrollRun.totalNet` for that
    exact `(periodYear, periodMonth)` — 0 if none was ever finalized. A
    Draft run never counts; verified this exact transition directly (see
    below), matching `docs/PHASE2-PLAN.md`'s own P2-M8 line: "Finalized
    payroll feeds the dashboard's real cost figure."
  - **Expenses** = sum of `Expense.amount` recorded in the month
    (`Expense.date`) — reuses the exact same date-range logic as P2-M7's own
    summary endpoint, just inlined here since the dashboard already reads
    other modules' models directly rather than through their services (the
    established pattern in this file for Employee/Client/Deployment/etc.).
  - **Net** = revenue − payrollCost − expenses. Never stored — always
    recomputed per request, same discipline as every other derived-total
    field in this app.
- **A dedicated `month` query param on the existing endpoint, not a new
  resource.** The rest of the dashboard (workforce counts, expiring docs,
  recent activity) isn't period-scoped and shouldn't refetch for a reason
  unrelated to it, but this app's dashboard has always been "one query for
  the whole page" (its own file header says so) — adding one more query key
  alongside `thresholdDays` keeps that shape rather than forking off a
  second dashboard endpoint for one card.
- **The old three finance fields stay, relabeled "Pipeline".**
  `approvedRevenue`/`pendingRevenue`/`monthlyPayroll` are still honest,
  still-useful numbers (deal pipeline value, current workforce pay run-rate)
  — P2-M8 adds the real P&L alongside them rather than replacing a
  legitimate estimate with a narrower one.
- **A 6-month trailing trend, shown as diverging bars** (green up from a
  zero line for a positive month, red down for a negative one) — the
  simplest faithful reading of "simple month-over-month trend (bar
  breakdown)" without pulling in a charting library, which the stack
  explicitly avoids without a stated need. Verified the zero-months render
  no bar at all (not a zero-height sliver) and the one non-zero month scales
  to 100% of the track — both checked in the actual rendered DOM, not
  assumed from the code.
- **Role visibility unchanged, not narrowed.** The existing dashboard
  already shows `monthlyPayroll`/`approvedRevenue` to every non-Coordinator
  staff role on this one shared endpoint (nulled only for Coordinator); the
  new profit figures use the exact same line rather than inventing a
  narrower "managers only" gate PHASE2-PLAN.md floated as optional — the
  underlying Expense/Payroll modules already have their own stricter
  role-gated endpoints for direct CRUD, so this is a read-only aggregate on
  a page that circle already sees other salary/revenue numbers on.
- **Month selection isn't persisted** (unlike the expiry-alert threshold,
  which is), on purpose — it always opens on the current month, so nobody
  mistakes an old month's figures for today's after forgetting they changed
  it on a previous visit.

## Verified (2026-08-29)

**curl** (two throwaway admins + a Coordinator login, deleted after), with a
real client/quotation/invoice, expense, employee, and payroll run:

- Before any test data existed: every profit figure across the full 6-month
  trend was exactly 0 — confirmed against a genuinely empty DB, not assumed.
- After creating an 11,500 SAR invoice (dated this month) and a 2,000 SAR
  expense, **before** finalizing payroll: revenue 11,500, payrollCost 0
  (the Draft run correctly doesn't count), expenses 2,000, net 9,500.
- **After** finalizing the same payroll run (netPay 3,000): payrollCost
  became exactly 3,000 with no other figure changing — isolating that the
  Draft→Finalized transition, and only that transition, is what flips a
  run from invisible to counted.
- `?month=2026-07` (a month with no data) returned all zeros while the
  current month's real figures were unaffected — confirmed period
  isolation, not a global leak.
- The trend array's ordering and window were checked directly: `month=2026-08`
  produced `2026-03 … 2026-08` (August last, matching the headline figures
  exactly); `month=2026-02` produced `2025-09 … 2026-02` — the year-boundary
  case, handled correctly.
- An invalid `month` (`2026-13`) → 400 with a clear message.
- A Coordinator's dashboard returned `finance.profit: null`, same as the
  three pre-existing finance fields — the exact visibility line this
  decision claims, not just similar.

**Browser** (reachable this session, unlike the port/CORS constraint noted
throughout Phase 2/3 so far): logged in as a throwaway admin with real
seeded data (a 20,000 SAR quotation → invoice, a 1,500 SAR expense, a
finalized 4,000 SAR payroll run) and confirmed in the live rendered page —
not just the API response — that Revenue/Payroll cost/Expenses/Net profit
showed SAR 23,000.00 / SAR 4,000.00 / SAR 1,500.00 / SAR 17,500.00 exactly;
that changing the month picker to July fired a real new
`GET /api/dashboard?month=2026-07` request and the Profit section (only)
reset to zero while Pipeline stayed at the unrelated all-time figures; and,
by inspecting the actual DOM, that the five zero-value trend months
rendered no bar element while August rendered a `.bg-success` bar at
exactly 100% height. No console errors beyond the pre-login silent-refresh
401, which is pre-existing, unrelated app-boot behavior.

**Client build**: `npm run build` — clean, no errors.

**Cleanup**: both throwaway admin logins, the Coordinator login and its
employee record, the two test clients/quotations/invoices, both test
expenses, both test employees, both test payroll runs, their refresh
tokens, and every audit-log row they generated were removed by a temporary
`server/cleanup-tmp.mjs` (deleted after each run). Re-attempting a login
with either throwaway admin's credentials afterward confirmed both are gone.

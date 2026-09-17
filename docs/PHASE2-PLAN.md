# Phase 2 — Plan

Phase 1 gave the company an operating system (people, clients, deployments,
attendance, documents, quotations, dashboard). Phase 2 adds the **money and
self-service half**: workers submit their own time, that time becomes payroll,
approved quotations become invoices and payments, expenses are tracked, and the
dashboard finally shows **real profit** (revenue − costs) instead of the honest
"profit needs cost data" placeholder.

Same stack, same architecture, same rules as Phase 1 (see `CLAUDE.md`). Every
milestone: build → verify → document (`docs/P2-M<N>-notes.md`) → suggest commit
→ stop.

## The big idea (why this order)

```
Worker logs in  →  submits timesheet (hours)  →  supervisor approves
                                                        │
                                    approved hours ─────┼──→ Payroll → payslip
                                                        │
Quotation (Approved) → Invoice → Payment received ──────┼──→ Revenue
                                                        │
Expenses (rent, fuel, purchases) ───────────────────────┘
                                                        ▼
                        Dashboard v2:  Profit = Revenue − Payroll − Expenses
```

Each milestone unlocks the next. Build in this order.

---

## P2-M1 — Worker accounts & account linking

Foundation for self-service. Right now `User` (login) and `Employee`
(workforce record) are separate collections. Link them.

- Add role **`Worker`** to the roles list.
- Link `User.employee → Employee` (one-to-one, optional). A worker's login
  maps to exactly one employee record.
- **Invite/provision flow**: an Admin/HR creates a login for an existing
  employee (generate a temporary password or an invite; never invent
  credentials — surface them to the admin to hand over). Reuse the seed-admin
  pattern; add an admin-only "create worker login" action on the employee
  profile.
- RBAC: a `Worker` can only read/write **their own** data. Add an ownership
  guard middleware (`req.user.employee === resource.owner`).
- **Verify**: admin creates a worker login; worker logs in; worker is blocked
  (403) from every admin route and from other workers' data.

## P2-M2 — Employee Self-Service (ESS) portal — COMPLETE, expanded scope

Built as one integrated pass, not just the ESS shell originally scoped here —
see `docs/P2-M2-notes.md` for the full breakdown. What shipped beyond this
plan's original bullets:

- **Coordinator role & hierarchy**: `Employee.coordinator`, `User.managedBy`,
  scoped queries, a "My team" filter for Manager, and (a prerequisite the
  plan didn't call out) a **Users module** — there was no in-app way to
  create *any* staff login before this, only the `seed:admin` CLI.
- **Leave & the eligibility engine**: configurable `LeaveType` policies
  (Annual/ContractCycle/Manual), server-computed eligibility, auto-approval
  with a coordinator/manager "notice" flag. Not in the original Phase 2 plan
  at all — added from a direct product request during this milestone.
- **Configurable expiry alerts**: `thresholdDays` override + Coordinator
  team-scoping on the dashboard and employee list.

**Not built, deferred**: `GET /api/me/deployments` (worker's current
deployment view) — the plan called for it, but leave/coordinator/alerts were
the actual priority this pass. Add it as a small follow-up if wanted; the
pattern (`me.service.js` reading another module scoped to
`req.user.employee`) is already established by `/me/documents`.

**Verified**: worker sees only own data; ESS sidebar shows only worker
items (My Profile/Documents/Leave); direct-URL to an admin page redirects to
`/me`. Full curl + browser verification in `docs/P2-M2-notes.md`.

## P2-M3 — Timesheets (worker submits hours)

Attendance today is status-only (Present/Absent). Timesheets add **hours**.

- New `Timesheet` model: employee, date, clockIn/clockOut **or** hours worked,
  project/client+site (from their deployment), notes, `status`
  (Draft/Submitted/Approved/Rejected). One per employee per day (unique index,
  like attendance).
- Worker screen: enter today's hours (or a week), submit. Prefill client/site
  from their active deployment.
- Decide: does Timesheet **replace** or **complement** the M7 Attendance mark?
  Recommended — Timesheet is the worker-entered source; a Present attendance
  record can be derived from an Approved timesheet so M7 views keep working.
- **Verify**: worker submits hours; can't edit after Submitted; can't submit
  for someone else; duplicate day upserts.

## P2-M4 — Timesheet approval

The supervisor loop.

- HR/Manager/Operations screen: list **Submitted** timesheets, approve/reject
  (with reason). Bulk approve a week.
- On approve: lock the timesheet, (optionally) write the derived attendance
  record, make hours available to payroll.
- Audit every approve/reject.
- **Verify**: approve flow, reject-with-reason flow, worker sees updated
  status, wrong-role can't approve.

## P2-M5 — Payroll & payslips

Turn approved hours + salary into pay.

- `PayrollRun` model: period (month), per-employee lines (basic salary,
  overtime from approved hours, allowances, deductions, net pay), status
  (Draft/Finalized). Compute server-side (never trust the client — same
  discipline as quotation totals).
- Generate **payslip PDF** per employee (reuse pdfkit). Finalized payroll
  feeds the dashboard's real cost figure.
- ESS: worker views/downloads **own payslips** only.
- **Verify**: run payroll for a period, totals correct, payslip PDF valid,
  worker sees only their payslip, re-running is idempotent per period.

## P2-M6 — Invoices & payments

Close the revenue loop from quotations.

- `Invoice` model: created from an **Approved** quotation (copy line items +
  totals, snapshot client), invoice number via the atomic counter, status
  (Unpaid/Partially Paid/Paid), due date.
- Record **payments** against an invoice (amount, date, method); status derives
  from paid vs total.
- Invoice **PDF** (reuse the quotation PDF layout). Client profile gains an
  **Invoices** tab (real data — no stub).
- **Verify**: quote→invoice, partial payment → Partially Paid, full → Paid,
  PDF valid, totals server-computed.

## P2-M7 — Expenses

The other half of profit.

- `Expense` model: date, category (Rent, Fuel, Salaries-external, Purchases,
  Utilities, Other), vendor, amount, optional linked client/deployment, notes,
  optional receipt document (reuse M8 upload).
- Simple CRUD + list with filters + monthly totals.
- **Verify**: CRUD, category filter, monthly total aggregation.

## P2-M8 — Dashboard v2 (real profit)

Now the numbers exist.

- Extend the dashboard aggregation: **Revenue** (paid/invoiced), **Payroll**
  cost (finalized runs), **Expenses**, and **Profit = Revenue − Payroll −
  Expenses** for a period. Add a period selector and a simple month-over-month
  trend (bar breakdown, still no chart library unless a real need appears).
- Replace the "profit needs cost data" note with the real figure.
- **Verify**: profit math against known data; period selector; role-gate
  finance to managers if desired.

---

## Cross-cutting decisions to make early

- **Ownership guard** (P2-M1) is reused by all ESS endpoints — build it once,
  well.
- **Timesheet vs Attendance**: pick "derive attendance from approved
  timesheet" so M7 keeps working; document it.
- **Money math** (payroll, invoices): always server-authoritative and rounded
  with one shared helper, exactly like quotation totals.
- **Currency/VAT**: SAR, 15% KSA VAT — already established.
- **New env/config**: none expected beyond Phase 1; if payroll needs company
  legal details for payslips/invoices, add them via env or a Settings record
  (ask the user — don't invent CR/VAT/IBAN).

## Suggested milestone size

P2-M1..M2 are foundation (smaller). M3–M6 are full feature milestones (model +
API + UI + verify), each roughly the size of a Phase 1 module. M7 is small, M8
is medium. Build one at a time; stop between each.

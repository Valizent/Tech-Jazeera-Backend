# Real-Revenue Coordinator Targets (2026-09-27)

Replaces the 2026-09-22 estimate-based `MobilisationTarget` mechanism with a
pipeline based on money that actually arrived from the client, matching the
company's real operational process (Office Secretary enters hours → Clerk
invoices the client → Office Secretary records what's received → Financial
Manager approves → it credits the coordinator's target for the month the
work was for).

**Explicit framing from the user, driving every design choice here:**
"Accounting is done by ERPNext, our app is for HR and our manpower
management" — this pipeline deliberately does NOT become a second
accounting/invoicing system. It extends `Deployment.monthlyHours` (the
existing manpower-billing record staff already use daily) rather than the
formal, tax/VAT-shaped `Invoice`/`Quotation` models, which stay completely
untouched.

## M1 — Dashboard estimate: profit/hour, not profit/month

`dashboard.service.js`'s `computeActiveMobilisationRevenue`/`...Trend` (the
`finance.activeMobilisationRevenue` widget) now sum `Mobilisation.profitPerHour`
instead of `profitPerMonth` — the user's own ask, to stop conflating "how
much work is scheduled" with "how profitable it is."

## M2 — Own-Employee mobilisations excluded from the Riyal target

A coordinator's real value is bringing in supplied/outsourced workers, not
deploying the company's own staff. `mobilisationTarget.service.js` gained
`NON_OWN_EMPLOYEE_FILTER`, shared with the dashboard's Coordinator
Leaderboard/Drill-down so the three can never disagree. Own-Employee
mobilisations still surface as a plain `ownEmployeeCount` (not added to the
Riyal figure) on the target card and the management progress view.

## M3 — Per-coordinator revenue share

`Mobilisation.coordinators[].sharePercent` (nullable) — replaces the old
"every joint coordinator gets full credit" rule. All-or-nothing: either every
coordinator on a mobilisation has an explicit share summing to 100, or none
do (falls back to an even split). New `PUT/DELETE
/api/mobilisations/:id/coordinator-shares` (primary coordinator or Admin,
Draft/Rejected only), `mobilisation.service.js`'s exported
`effectiveSharePercent(mobilisation, coordinatorId)` is the one place this
logic lives. UI: an editable shares row on `MobilisationDetailPage` when
there are 2+ coordinators.

## M4 — Billing lifecycle on Deployment.monthlyHours

New fields, only reachable once an entry's hours are `Approved`:
`invoiceSentAt`/`invoiceSentBy`/`invoiceDueAt` (fixed 50-day window from send
time). No stored "billed amount" — `computeMonthlyRevenueAndExpenses`'s own
`revenue` figure already is that number, recomputed live like every other
financial figure in this app. New Section Access key `deploymentsInvoicing`
(the "Clerk" role — Admin-only until granted to an ApprovalRole) gates
`POST /api/deployments/:id/monthly-hours/:entryId/send-invoice`.

## M5 — Payment recording + Financial-Manager approval + real target credit

`amountReceived`/`paymentReceivedAt`/`paymentDecisionStatus` (`Pending`/
`Approved`/`Rejected`, plus `paymentDecidedBy`/`At`/`Note`) on the same entry.
Recorded by whoever holds `deploymentsHours` write (same as entering hours —
Office Secretary), decided by whoever holds the new `deploymentsPaymentDecide`
key (a different real person/role than hours approval). Editing
`amountReceived` after a decision resets it to `Pending` — the same
implicit-resubmit rule the hours entry itself already follows.

**`achieved` is now computed LIVE, never cached**: `mobilisationTarget.
service.js`'s `realRevenueByCoordinator(month)` aggregates every
Deployment.monthlyHours entry for that month with `paymentDecisionStatus:
'Approved'`, excludes Own-Employee deployments, and splits `amountReceived`
by each coordinator's `effectiveSharePercent`. This single function now
backs the coordinator's own Target card, the management Progress view, the
Coordinator Leaderboard's `profit` column, and the Drill-down modal's
`totalMonthlyProfit` — one definition, not four quietly-different ones.
Credit lands in the SERVICE month (the month the work was for), not the
month payment happened to arrive in — matches the user's own description
exactly ("once the amount for that month is received, we add it to their
target").

## M6 — Overdue tracking (new job, no new fields needed)

`notifications/deploymentBilling.job.js` (daily, same `setInterval` pattern
as `expiryAlert`/`mobilisationStale`/`overdueInvoice`):
- **Timesheet overdue** (45 days): an Active Deployment's fully-elapsed
  calendar month with no `monthlyHours` entry yet, 45+ days past month-end.
  Notifies `deploymentsHours` write members.
- **Payment overdue** (50 days): an invoiced entry (`invoiceSentAt` set)
  still not `Approved`, past its `invoiceDueAt`. Notifies both
  `deploymentsHours` and `deploymentsPaymentDecide` write members.

Both reuse `notifyUser`'s existing `dedupeKey` mechanism ("notify once,
ever, for this exact key") — no new "notifiedAt" tracking field needed.
**Verified live against real dev data on first boot**: found 5 real
timesheet gaps and notified real granted recipients — worth a sanity check
against production data once deployed, since some of that dev-data gap may
be legacy/test records rather than genuinely unresolved ones.

## M7 — Semi-annual tracker + crossing incentive

Rolling 6-month window ending at a selected month (not a fixed calendar
half). `MobilisationTarget` gained `semiAnnualIncentivePercent` — a
DIFFERENT, standing rate from the monthly `incentivePercent`; since a
rolling window pulls together up to 6 separate monthly target documents,
whichever was most recently edited is treated as the coordinator's current
standing rate (a deliberate simplification — no separate semi-annual
document — flagged to the user, not silently assumed).

`semiAnnualTarget` = SUM of each of the 6 months' own individual targets
(a coordinator's monthly target can change month to month). `excess` =
`max(0, achieved - semiAnnualTarget)`. The incentive applies ONLY to the net
profit behind the EXCESS (the user's confirmed rule), computed by applying
the whole window's own profit-to-revenue ratio to just the excess — the
closest honest approximation available, since profit isn't tracked per-riyal,
only per-placement. `realRevenueAndProfitByCoordinator(month)` reuses
`deployment.service.js`'s own exported `computeMonthlyRevenueAndExpenses`
(the same formula Deployment's own profit column already shows), scaled by
each entry's received/computed-revenue ratio before splitting by
coordinator share.

New endpoints: `GET /api/mobilisation-targets/semi-annual/my` (own),
`GET /api/mobilisation-targets/semi-annual` (management, gated same as
`/progress`). Client: a `SemiAnnualTargetCard` on the coordinator's own
dashboard, a "Semi-annual" tab in `ManageTargetsModal`.

## New Section Access keys (all Admin-only until granted)

- `deploymentsInvoicing` — send the client invoice (the "Clerk" step).
- `deploymentsPaymentDecide` — Financial-Manager approval of a recorded
  payment before it counts toward any target.

**User action needed**: grant these from the Section Access page (Sales →
Deployments card) to whichever real ApprovalRole should hold them (e.g. an
"Office Clerk" or "Accounts" role for invoicing, "Financial Manager" for
payment decisions) — nobody but Admin can use this pipeline until then.

## Verification

- 14/14 real-HTTP-equivalent assertions for M1/M2 (dedicated throwaway
  Employee/Coordinator/Mobilisations/Deployment, direct service calls,
  fully cleaned up afterward).
- 21/21 assertions for the full M3–M7 pipeline: a joint 70/30 mobilisation,
  send-invoice → record-payment → FM-decide → correct per-coordinator
  `achieved` split, leaderboard/drill-down agreement, and the semi-annual
  target/excess/net-profit/incentive math for both coordinators.
- A live browser click-through of the new Deployment billing UI (Send
  Invoice → Record Payment → the Approve confirmation modal), confirming
  exact copy/amounts/due-dates render correctly against real computed data.
- `eslint` clean (0 errors, 0 new warnings) across every touched file in
  both repos; a full client production build succeeded.
- All throwaway test data (users, mobilisations, deployments, targets,
  audit-log rows, notifications, refresh tokens) confirmed removed from the
  dev database after every run.

## Known simplifications (flagged, not silently decided)

- `semiAnnualIncentivePercent` has no dedicated document — see M7 above.
- Payment is a single cumulative `amountReceived`, not a ledger of
  individual installments — matches the process as described (one client
  payment per month's invoice); a real multi-installment need would extend
  this without a breaking change.
- The 45/50-day overdue job is company-wide, not Coordinator-scoped (same
  posture as the existing `expiryAlert`/`overdueInvoice` jobs).

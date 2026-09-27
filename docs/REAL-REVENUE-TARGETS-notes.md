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

## Follow-up (27 September 2026): real invoice tracking + escalating payment
## reminders + a Payments Due page

M4/M5 above tracked ONLY dates (`invoiceSentAt`/`invoiceDueAt`) and a plain
received amount — the user asked (from a screenshot of the Deployment
detail page's Monthly Hours table) for a real invoice-tracking layer on top:
who invoiced what, a real reference copy of the invoice, and reminders that
actually escalate as the due date approaches instead of firing once.

- **A real "Send Invoice" form.** `sendInvoice` now requires
  `invoiceNumber` + `invoiceDate` (both typed by the Clerk) plus an uploaded
  PDF copy of the real invoice — the invoice itself is still made in
  ERPNext, same M4/M5 framing; this is a reference copy for this app's own
  tracking, not a second source of truth. Reuses
  `financialRequests/reimbursement.model.js`'s exact receipt-upload shape
  (`middleware/upload.js`'s `uploadSingle`/`signedDownloadUrl`/
  `destroyDocumentFile`, Cloudinary, field name `"file"`) rather than
  inventing a second upload pattern. New `monthlyHoursSchema` fields:
  `invoiceNumber`, `invoiceDate`, `invoiceFile` (fileName/resourceType/
  originalName/mimeType/size — identical sub-shape to
  `ReimbursementClaim.receipt`). New `GET
  /api/deployments/:id/monthly-hours/:entryId/invoice-file` (signed
  download, mirrors `reimbursement.service.js`'s `getReceiptFile`).
- **Notify the Clerk the moment hours are Approved** — `decideMonthlyHours`
  now also notifies whoever holds `deploymentsInvoicing` write on Approve,
  closing the gap where invoicing only ever happened if someone remembered
  to check.
- **Notify on invoice sent** — once a Clerk sends the invoice, a new
  `paymentTrackingAudience()` helper notifies both the mobilisation's own
  coordinators AND whoever holds `mobilisationsViewer` write (reused as the
  "MM" audience, not a new Section Access key — the same broad-visibility
  circle that already sees this mobilisation's commercial data once
  Approved).
- **Escalating reminders, replacing the old one-shot 50-day check.**
  `deploymentBilling.job.js`'s payment-overdue check was rewritten as
  `checkPaymentDueEscalation`: a new `escalationStage(daysRemaining)`
  helper fires at 10/5/3/2/1/0 days remaining (`t-minus-N`, each a distinct
  dedupe key so every milestone notifies exactly once), then — once
  genuinely overdue — fires EVERY SINGLE DAY (`overdue-N`, N = days past
  due, still unique per day so it keeps nagging rather than going silent
  after one notification). Audience is the same `paymentTrackingAudience()`
  used for "invoice sent" (coordinators + MM) — a real fix, not just a
  rename: the previous one-shot version notified `deploymentsHours`/
  `deploymentsPaymentDecide` write members instead, the wrong audience for
  a "your client owes money" nag. `checkTimesheetOverdue` (the 45-day
  timesheet-missing check) is unchanged.
- **A real "Payments Due" list + dashboard row.** `getPaymentsDue(actor)`
  returns every invoiced-but-not-fully-approved monthly-hours entry across
  every Deployment, soonest-due first — same visibility rule as
  `paymentTrackingAudience`: a Coordinator sees only mobilisations they're
  on, anyone holding `mobilisationsViewer` read sees everything. New client
  page `PaymentsDuePage.jsx` at `/deployments/payments-due` (no dedicated
  Section Access gate on the route — the data is already correctly scoped
  server-side, same reasoning as the Mobilisation worker-history page),
  reached from a new "Payments Due" Sales & Clients nav entry, sibling to
  Standby List. A new `countPaymentsDueSoon(actor)` (reuses
  `getPaymentsDue`, filtered to `daysRemaining <= 10` — deliberately the
  same window the escalation job starts nagging at, so this count only
  ever moves in step with when a coordinator/MM actually starts getting
  reminders) backs a new "Payments due soon" row in the dashboard's
  existing "Waiting on you" widget (`getMyPendingActions`), linking to the
  same page.

**Verified**: a disposable Client/Coordinator/other-Coordinator/Admin/
Mobilisation/Deployment fixture (4 monthly-hours entries: soon-due,
overdue, far-due, already-Approved) exercised directly against
`getPaymentsDue`/`countPaymentsDueSoon`/the full `getDashboard()` code
path — 12/12 assertions: the mobilisation's own coordinator sees exactly
the 3 non-Approved entries sorted soonest-first, an unrelated coordinator
sees none, Admin sees everything via the `mobilisationsViewer`
short-circuit, and the dashboard's "Payments due soon" row shows the
correct count (2 — soon + overdue, not the far one) for the coordinator on
the mobilisation and is entirely absent (not zero — filtered out, same as
every other "Waiting on you" row) for the unrelated one. Full server test
suite re-run green (42/42) and `eslint` clean (0 errors) across every
touched file in both repos. A live browser click-through (throwaway test
admin, cleaned up after) confirmed: the "Payments Due" nav entry and page
render correctly in both English and Arabic (including full RTL layout —
screenshot-verified), the empty state renders correctly against real dev
data (no invoice has been sent through the new form yet, so nothing is
due), and the dashboard's "Waiting on you" widget correctly shows no
"Payments due soon" row while the real count is zero. All throwaway
fixtures (client, users, mobilisation, deployment, refresh tokens,
audit-log rows) confirmed removed from the dev database afterward.

## Follow-up (27 September 2026): "estimate" labeling gap on Mobilisation's
## rate-card profit fields, found from a user screenshot comparison

The user compared two dashboard/report screens and flagged what looked like
a data inconsistency: the new "Actual Performance" widget showed a NEGATIVE
profit per hour (-2.53) for August 2026, while the Deployment Overview
export's totals row showed a large POSITIVE "Profit per hour" (131.00) for
the same live data. These are not actually in conflict — they are two
fundamentally different numbers that happen to share a near-identical
column name:

- **"Actual Performance"'s `profitPerHour`** = real net profit (verified
  `amountReceived` minus real recorded expenses) ÷ real worked
  `actualHours`, for one specific closed calendar month. August 2026 is
  negative simply because real expenses (FTA/allowance/mobilisation cost/
  deductions) were recorded but no client payment had yet been verified as
  received for that month (`amountReceived: 0`) — an honest, expected state
  early in a billing cycle, not a bug.
- **The Deployment Overview / Mobilisation export's `profitPerHour`/
  `otProfitPerHour`** = `Mobilisation.profitPerHour`/`otProfitPerHour` — a
  pure rate-card figure (`clientRate - clientCommission [- subcontractor
  side]`, `otClientRate - otEmployeeRate`) computed once at mobilisation
  time, per the model's own doc comment: "This is a pre-deployment ESTIMATE
  off the contracted/target hours only." It has no dependency on whether
  those hours were ever actually worked, invoiced, or paid.

The REAL gap, once traced: `profitPerMonth`'s i18n label already said
"Profit per month (estimate)", but its two siblings computed from the
exact same rate card — `profitPerHour`/`otProfitPerHour` — carried no such
qualifier anywhere they're shown (`MobilisationDetailPage`, the Deployment
Overview modal/export, and the dashboard's "Company/Your active
mobilisation profit per hour" card). A viewer had no label-level cue that
two adjacent "profit per hour" figures on different screens were entirely
different KINDS of number. Fixed by extending the SAME existing
`profitPerMonth (estimate)` convention to its two siblings — a pure
labeling fix, zero calculation logic touched:
- `staffMobilisations.detail.fields.profitPerHour`/`otProfitPerHour` →
  "Profit per hour (estimate)" / "OT profit per hour (estimate)" (en);
  matching "(تقديري)" suffix added in ar.
- The dashboard's `activeRevenue` widget hint gained an explicit
  cross-reference: "…a rate-card estimate, not a real received payment
  (see Actual Performance below for that)" — chosen over adding "(estimate)"
  to the card's own all-caps title, since the two widgets sit directly
  stacked on the dashboard (the exact layout in the user's own screenshot)
  and the hint text is always visible, not a hover-only tooltip.

**Verified**: JSON validity + full en/ar key-parity check on both locale
files; `eslint` clean; a live browser click-through (throwaway admin,
cleaned up after) confirmed the new "(estimate)"/"(تقديري)" labels render
correctly on the Deployment Overview modal (screenshot-matched against the
user's own reported screenshot) and on `MobilisationDetailPage`, and the
dashboard's active-mobilisation-profit-per-hour hint now reads correctly
in Arabic with a working cross-reference to "الأداء الفعلي" (Actual
Performance).

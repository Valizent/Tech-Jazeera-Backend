# Bulk client-payment ledger (27 September 2026)

## Why

The user corrected a fundamental assumption in the per-worker payment
tracking built earlier the same day (`docs/REAL-REVENUE-TARGETS-notes.md`'s
M4/M5): **a client doesn't pay per worker.** With 50 employees placed at one
client, the client sends ONE bulk payment covering everyone that month, not
50 separate transfers. Recording "amount received" against one worker's one
invoice in isolation (the old `Deployment.monthlyHours.amountReceived`/
`paymentDecisionStatus`) never matched that reality — there was no way to
represent "the client paid 17,000 against a total of 20,500 owed across
everyone," only "this one worker's invoice: received X."

**Design, confirmed directly with the user before writing any code** (via
`AskUserQuestion`, six questions across three rounds, all six answers took
the recommended option):

1. **Who pays in bulk**: always the Client, regardless of worker type
   (Employee/SupplierEmployee/Freelancer) — never the Subcontractor. A
   "filter by supplier" ask on the Payments Due page is a **display filter
   only**, not a second aggregation level.
2. **Invoice granularity unchanged**: each worker's month still gets its own
   invoice (the existing Ready to Invoice flow, untouched). Only *payment*
   became bulk — one payment gets allocated across whichever of that
   client's invoices are still outstanding.
3. **Underpayment**: stays owed against the specific invoices it didn't
   cover, until a LATER payment (whenever that happens) clears them —
   oldest outstanding invoice first, not merged into "next month's total."
4. **Allocation algorithm**: FIFO — oldest invoice-date first, fully filling
   each before spilling into the next, until the payment is exhausted.
5. **Approval step kept**: Financial Manager still signs off on a recorded
   bulk payment before it counts (matches the existing Office-Secretary-
   records/FM-approves split).
6. **No data migration**: nothing in the live dev DB had ever reached a
   decided per-entry payment state (confirmed by direct query before
   deciding this — both of the user's own example invoices were equally
   "never paid yet"), so the old fields were removed outright rather than
   kept alongside a migration path.

## The core design decision: nothing is stored beyond the raw payments

`ClientPayment` (new collection, `server/src/modules/deployments/
clientPayment.model.js`) is the *entire* ledger: `client`, `amount`,
`recordedBy`/`At`, `decisionStatus` (Pending/Approved/Rejected), `decidedBy`/
`At`/`note`. **How much of that money applies to which specific invoice is
never stored anywhere** — it's recomputed live, every time, by
`allocateClientPayments` (`clientPayment.service.js`): sort every invoiced
item for a client oldest-first, sum every Approved payment as one pool, walk
the sorted list filling each until the pool runs out. Whatever's left over
once every current invoice is fully covered is an **implicit credit
balance** — it needs no field of its own, since the next call that includes
a newer invoice (once one exists) simply sees a bigger pool and applies it
automatically. This is the same "never cache a financial figure, recompute"
discipline `computeMonthlyRevenueAndExpenses` (revenue/profit) already
follows — extended here to the payment side too.

**Avoiding a circular service dependency**: the allocation math
(`clientPayment.service.js`) knows nothing about Deployment/Mobilisation/how
an invoiced amount is priced — that domain knowledge stays in
`deployment.service.js`, which gathers the priced items and calls INTO
`clientPayment.service.js`'s pure `allocateClientPayments(clientId, items)`.
One direction only: `deployment.service.js` → `clientPayment.service.js`,
never the reverse (matching this app's existing rule — see
`deployment.service.js`'s own top doc comment on why it depends on
Mobilisation's MODEL, never its service, for the same reason).

## What changed

**Server**:
- New `clientPayment.model.js` + `clientPayment.service.js` (allocation
  math, `recordClientPayment`, `decideClientPayment`, payment-history
  lookup, notification audience).
- `Deployment.model.js`'s `monthlyHoursSchema` lost `amountReceived`/
  `paymentReceivedAt`/`paymentDecisionStatus`/`paymentDecidedBy`/
  `paymentDecidedAt`/`paymentDecisionNote` entirely.
- `deployment.service.js`: `getPaymentsDue`/`recordPayment`/`decidePayment`
  replaced by `getClientsPaymentSummary` (one row per client),
  `getClientPaymentDetail` (per-client drill-down), and a new shared
  `getClientAllocation`/`gatherClientInvoicedItems` pair every other
  consumer below reuses. `getDeployment` now attaches each invoiced entry's
  own live `amountAllocated`/`balanceDue`/`fullyPaid` — visible to the same
  audience `amountReceived` used to be (never commercial-gated; Office
  Secretary/Clerk need it without needing `deploymentsHoursDecide`).
  `getActualPerformanceSummary` (the dashboard's real-profit widget) now
  sums live allocations, batched one ledger walk per distinct client
  represented in the period, not per entry.
- `mobilisationTarget.service.js`'s `realRevenueByCoordinator`/
  `realRevenueAndProfitByCoordinator` (the coordinator-target crediting
  engine) read the same live allocation instead of a manually-typed amount
  — barely changed, since the share-splitting math was already built to
  take "however much was received" as an input.
- `deploymentBilling.job.js`'s escalating payment-due reminders now check
  live `balanceDue > 0` per entry (one ledger walk per distinct client)
  instead of a per-entry `paymentDecisionStatus`.
- New routes: `GET /api/deployments/payments-due` (now client rows), `GET
  /api/deployments/payments-due/:clientId` (drill-down), `POST
  /api/deployments/payments-due/:clientId/payments` (record), `PATCH
  /api/deployments/client-payments/:paymentId/decide` (FM decide). No new
  Section Access keys — reuses `deploymentsHours`/`deploymentsPaymentDecide`
  exactly as before, just re-scoped to a client instead of an entry.

**Client**:
- `PaymentsDuePage.jsx` rewritten: one row per client (name, outstanding
  invoice count, total outstanding, urgency badge), a "filter by supplier"
  dropdown (built from the union of `subcontractorNames` across rows — a
  display filter, confirmed not a second aggregation level), a drill-down
  modal (every invoice with its own allocation/balance, real payment
  history with Approve/Reject for a Pending one), and the Record Payment
  modal (moved here from the Deployment detail page).
- `DeploymentDetailPage.jsx`'s monthly-hours table: the "Profit" column
  became "Profit / Due" — a not-yet-invoiced entry shows **Expected
  profit** (the estimate, unchanged formula); an invoiced-but-not-fully-paid
  entry shows **Amount Due** (`balanceDue`) as the primary figure instead of
  profit (the user's own direct ask: "instead of just showing profit show
  the total amount due"); a fully-paid entry shows **Actual profit** (same
  number as Expected profit always was — `revenue − expenses` — only the
  label changes, since FIFO guarantees `amountAllocated === revenue` exactly
  once `fullyPaid` is true). `BillingStatus` now reads `fullyPaid`/
  `amountAllocated`/`balanceDue` instead of the removed per-entry decision
  fields. Every Send-Invoice/Record-Payment/Decide-Payment action already
  lived on the two Financial pages (from the same-day earlier Invoice/
  Quotation-removal pass) — this page stays read-only for billing.

## Verification

- A 30-assertion disposable-fixture script (`Client`/`Mobilisation`
  [70/30 joint share] /`Deployment` with 3 invoiced months of different
  amounts, 3 `ClientPayment` records exercising partial-fill, exact-fill,
  overpayment-with-credit-carryover, and rejection) against
  `getClientAllocation`/`getClientsPaymentSummary`/`getClientPaymentDetail`/
  `recordClientPayment`/`decideClientPayment`/`realRevenueByCoordinator` —
  all 30 passed, including the credit balance auto-applying to a 4th
  invoice added afterward, and the 60/40 coordinator split crediting
  correctly off the live allocation.
- Full server suite green (34/34), `eslint` clean (0 errors) on both full
  repos, a real server boot with no circular-import failure, a clean client
  production build.
- Full en/ar i18n key parity; every dead key from the old per-entry payment
  UI (`recordPaymentButton`/`recordPaymentModalTitle`/etc. under
  `staffDeployments.detail`) removed, not left orphaned.
- Live browser click-through (throwaway admin, fully cleaned up after)
  against real dev data: the Payments Due list correctly grouped Sharuk
  Khan's and Babu Ram's real invoices under their real clients (UNITED ARK
  CONTRACTING, ERAM COMPANY LTD), the supplier filter listed the real
  "MERMAID" subcontractor, the drill-down modal rendered the real invoice
  breakdown and empty payment history correctly in Arabic/RTL, the Record
  Payment modal opened with correct fields (not submitted, to avoid
  mutating real financial data without being asked), and the Deployment
  detail page correctly showed "Amount Due: ⃁9,000.00" for the invoiced-
  unpaid entry and "Expected profit: ⃁1,400.00" for the not-yet-invoiced
  one — both real, live-computed figures matching the Payments Due page's
  own numbers exactly.

## Known follow-ups, not done (flagged, not silently skipped)

- No "Client payment history" tab was added to the Client profile page
  itself — the drill-down lives only on the Payments Due page. A natural,
  low-risk future addition if the user wants it there too.
- The credit-balance carryover is entirely implicit (recomputed, never
  displayed as a standing balance anywhere except the Payments Due
  drill-down's own banner when one exists). If the user wants a company-
  wide "which clients are sitting on a credit balance" report, that's a new
  small aggregate query, not built here since it wasn't asked for.

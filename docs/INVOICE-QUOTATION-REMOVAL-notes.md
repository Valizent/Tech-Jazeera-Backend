# Invoice/Quotation/CreditNote module removal + Financial billing relocation (27 September 2026)

## Why

The user drew a hard line, restated more forcefully than an earlier session's
similar note (see `docs/REAL-REVENUE-TARGETS-notes.md`'s own framing):
**real accounting — client invoices, credit notes, VAT/ZATCA compliance — is
ERPNext's job.** This app is for HR/manpower management plus the *internal*
financial matters that originate from staff/worker actions and need
Accounts/FM approval (Salary Advances, Reimbursements, Expenses). A recent
addition (outside this session — see `docs/DASHBOARD-EXTRAS-notes.md`'s own
precedent for work landing between sessions) had grown the Invoice module
into a genuinely accounting-shaped system (ZATCA QR codes, Credit Notes, a
payment ledger) sitting in the Financial nav next to Salary Advances — the
exact duplication the user objected to, and the trigger for this pass.

Separately, the user could not find where "the Clerk" was supposed to record
an invoice at all — the answer was a `deploymentsInvoicing`-gated button
buried inside a specific Deployment's detail page, reachable only via a
notification or by already knowing which deployment/month needed it. No
dedicated work queue existed.

**Decisions, confirmed directly with the user before touching anything**
(via `AskUserQuestion`, all four answered explicitly):
1. Invoice + Credit Note module: **removed entirely** (not hidden) — code,
   routes, nav, DB collections.
2. Quotations: **removed too** (it only ever existed to feed Invoice).
3. The Deployment billing tracker (`invoiceNumber`/`invoiceDate`/PDF
   copy/`amountReceived`/FM approval, built the previous session
   specifically to avoid duplicating Invoice — see
   `docs/REAL-REVENUE-TARGETS-notes.md`'s M4/M5): **kept as-is**, but moved
   out of the Deployment detail page into a dedicated Financial-section
   home.
4. A real Clerk work-queue ("Ready to Invoice"), symmetric to the existing
   Payments Due page: **built**.

## What was removed

**Server** — three whole module folders deleted (`invoices/`, `quotations/`,
`creditNotes/`, 20 files), plus their only Invoice-specific background job
(`overdueInvoice.job.js`) and three utilities that became fully orphaned
once those modules were gone: `zatcaQr.js`, `pdfLineItemTable.js`,
`moneyMath.js`. `quotations/counter.model.js` — a generic atomic
sequence-number utility that happened to live inside the Quotation folder
by historical accident — was relocated to a new `modules/shared/` before
the folder was deleted; Mobilisation (`MOB-0001` serials) and Requirements
(`REQ-0001` serials) both depend on it and have nothing to do with
Quotation.

`app.js`/`server.js` lost their route mounts and job wiring for all three.
`dashboard.service.js` lost its entire Invoice-based `getProfitOverview()`
(the old `finance.profit` figure, `Revenue from invoices − Payroll −
Expenses`) and every Quotation-derived field
(`quotationsByStatus`/`approvedRevenue`/`pendingRevenue`/`pendingQuotations`)
— **not replaced**, since `finance.actualPerformance` (Approved Deployment
monthly-hours + verified client payments, see
`docs/REAL-REVENUE-TARGETS-notes.md`) already exists as the honest,
non-duplicating real-profit figure, gated by the exact same
`dashboardProfit` Section Access key. The now-fully-unused `month` query
param on `GET /api/dashboard` was removed end to end (controller, Zod
schema, client API call, `DashboardPage.jsx`'s own vestigial constant) —
it existed only to feed the deleted function. `sectionAccess.model.js`/
`.service.js` lost the `invoices`/`quotationsManage` keys.
`reconciliation.service.js` lost its Invoice-ledger integrity check
(the other two checks — orphaned Mobilisation, double-booked worker,
SalaryAdvance ledger, PayrollRun totals — are untouched).

**Client** — `features/invoices/` and `features/quotations/` deleted
whole (22 files). `router.jsx`/`navConfig.js` lost every route/nav entry.
`ClientProfilePage.jsx` lost its Quotations/Invoices tabs.
`FinancialHubPage.jsx` gutted back to a plain directory (its old
live "N overdue" badge was Invoice-specific). `lib/constants.js` lost
`INVOICE_*`/`QUOTATION_*`/`DEFAULT_TAX_RATE`. Two files turned out to
already be fully orphaned (pre-existing, unrelated to this pass, found
while tracing what fed the removed dashboard fields) and were deleted too:
`ProfitCard.jsx` (never imported since the 2026-09-24 dashboard redesign
superseded it) and `QuickActions.jsx` (superseded by `DashboardPage.jsx`'s
own inline `QUICK_ACTIONS` array). A matching i18n sweep removed
`staffQuotations`, `staffInvoices` (with its nested `creditNotes` block),
every related nav/tab/quick-action key, and two more pre-existing dead
blocks found along the way (`staffDashboard.pipeline`/`staffDashboard.profit`
— remnants of the pre-2026-09-24 dashboard layout, referenced nowhere in
any component).

**Confirmed fully independent, nothing touched**: Deployment's own
`sendInvoice`/`invoiceNumber`/`invoiceFile` fields (plain metadata/file-
upload tracking, never a reference to the Invoice model) and Mobilisation's
`clientQuotation`/`subQuotation` (free-text paper-trail fields, never a
reference to the Quotation model) and Payroll (zero references at all).

## What was built: the Financial billing relocation

- **New server capability**: `getReadyToInvoice(actor)`
  (`deployment.service.js`) — every Approved-but-not-yet-invoiced
  monthly-hours entry across every Deployment, oldest-approved-first.
  Gated by `deploymentsInvoicing` OR `mobilisationsViewer` read — a
  coordinator never invoices their own placements, so (unlike
  `getPaymentsDue`) they get no view here at all; only the Clerk/MM/Admin
  circle that actually acts on this queue. New route `GET
  /api/deployments/ready-to-invoice`.
- **New client page** `ReadyToInvoicePage.jsx` at
  `/financial/ready-to-invoice` — the Clerk's real work queue. The
  Send-Invoice modal (invoice number/date/PDF upload) moved here verbatim
  from `DeploymentDetailPage.jsx`.
- **`PaymentsDuePage.jsx`** (existing, previously read-only) gained real
  actions: Record Payment (Office Secretary / `deploymentsHours`) and
  Approve/Reject (`deploymentsPaymentDecide`, the Financial Manager) —
  moved here verbatim from `DeploymentDetailPage.jsx`. Its route moved from
  `/deployments/payments-due` to `/financial/payments-due`.
- **`DeploymentDetailPage.jsx`** now shows only a **read-only** Billing
  status readout (unchanged `BillingStatus` component) plus an
  invoice-file download button — every action (Send Invoice/Record
  Payment/Approve/Reject Payment) and their mutations/modals were removed
  from this page entirely, not just hidden.
- **`navConfig.js`**: "Ready to Invoice" and "Payments Due" both live under
  the **Financial** nav group now (previously Payments Due sat under
  Sales & Clients). No new Section Access keys — both pages reuse
  `deploymentsInvoicing`/`deploymentsHours`/`deploymentsPaymentDecide`/
  `mobilisationsViewer`, all of which already surface under the existing
  "Deployments" card on the Section Access page.

## Data safety

Dev DB held exactly 1 real Invoice, 1 real Quotation, 0 Credit Notes before
deletion — exported to a JSON backup file (kept outside the repo, in the
session's own scratchpad) before any code was removed. The MongoDB
collections themselves were **not dropped** — they're now inert (nothing in
either app can read/write them), left in place as the safer default;
dropping them is a separate, explicit action for the user to request if
they actually want the collections gone. **Production's own Invoice/
Quotation/CreditNote data was never inspected or touched from this
session** — no credentials to that database exist here.

## Verification

- Full server test suite: 34/34 green (down from 42 — the 8 lost tests were
  `invoice.service.test.js`/`creditNote.service.test.js`, deleted with
  their modules; no other test touched Invoice/Quotation).
- `eslint .` clean (0 errors) on both repos, full codebase, not just
  touched files — confirms no dangling import survived the deletion.
- A real `node src/server.js` boot connected to MongoDB and reached the
  `app.listen` call cleanly (only failure was the already-running dev
  instance holding port 5000) — proves every import in the boot chain
  resolves.
- Client production build clean; the `en`/`ar` locale chunks shrank
  measurably (en: 89.89 kB → 84.02 kB; ar: 124.87 kB → 115.63 kB),
  confirming real dead-weight removal, not just hidden UI.
- Full en/ar JSON key-parity check, both locale files.
- Live browser click-through (throwaway admin, fully cleaned up after —
  refresh tokens + audit rows deleted): Financial hub shows exactly Ready
  to Invoice/Payments Due/Payroll/Expenses/Financial Requests; Ready to
  Invoice correctly lists a real Approved-uninvoiced month (Sharuk Khan ×
  UNITED ARK CONTRACTING, 2026-08) with a working Send Invoice button
  (not clicked, to avoid mutating real data); Payments Due correctly lists
  a real invoiced-unpaid month (Babu Ram × ERAM COMPANY LTD, 2026-05) with
  a working Record Payment button (likewise not clicked); the same
  Deployment's own detail page shows the read-only "Invoiced — due 16 Nov
  2026 / Invoice 25010" badge with Edit/Download-only actions, no
  Send-Invoice/Record-Payment/Decide-Payment controls; Sales & Clients hub
  has no Quotations entry; a real Client profile has no Quotations/Invoices
  tabs; the Dashboard loads cleanly with no Quotations-by-status widget and
  no `month` query param on its own request. Confirmed via the app's own
  audit log that the real user was concurrently exercising the new Ready to
  Invoice page during this verification (a real invoice-sent + hours-decide
  event appeared mid-session) — independent, incidental confirmation the
  feature works outside this session's own testing too.

## Known follow-ups, not done (flagged, not silently skipped)

- The dev DB's `invoices`/`creditnotes`/`quotations` collections still
  physically exist (inert). Drop them only on explicit request.
- `FinancialHubPage.jsx` could regain a live badge (e.g. "N ready to
  invoice") the way it used to have an Invoice-overdue one — not built,
  since it wasn't asked for; flagged as a natural, low-risk future
  enhancement given the pattern already exists.
- Production's own Invoice/Quotation/CreditNote data (if any) is
  unaffected by this session — this only touched code and the local dev
  database.

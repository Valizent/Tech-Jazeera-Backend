# P2-M6 — Invoices & payments

Continues the Phase 2 backbone (see `docs/PHASE2-PLAN.md`). Closes the
revenue loop: Quotation (offer) → Invoice (billed) → Payments (collected) —
the other half of profit alongside P2-M5's payroll cost figure.

## What was built

**New module — `server/src/modules/invoices/`**
```
invoice.model.js       # Invoice — created from an Approved Quotation;
                         #   lineItems/totals are COPIED and frozen at
                         #   creation, never re-derived from a quotation
                         #   that might later change; one invoice per
                         #   quotation (unique index)
invoice.validation.js, .service.js, .controller.js, .routes.js
                         # mounted at /api/invoices
invoice.pdf.js           # reuses quotation.pdf.js's exact layout, plus a
                          #   payments/balance section

client/src/features/invoices/
  invoices.api.js, invoices.schema.js
  components/InvoicePdfButton.jsx    # mirrors QuotationPdfButton
  components/invoiceColumns.jsx      # mirrors quotationColumns
  components/InvoicesPanel.jsx       # the client-profile "Invoices" tab
  pages/InvoiceListPage.jsx          # every invoice, search + status filter
  pages/InvoiceViewPage.jsx          # detail, record-payment, PDF, delete
client/.../clients/pages/ClientProfilePage.jsx   # + Invoices tab
client/.../quotations/pages/QuotationViewPage.jsx
  # + "Create invoice" (Approved, none exists yet) / "View invoice"
  #   (Approved, one already exists) — no standalone "new invoice" flow;
  #   an invoice is always born from a quotation
client/src/app/router.jsx, DashboardLayout.jsx    # + /invoices, /invoices/:id
client/src/lib/constants.js  # + INVOICE_STATUSES, INVOICE_WRITE/DELETE_ROLES
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/invoices` \| `/:id` | any authenticated staff | list / view |
| GET | `/api/invoices/:id/pdf` | any authenticated staff | download the invoice PDF |
| POST | `/api/invoices` | Admin, Manager, Accounts | create from an Approved quotation |
| POST | `/api/invoices/:id/payments` | Admin, Manager, Accounts | record a payment |
| DELETE | `/api/invoices/:id` | Admin, Manager | remove (only if no payments recorded) |

## Key decisions & why

- **One invoice per quotation, no partial/split billing.** The plan asks for
  a straightforward "convert an approved offer into a bill," not a
  multi-invoice-per-quotation workflow — that would be a deliberate, larger
  feature nobody asked for. The unique index on `quotation` is the hard
  backstop; the service also gives a friendly "already has an invoice
  (INV-000X)" message, which the UI uses to show "View invoice" instead of
  a second "Create invoice" button.
- **An invoice's line items and totals are frozen at creation**, copied from
  the quotation rather than referencing it live. A Quotation stays editable
  after approval (until this milestone, nothing stopped that); an already-
  issued bill must never silently change because someone tweaked the source
  quotation afterward. There is deliberately no "Draft invoice" state — an
  invoice only exists once actually issued.
- **Payments are an append-only ledger, exactly like the salary-advance
  repayment ledger (P3-C)** — `amountPaid`/`balanceDue`/`status` are always
  recomputed from the `payments` array, never trusted or set directly.
  Verified the same over-balance guard works here too (a payment exceeding
  the balance due is rejected with the exact balance in the message).
- **Deleting is blocked the moment any payment exists.** An invoice with
  money already recorded against it is a real financial event; only a
  genuinely unissued mistake (zero payments) can be removed — verified both
  the blocked and the allowed path directly.
- **Same write/delete role circle as Quotation** (Admin/Manager/Accounts to
  create/record payments, Admin/Manager to delete) — an invoice is the
  direct continuation of a quotation, not a new business process with its
  own permission model.

## Verified (2026-08-29)

**curl** (throwaway admin + HR login, deleted after), with a real client and
quotation:

- Creating an invoice from a **Draft** quotation → 400; approving the
  quotation then creating the invoice → 201, with `balanceDue` correctly
  starting equal to `grandTotal` (11,500) and status `Unpaid` — this
  specific figure was hand-checked against a bug caught during review
  (the schema's own default would have left `balanceDue` at 0 if not set
  explicitly at creation; fixed before it ever ran against real data).
- A second invoice from the same quotation → 409 with the existing
  invoice's number in the message.
- A payment exceeding the balance due → 400; a partial payment (5,000 of
  11,500) → `Partially Paid`, `balanceDue: 6500` exactly; the final payment
  (6,500) → `Paid`, `balanceDue: 0`; a further payment attempt → 400.
- Deleting a **paid** invoice (has payments) → 400; deleting a **fresh,
  unpaid** invoice with zero payments → 200, confirming the guard is on
  "has payments," not "is Unpaid."
- The generated PDF was downloaded and its actual text read back: correct
  invoice number, dates, quotation reference, status, line item, all four
  totals, and both payments listed with method and reference.
- HR could view invoices (200) but not create one (403) — same write
  circle as Quotation, verified directly rather than assumed.

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint noted
throughout this work — see `docs/P3-B-notes.md`). Every code path,
including the exact money math and the real generated PDF, was verified via
curl.

**Cleanup**: throwaway admin/HR logins, the test employee, the test client,
both test quotations, the remaining test invoice, their refresh tokens, and
the audit-log rows were deleted. The quotation/invoice atomic counters were
left as they are — a numbering gap from deleted test records is normal and
expected in any sequential-numbering system, and resetting them risks a
collision with real documents rather than fixing anything.

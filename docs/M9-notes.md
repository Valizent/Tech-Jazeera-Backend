# M9 — Quotation Management

Quotations with labour/trading line items, per-line discount and tax,
server-computed totals, statuses, duplicate, and PDF generation.

## What was built

**Backend** (`server/src/modules/quotations/`)
```
counter.model.js        # atomic sequence → QT-0001, QT-0002, …
quotation.model.js      # embedded line items; stored computed totals
quotation.validation.js # Zod: create / update / list / id
quotation.service.js    # CRUD, duplicate, and the authoritative money math
quotation.pdf.js        # pdfkit quotation document
quotation.controller.js # HTTP; /pdf streams a file
quotation.routes.js     # RBAC guards
```

**Frontend** (`client/src/features/quotations/`)
```
quotations.api.js               # incl. authenticated PDF blob download
quotations.schema.js            # form schema + client-side totals mirror + mapping
components/QuotationForm.jsx     # dynamic line items + LIVE totals preview
components/QuotationsPanel.jsx    # client-profile Quotations tab
components/quotationColumns.jsx / QuotationPdfButton.jsx
pages/QuotationListPage / NewPage / EditPage / ViewPage
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/quotations` | any authed | list (client, status, search) |
| GET | `/api/quotations/:id` | any authed | one quotation |
| GET | `/api/quotations/:id/pdf` | any authed | download PDF |
| POST | `/api/quotations` | Admin/Manager/Accounts | create |
| PATCH | `/api/quotations/:id` | " | update (recomputes totals) |
| POST | `/api/quotations/:id/duplicate` | " | copy → new Draft |
| DELETE | `/api/quotations/:id` | Admin/Manager | delete |

## Key decisions & why

- **Totals are server-authoritative.** `computeTotals` runs on every create/
  update from the line items; the request's own totals are never read (Zod
  doesn't even include them). Verified by sending `grandTotal:0`/
  `subtotal:999999` — the server ignored them and stored the real 6325. The
  client mirrors the math only for a **live preview**; it's never trusted.
- **Money math, per line:** `gross = qty × unit`; `discount = gross × disc%`;
  `net = gross − discount`; `tax = net × tax%`. Grand total =
  `subtotal − discountTotal + taxTotal`. Rounded to 2 dp. Discount and tax are
  percentages; VAT defaults to 15 (KSA).
- **Sequential numbers via an atomic counter** (`findByIdAndUpdate($inc)`),
  not "max + 1" — the latter is racy and breaks on deletes.
- **`clientName` snapshot** on the quotation so a printed/duplicated quote
  keeps the name it was issued under even if the client is renamed/removed.
- **Line items embedded** (they live and die with the quotation).
- **Duplicate → fresh Draft** with a new number and today's date, copying line
  items and notes. New quotes always start editable.
- **PDF via pdfkit** (already in the stack from M7) — a printable quotation
  with header, client block, line-item table, and totals.

## Frontend pattern: live totals preview

`QuotationForm` uses `useFieldArray` for the line items and `useWatch` to
recompute totals as you type, via the same formula the server uses. This gives
instant feedback while the server stays the source of truth on save.

## Integration

Client profile gains its **Quotations tab** — the last of the three M5
deferrals (Documents, Quotations) now resolved. All client tabs are backed by
real queries; no placeholder tabs were ever shipped.

## Common beginner mistakes

- **Trusting client-sent totals.** Always recompute server-side; a tampered
  request could otherwise set any price. (Verified the server ignores them.)
- **"Max number + 1" for sequential ids.** Racy and wrong after deletes. Use
  an atomic counter document.
- **Floating-point money bugs.** Round to 2 dp with a consistent helper on
  both sides (`Math.round((n + EPSILON) * 100) / 100`).
- **Not snapshotting the client name.** A quote printed months later must show
  the name at issue time, not follow later renames.

## Debugging tips

- Grand total looks off by a rounding cent? Check the per-line order:
  discount before tax, tax on the discounted (net) amount.
- Duplicate keeps the old status? It shouldn't — duplicates are forced to
  Draft. If not, check `duplicateQuotation`.
- PDF 200 but nothing opens? It downloads (attachment); check the browser's
  downloads. Structure is validated (`%PDF` … `%%EOF`).

## Verified (2026-07-23)

**curl:** create with 2 lines → totals subtotal 6000 / discount 500 / tax 825 /
**grand 6325** while injected `grandTotal:0`/`subtotal:999999` were IGNORED ·
sequential QT-0001, QT-0002 · no-line-items 400 · update recomputes (→ 11500) ·
duplicate → new Draft QT-0003 · **PDF valid** (%PDF, %%EOF, 2064 bytes) ·
status filter · delete · HR create 403 / read 200.

**Browser:** quotations list (formatted totals, status badges, PDF buttons) ·
create with dynamic line items and **live totals updating as you type**
(1 line → 1150, 2 lines → 1610) → QT-0004 created · detail view with line-item
table and totals · PDF downloads (200, no error) · duplicate → QT-0005 Draft ·
client profile **Quotations tab** lists the client's quotes · mobile 375px:
list cards and the form both fit, no horizontal scroll · no console errors.

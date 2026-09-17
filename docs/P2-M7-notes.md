# P2-M7 — Expenses

Resumes the Phase 2 backbone (see `docs/PHASE2-PLAN.md`). The other half of
profit alongside P2-M6's invoices: a company-level cost ledger. P2-M8
(Dashboard v2) computes Profit = Revenue − Payroll − Expenses from the three
modules this backbone now has (Invoices, Payroll, Expenses).

## What was built

**New module — `server/src/modules/expenses/`**
```
expense.model.js        # Expense — date, category, vendor, amount, optional
                         #   client+deployment links (reference+snapshot,
                         #   same pattern as Deployment/Quotation), optional
                         #   embedded receipt (identical shape to
                         #   ReimbursementClaim's, P3-C), recordedBy
expense.validation.js, .service.js, .controller.js, .routes.js
                         #   mounted at /api/expenses

client/src/features/expenses/
  expenses.api.js, expenses.schema.js
  pages/ExpenseListPage.jsx   # list + filters + a monthly summary bar +
                               #   create/edit modal — "list + modal" CRUD,
                               #   same shape as HolidayListPage (P3-B),
                               #   not Invoice's full detail-page pattern
client/src/app/router.jsx, DashboardLayout.jsx   # + /expenses, nav item
client/src/lib/constants.js  # + EXPENSE_CATEGORIES, EXPENSE_VIEW/WRITE/DELETE_ROLES
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/expenses` | Admin, Manager, HR, Accounts | list, with category/client/date-range/search filters |
| GET | `/api/expenses/summary` | Admin, Manager, HR, Accounts | total + by-category breakdown for a range (defaults to the current calendar month) |
| GET | `/api/expenses/:id` | Admin, Manager, HR, Accounts | view one |
| GET | `/api/expenses/:id/receipt` | Admin, Manager, HR, Accounts | download the receipt, if one was attached |
| POST | `/api/expenses` | Admin, Manager, Accounts | record a new expense (multipart — optional receipt file) |
| PATCH | `/api/expenses/:id` | Admin, Manager, Accounts | edit (never the receipt — see below) |
| DELETE | `/api/expenses/:id` | Admin, Manager | remove (destroys the Cloudinary receipt too, if any) |

## Key decisions & why

- **A narrower view circle than Invoices.** Invoices are commercial documents
  readable by any authenticated staff; an expense ledger exposes internal
  cost structure (rent, external-salary payouts, purchase prices) — the same
  Admin/Manager/HR/Accounts circle already used for Payroll and EOSB, not the
  wider one. Entering an expense is a money action (Admin/Manager/Accounts,
  matching Invoice/Payroll's write circle — HR views but doesn't enter costs);
  deleting is Admin/Manager only, same as Invoice.
- **The receipt is optional and, once set, immutable** — unlike a
  reimbursement claim's required receipt (P3-C), a rent payment or utility
  bill doesn't always have a scannable receipt, so creation accepts zero or
  one file. `updateExpense()` never touches it at all: if the wrong file was
  attached, delete the record and re-add it, rather than building a
  replace-with-cleanup path for what should be a rare correction. Same
  embedded shape and the same generic Cloudinary upload middleware
  (`middleware/upload.js`) as ReimbursementClaim's receipt — two modules
  sharing infrastructure, not reaching into the Documents module (a
  different trust/compliance category, per P3-C's reasoning).
- **`client`/`clientName` is a reference+snapshot, `deployment` is a plain
  reference with no snapshot.** An expense can optionally be attributed to a
  client (e.g. a purchase made for their project) without the link breaking
  if that client is later renamed; a linked deployment is only ever read
  back joined with the deployment record itself, so there's no durable-
  history need forcing a second snapshot field the way clientName has one.
  Attaching a deployment without its matching client (or a mismatched pair)
  is rejected with a clear message — verified directly below.
- **Update sends the full form, like Holidays** — no diffing of "did the
  user touch this field." An emptied optional link (client set back to "No
  client link") really does clear it: the key stays present in the JSON
  body with an empty string, which `emptyToUndef` turns into `undefined`
  during validation while Zod's own parse still keeps the key present
  (`'client' in data` stays true) — so the service can tell "field cleared"
  apart from "field omitted." Verified this exact round-trip via curl, not
  assumed.
- **List + modal, not a detail page.** There's no sub-workflow here (no
  payments ledger, no PDF, no approval chain) — just records — so this
  mirrors P3-B's HolidayListPage shape rather than Invoice's.

## Verified (2026-08-29)

**curl** (throwaway admin + a fresh HR/Accounts/Coordinator login, two test
clients, one test employee, one deployment — all deleted after):

- Create: minimal fields → 201; with a client link → 201 with the
  `clientName` snapshot correctly populated; with a matching client+
  deployment pair → 201; a client/deployment pair that don't belong together
  → 400 with the exact message; amount ≤ 0 → 400; missing category → 400.
- Receipt: a real JPEG uploaded through to Cloudinary (not mocked) → 201 with
  receipt metadata; downloaded back → 200 `image/jpeg`, byte-for-byte
  identical to the original file (`cmp` confirmed exact match).
- List filters: category filter, client filter, vendor/notes search, and an
  inclusive from/to date range each returned exactly the expected subset out
  of four seeded records with mixed categories/clients/dates.
- Summary: the default (no range given) totalled exactly the sum of all four
  seeded amounts (7,201.25) for the current calendar month, correctly broken
  down and sorted by category.
- Update: changing the amount and attaching a previously-absent client
  worked; sending the client back as `""` genuinely cleared both `client`
  and `clientName` (not left stale) — verified as two separate requests, not
  assumed from the code; amount ≤ 0 → 400; a non-existent id → 404.
- Delete: an expense with a receipt was removed, and the Cloudinary asset
  was independently confirmed gone via a direct `cloudinary.api.resource()`
  lookup (404) — not just "the DB record disappeared." An expense with no
  receipt deleted cleanly too.
- Roles: HR could view (200) but not create (403); Accounts could create
  (201) but not delete (403); Coordinator was rejected at the view gate
  itself (403) — a staff role that IS allowed into read-open modules like
  Timesheets/Leave is correctly excluded here, the interesting boundary case
  for this module's narrower circle.

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session for interactive click-through (same
port/CORS constraint noted throughout Phase 2/3 — see `docs/P3-B-notes.md`);
every code path, including the real file upload/download round-trip against
Cloudinary, was exercised via curl against the actual running dev server.

**Cleanup**: the throwaway admin/HR/Accounts/Coordinator logins, their four
employee records, both test clients, the test deployment, all three test
expenses, their refresh tokens, and the 24 audit-log rows they generated
were all removed by a temporary `server/cleanup-tmp.mjs` (deleted after
running). Re-attempting a login with the throwaway admin's credentials
afterward confirmed it, and every other test login, is gone.

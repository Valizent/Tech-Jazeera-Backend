# M5 — Client Management

Reuses the M4 pattern almost verbatim (list/new/profile/edit, reusable Table,
debounced search, role-gated actions). Two things are new: a **dynamic sites
sub-form** and a **tabbed profile**.

## What was built

**Backend** (`server/src/modules/clients/`)
```
client.model.js       # company/contact/VAT/CR/industry/notes + embedded sites
client.validation.js  # Zod: create / update / list-query / id schemas
client.service.js     # search / filter / sort / paginate + delete guard
client.controller.js  # HTTP translation only
client.routes.js      # RBAC-guarded REST routes
```
Also extended `employee.validation.js` + `employee.service.js` with a `client`
filter so the client profile can list its assigned workers.

**Frontend** (`client/src/features/clients/`)
```
clients.api.js            # endpoint calls
clients.schema.js          # form schema + form<->API mapping + formToPayload
components/ClientForm.jsx  # shared by create & edit; dynamic sites (useFieldArray)
pages/ClientListPage / ClientNewPage / ClientProfilePage / ClientEditPage
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/clients` | any authed | list (search, status, industry, sort, page) |
| GET | `/api/clients/:id` | any authed | one client |
| POST | `/api/clients` | Admin, Manager, Operations | create |
| PATCH | `/api/clients/:id` | Admin, Manager, Operations | update |
| DELETE | `/api/clients/:id` | Admin, Manager | delete (guarded) |

Assigned workers use the existing employee endpoint:
`GET /api/employees?client=<id>`.

## Key decisions & why

- **Sites are embedded sub-documents with their own `_id`.** A site has no
  life outside its client, so it is embedded (our rule). It keeps an `_id` so
  the deployment workflow (M6) can point at one specific site stably.
- **No `workers` array on the client.** Employees reference the client
  (`Employee.currentClient`), so "assigned workers" is a *query*, which can
  never go stale. This is references-over-embedding applied correctly.
- **Delete is guarded.** `deleteClient` refuses (409) if any employee still
  has `currentClient === id`, so we never orphan a worker's assignment. The
  count is 0 until M6 assigns anyone, but the guard is real and was verified
  by manually assigning a worker (409) then unassigning (200).
- **VAT/CR validated to KSA formats** (15 and 10 digits) — but only when
  provided, since not every record has them at entry time.
- **`status` (Active/Inactive)** added beyond the raw field list: it is
  immediately useful (filter, and M6 should only deploy to active clients).
  "Inactive" is the archive path; delete is for mistakes.
- **Client roles differ from employees.** Ops own the client relationship, so
  write = Admin/Manager/Operations (HR is excluded — verified 403); delete =
  Admin/Manager only.

## The two new frontend patterns

### Dynamic sites — `useFieldArray`
`ClientForm` uses react-hook-form's `useFieldArray({ name: 'sites' })` to let
the user append/remove site rows. A row may be left blank; `formToPayload`
strips rows with no name before sending, so an empty trailing row never blocks
submit. Copy this pattern for any future "list of things" sub-form
(quotation line items in M9 will).

### Tabbed profile
`ClientProfilePage` has an inline tab bar (`useState('overview')`). Tabs exist
only for data we can show **for real right now**:
- **Overview** — the client record + its sites.
- **Workers** — a live `useQuery` on `/employees?client=<id>`; shows a genuine
  empty state (backed by a real request) until M6 assigns anyone.

Documents (M8) and Quotations (M9) will add their tabs **when those modules
exist** and there is real data to query. We deliberately do **not** ship empty
"Documents"/"Quotations" tabs now — a tab that queries nothing is a placeholder,
which the project's hard rules forbid. The tab bar is inline (used on one
screen so far); it gets extracted to a shared `<Tabs>` the day a second screen
needs it — not before.

## Common beginner mistakes

- **Embedding workers in the client.** Then every hire/transfer must update
  two documents and they drift. Keep the reference on the employee.
- **Forgetting `formToPayload`.** Sending raw form values includes empty site
  rows; the server then 400s on `sites.N.name`. Always map before mutating.
- **Deleting a client with assignments.** The API returns 409 by design; the
  UI shows it as an error toast. Reassign/unassign first, or set Inactive.
- **`useFieldArray` without stable keys.** Always use `field.id` (RHF-provided)
  as the React `key`, never the array index — index keys corrupt row state on
  remove.

## Debugging tips

- Workers tab empty for a client you think has staff? Assignment is an M6
  feature; until then only manual DB assignment (or the guard test) populates
  `currentClient`.
- 409 on delete = assigned workers. The message tells you how many.
- VAT/CR rejected? They must be exactly 15 / 10 digits, or empty.

## Verified (2026-07-23)

**curl:** create with sites (201, each site gets `_id`) · minimal create (201)
· validation (400: short name, bad VAT, bad CR, bad email, site-missing-name)
· list / search / status-filter · get (200) · patch sites (200) ·
`employees?client=` (200) · Operations create (201) · HR create (403) · HR
read (200) · delete guard with assigned worker (409) · delete empty (200).

**Browser:** clients list + nav · profile Overview (details, VAT/CR, 3 sites,
notes) · Workers tab shows the real assigned worker (Rajesh @ NEOM) · create
with 2 dynamically-added sites → success → sites persisted · edit removes a
site row (2→1) → saved · delete guard on Riyadh → error toast, client kept ·
delete empty client → success → redirect to list · mobile 375px → cards, no
horizontal scroll · no live console errors.

# M4 — Employee Management

This is the **pattern-setting milestone**. Every later feature module
(clients, deployments, …) copies the shapes established here. Read it closely.

## What was built

**Backend** (`server/src/modules/employees/`)
```
employee.model.js       # schema: all spec fields; embedded documents & contact
employee.validation.js  # Zod: create / update / list-query / id-param schemas
employee.service.js     # business logic: search, filter, sort, paginate, alerts
employee.controller.js  # HTTP translation only
employee.routes.js      # RBAC-guarded REST routes
```

**Frontend**
```
components/ui/           # NEW reusable primitives (used app-wide):
  Badge, Select, Textarea, Skeleton, EmptyState, Modal, Table
components/shared/        # PageHeader, ConfirmDialog, ExpiryBadge
features/employees/
  employees.api.js        # endpoint calls
  employees.schema.js      # form schema + form<->API mapping
  components/EmployeeForm.jsx  # shared by create & edit
  pages/EmployeeListPage / NewPage / ProfilePage / EditPage
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/employees` | any authed | list (search, filter, sort, paginate) |
| GET | `/api/employees/:id` | any authed | one employee |
| POST | `/api/employees` | Admin, Manager, HR | create |
| PATCH | `/api/employees/:id` | Admin, Manager, HR | update |
| DELETE | `/api/employees/:id` | Admin, HR | delete |

**List query params:** `page`, `limit`, `search` (name/ID/mobile/email,
case-insensitive), `status`, `alerts=true` (docs expiring within 30 days or
already expired), `sortBy` (`fullName`|`joiningDate`|`createdAt`),
`sortOrder` (`asc`|`desc`). Response: `{ items, total, page, pages }`.

## Key decisions & why

- **Embed vs. reference.** The five identity documents (passport, visa,
  iqama, medical, driving license) and the emergency contact are **embedded**
  — they have no life outside their employee and are never queried alone.
  `currentClient` is a **reference** (a client is an independent entity with
  many employees). This follows the project rule literally; see the comments
  in `employee.model.js`.
- **currentClient/currentSite are NOT in the create/update form.** Assignment
  belongs to the deployment workflow (M6), which will guard against
  double-assignment. Because Zod strips unknown keys, a hand-crafted request
  can't smuggle an assignment through the HR form. For now the profile shows
  "Unassigned".
- **Delete is real, and narrow (Admin/HR).** It destroys history, so the role
  circle is smaller than write. The everyday "this person left" path is
  setting **status = Exited**, which the delete dialog actively suggests.
- **Expiry threshold lives in one constant per side.**
  `EXPIRY_WARNING_DAYS = 30` in `employee.service.js` (server filter) and
  `client/src/lib/constants.js` (badges). Change both together.
- **Regex search is escaped.** User input is escaped before going into a
  Mongo `$regex`, so a name like `O'Brien (Ops)` can't break or inject the
  query.
- **Pagination is stable.** The sort always appends `_id` as a tiebreaker, so
  rows can't reshuffle across pages when the primary sort key ties.

## The reusable `<Table>` (how list screens work)

`Table` takes a `columns` array (`{ key, header, render, sortable?,
hideOnMobile? }`) and rows. It renders a real `<table>` on `md+` and **stacks
into cards on mobile** (first column = card title, rest = label/value rows).
It handles its own loading skeletons and delegates the empty view to the
`emptyState` prop. To build the next list screen, define columns and pass
data — nothing else.

## Search debouncing (a subtle but important pattern)

The search box keeps its own `search` state and, via a 300 ms `setTimeout`
effect, copies it into the query params. Result: typing "electrician" fires
**one** request, not eleven. TanStack Query's `keepPreviousData` keeps the
current page on screen (no flicker to skeletons) while the next loads.

## Common beginner mistakes

- **Trusting the client's role check.** `EMPLOYEE_WRITE_ROLES` only hides
  buttons for nicer UX. The **server** enforces access; a Viewer who forges a
  POST still gets 403 (verified).
- **`z.coerce.boolean()` on a query flag.** `Boolean("false") === true`. The
  `alerts` param is a string enum `'true'|'false'` for exactly this reason.
- **Forgetting `runValidators: true` on `findByIdAndUpdate`.** Mongoose skips
  schema validation on updates by default — without it, a PATCH could write
  an invalid enum. (Our Zod layer catches it first, but defense in depth.)
- **Sending `""` for empty optional fields.** HTML inputs produce empty
  strings; the server's `emptyToUndef` preprocessor converts them to
  `undefined` so we don't persist meaningless empty values.
- **Editing without mapping dates.** `<input type="date">` needs
  `YYYY-MM-DD`; the API returns ISO timestamps. `employeeToForm` /
  `toDateInput` bridge the two. Skipping this leaves date fields blank on edit.

## Debugging tips

- Employee list empty but you know records exist? Check the active filters —
  the empty state text tells you whether filters or truly-no-data is the
  cause.
- 409 on create = duplicate `employeeId` (unique index). The error handler
  turns the Mongo error into a friendly message automatically.
- Expiry badge looks wrong? It's relative to *today*. `daysUntil` is the
  single source; the medical doc dated 2026-06-01 reads "Expired" because
  today is past it.

## Verified (2026-07-23)

**curl:** create (201, ID uppercased) · duplicate (409) · validation failure
(400 w/ field details) · list/search/alerts/sort · get (200) · bad-id (400) ·
unknown-id (404) · patch (200) · Viewer create (403) · Viewer read (200) ·
Viewer delete (403) · delete (200) · audit shows all CRUD actions.

**Browser (click-through):** login → Employees nav → list with data · empty
form submit → 7 inline errors · full create → success toast → profile with
correct expiry badges (Iqama "Valid", Medical "Expired", others "Not set") ·
edit salary → persists & re-displays · search / status / alerts filters all
narrow correctly · delete → confirm dialog → cancel preserves → confirm
deletes with toast · mobile 375 px → cards, no horizontal scroll · zero
console errors.

# M7 — Attendance

Daily marking, weekly/monthly grid views, per-worker summaries, and Excel/PDF
export.

## New dependencies (and why)

The first packages beyond the locked stack — required because `.xlsx` and PDF
are binary formats no one hand-writes:

- **`exceljs`** — Excel generation. Pure JS (no native build), maintained,
  supports the header styling and column sizing we use. Chosen over SheetJS
  (heavier, licensing quirks).
- **`pdfkit`** — PDF generation. Mature, pure JS, lean, streams. Chosen over
  `pdfmake` (bundles ~1 MB of fonts) and headless-Chrome (huge, fragile).

Both run **server-side**: the data already lives there, the client bundle
stays small, and the spreadsheet and PDF are guaranteed to agree because they
render the same summary.

> `npm audit` reports a **moderate** advisory for a transitive dep
> (`exceljs → uuid <11.1.1`: a buffer-bounds check that only triggers when
> uuid v3/v5/v6 are called with a caller-supplied output buffer). exceljs does
> not expose that path to our data, so it is **not exploitable here**. The
> `audit fix --force` "fix" downgrades exceljs to a breaking 3.x, and forcing
> uuid 11 (ESM-only) breaks exceljs's CommonJS require — so we intentionally
> keep the current versions.

## What was built

**Backend** (`server/src/modules/attendance/`)
```
attendance.model.js       # employee+date+status; unique {employee,date}
attendance.validation.js  # Zod: bulk-mark, list, summary, export
attendance.service.js     # markBulk (upsert), listAttendance, getSummary (aggregation)
attendance.export.js      # buildXlsx (exceljs) + buildPdf (pdfkit)
attendance.controller.js  # HTTP; export streams a file (the one non-JSON reply)
attendance.routes.js      # mark = Admin/Manager/HR/Operations; read/export = all
```

**Frontend** (`client/src/features/attendance/`)
```
attendance.api.js         # incl. authenticated blob download for exports
attendance.dates.js       # UTC month/week range math + labels
components/MarkTab.jsx     # daily marking (status buttons per worker)
components/RecordsGrid.jsx # week/month grid of coloured status cells
components/SummaryTab.jsx  # per-worker counts + Excel/PDF export
pages/AttendancePage.jsx   # tabs (Mark hidden for non-writers)
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| POST | `/api/attendance/bulk` | Admin/Manager/HR/Operations | upsert many for one day |
| GET | `/api/attendance?from&to[&employee]` | any authed | records in a range (grid) |
| GET | `/api/attendance/summary?from&to` | any authed | per-worker status counts |
| GET | `/api/attendance/export?format=xlsx\|pdf&from&to` | any authed | download a file |

## Key decisions & why

- **One record per worker per day**, enforced by a unique `{employee, date}`
  index. Marking is an **upsert**, so re-saving a day corrects it instead of
  duplicating (verified: re-marking Absent→Leave left one record, total
  unchanged).
- **Dates stored at UTC midnight.** The service floors every incoming date to
  UTC day; the client does all range math in UTC too (`attendance.dates.js`).
  This gives a day exactly one representation and prevents the classic
  timezone off-by-one in grids/summaries.
- **Attendance is per-employee-per-day, not per-deployment.** Present/Absent/
  Leave is about the person, not where they're placed — keeping it decoupled
  from Deployment avoids brittle coupling and matches the spec's field list.
- **Summary via one aggregation** ($group with $cond counters + $lookup for
  names), which is also the single source for both export formats.
- **Export streams a binary file** — the one place the API intentionally does
  not use the `{success,...}` JSON envelope. The client downloads it through
  axios (so the in-memory access token is sent) as a Blob, then triggers a
  browser download; a plain `<a href>` couldn't authenticate.
- **Bulk mark validates employee ids exist** before writing, so a stale UI
  can't create orphan attendance rows.

## Common beginner mistakes

- **Storing dates with a time component.** Then `{employee,date}` isn't unique
  per day and duplicates creep in. Always floor to UTC midnight.
- **Formatting attendance dates in local time.** In a negative-offset zone a
  UTC-midnight date renders as the previous day. Use UTC formatting (the
  helpers do) or slice the ISO string.
- **Linking export downloads with `<a href>`.** The access token lives in
  memory, not a cookie/localStorage, so the link is unauthenticated (401).
  Fetch the Blob via axios instead.
- **Re-marking creating duplicates.** It won't, because the write is an
  upsert keyed on `{employee,date}` — but only if the date is normalized
  identically every time.

## Debugging tips

- Grid cell empty for a day you marked? Check the date key mapping
  (`employeeId|YYYY-MM-DD`) — a timezone-shifted date key is the usual cause.
- Export 400? `from`/`to` are required and must be `YYYY-MM-DD`; `format`
  must be `xlsx` or `pdf`.
- PDF text not greppable in the raw bytes? Expected — pdfkit compresses
  content streams (FlateDecode). The file is still valid.

## Verified (2026-07-23)

**curl:** mark (2 workers) · re-mark upsert (Absent→Leave, no duplicate) ·
multi-day marking · list (8 records, all unique per emp+date) · summary
(correct counts) · xlsx export (valid PK zip; read back — correct headers &
rows) · pdf export (valid %PDF, 1 page, FlateDecode) · validation (bad date,
empty records, missing range) · Viewer mark 403 / read 200.

**Browser:** Attendance nav + 3 tabs · mark a day via status buttons → saved ·
Records grid (July, 31 cols, Present=8/Leave=1/Sick=1 matching data, legend,
weekend shading) · Summary counts correct · Excel + PDF export both download
(200, no error) · Mark tab prefills an already-marked day · mobile 375px: grid
scrolls in its container, page has no horizontal scroll · no console errors.

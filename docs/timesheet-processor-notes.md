# Timesheet Processor — developer notes

An **Admin-only** internal tool: upload one employee's monthly door-access log
(.xlsx), get a salary-ready timesheet you can preview and export. Deterministic,
stateless (nothing is persisted), and fully isolated from the rest of the ERP.

## What was built

**Backend** (`server/src/modules/timesheetProcessor/`) — layered, small files
```
timesheet.constants.js   # 08:00 default (configurable), column aliases, accepted types, status enum
timesheet.time.js        # minute math + HH:MM + daysInMonth + weekday
timesheet.parser.js      # SheetJS read (.xls + .xlsx) → normalized punches; alias mapping; tolerant parsing
timesheet.processor.js   # PURE attendance rules (login/logout, worked, deficiency, overtime, summary)
timesheet.export.js      # exceljs → professionally formatted .xlsx (theme colours, borders, summary)
timesheet.validation.js  # Zod for the multipart text fields
timesheet.service.js     # orchestration: load employee → parse → process
timesheet.controller.js  # thin HTTP (preview = JSON, export = streamed .xlsx)
timesheet.routes.js      # Admin guard + module-local Multer (MEMORY storage)
```
Mounted with one additive line in `app.js` at `/api/timesheet-processor`.

**Frontend** (`client/src/features/timesheetProcessor/`)
```
timesheet.api.js                    # preview (JSON) + export (authenticated Blob download)
timesheet.constants.js              # status→Badge variant, months, HH:MM helpers
components/TimesheetResults.jsx      # warnings + summary + day table (reuses the Table primitive)
components/HolidayCalendar.jsx        # inline month grid: click days to mark holidays (+ "mark all Fridays")
pages/TimesheetProcessorPage.jsx     # form + orchestration + Admin route guard
```
Plus one route in `router.jsx` and one **Admin-only** nav item in
`DashboardLayout.jsx` (the sidebar now filters items by `roles`; items without
`roles` stay visible to everyone, so existing nav is unchanged).

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| POST | `/api/timesheet-processor/preview` | Admin | multipart (file + employeeId, month, year, requiredMinutes?, holidays?) → computed JSON |
| POST | `/api/timesheet-processor/export`  | Admin | same input → streamed formatted `.xlsx` |

Both stateless: the client keeps the file and posts it to whichever endpoint, so
the server recomputes authoritatively and stores nothing.

## Business rules (the "literal" policy, confirmed with the admin)

- Per date: sort punches, **first = Login, last = Logout**, ignore the middle.
  `Worked = Logout − Login`. Exactly one punch → **Single Punch**, logout blank,
  worked `00:00`.
- **Every calendar day of the month accrues the required hours** (08:00 default,
  overridable per run). `Deficiency = max(0, Required − Worked)` and
  `Overtime = max(0, Worked − Required)` on **every** day — so a No-Attendance or
  Single-Punch day shows a full-day deficiency.
- **Holidays** (admin-marked dates, per run): a holiday requires **0 hours**, so
  it never adds a deficiency whether the person shows up or not. If they DO work
  a holiday, the **entire worked span counts as overtime** (status
  `Holiday (Worked)`); an unworked holiday is `Holiday`. `Working Days` and
  `Total Required` exclude holidays, and the summary gains a `Holidays` count.
- Summary buckets are non-overlapping: every day is exactly one of Holiday /
  Present (complete pair) / Single Punch / No Attendance. `Working Days` =
  calendar days − holidays.
- **Remaining limitation:** there is no *automatic* weekend/holiday detection or
  saved company calendar yet — the admin marks holidays by hand each run on the
  month calendar. A persisted holiday calendar is the natural next step.

## Key decisions & why

- **Reads both `.xls` and `.xlsx` via SheetJS.** Attendance devices (ZKTeco etc.)
  export a raw legacy BIFF `.xls`, which exceljs cannot read at all, so the
  parser uses SheetJS (`xlsx`). Justification for the dependency: parsing BIFF by
  hand is infeasible and SheetJS is the standard reader. **Security:** the npm
  `xlsx` is pinned at a vulnerable 0.18.5; we install the patched **0.20.3 from
  the SheetJS vendor CDN** (`package.json` points at the CDN tarball). exceljs
  still writes the formatted export.
- **Column mapping by alias, not position** (`COLUMN_ALIASES`). Real device
  headers (`Date/Time`, `No.`, `ID Number`, `CardNo`) are covered; a file may
  carry a single combined timestamp OR separate `Date` + `Time`. New dialects are
  added in one constant, never in the parser.
- **Ambiguous text dates are auto-resolved.** Devices often store the timestamp
  as TEXT like `7/1/2026 8:02:24 AM` (US month-first). The parser scans the
  file's dates and infers day/month order from any value with a component > 12
  (a real month always has one, e.g. the 30th), defaulting to month-first only if
  a file is entirely ambiguous. Real `Date` cells and Excel serials are also
  handled.
- **Tolerant parsing.** Unreadable rows are **skipped and reported** as warnings,
  never fatal. Punches outside the selected month are ignored (reported).
- **Pure processor.** All the maths lives in pure functions with no I/O, so it's
  trivial to test and to extend (shift timings, holiday calendar, custom rules).
- **Memory-storage Multer, separate instance.** The file is parsed and discarded
  (never written to disk), and the module's own Multer can't affect the document
  upload middleware. Accepts `.xls` and `.xlsx` **by extension** (device MIME
  labels are unreliable); the parser is the real gate. 5 MB cap.
- **Configurable required hours.** One constant (`DEFAULT_REQUIRED_MINUTES`) plus
  an optional per-run override field; never hard-coded around the codebase.
- **Nothing persisted.** No new Mongoose model → zero migration risk and no
  change to existing data. Persistence is a clean future add for payroll.

## Validation & security

Rejects (friendly messages): empty file, non-.xls/.xlsx, corrupted workbook,
missing Date/Time columns, and no punches for the chosen month. File type
+ size enforced by Multer; uploaded content is only ever parsed as data (never
executed); every text input is Zod-validated; the route is Admin-only server-side.

## Extensibility (structured for, not implemented)

Multiple-employee uploads, shift timings, holiday calendar, leave integration,
payroll export, PDF reports, more device formats, per-employee required hours,
company rules. The parser (input formats) and processor (rules) are the two
seams these slot into.

## Verified (2026-08-04)

**curl** (throwaway admin + employee, deleted after; DB left pristine): preview of
a crafted July file → summary exactly correct (Working 31, Present 4, Single 1,
No-Attendance 26, Worked 33:00, Required 248:00, Deficiency 218:00, Overtime
03:00) and per-day rows correct (Present / Overtime / Deficient / Single-Punch
with blank logout / 4-punch day using only first+last / No-Attendance) · export
streams a valid `.xlsx` (PK, correct headers/filename) · failures: no file 400,
empty month 400, non-xlsx 400, corrupted 400, bad month 400, no auth 401,
**Worker role 403**.

**Browser:** Admin sees the "Timesheet Processor" nav item (hidden for other
roles) · form (employee/month/year/required-hours/file) · Process renders the
warnings, summary, and 31-day table identical to the API · **Export → 200**, no
console errors.

**Holidays (added 2026-08-04):** marking RIYAJ's 5 Fridays as holidays (via the
calendar's "mark all Fridays") drops Total Deficiency **40:00 → 00:00**, sets
Working Days 26 / Holidays 5, and leaves overtime unchanged; a holiday that is
worked shows `Holiday (Worked)` with the whole span as overtime. Verified in the
processor, via the API (`holidays=3,10,17,24,31`), through the browser calendar,
and by reading the exported `.xlsx` back (Holiday rows + a `Holidays` summary line).

**Real device file (`.xls`, added 2026-08-04):** a genuine ZKTeco BIFF export
(RIYAJ LOG, 82 `C/In` punches, July 2026, text `Date/Time` in `M/d/yyyy h:mm:ss
AM/PM`) parsed with **0 warnings** — dates auto-resolved to month-first, worked
spans correct (e.g. 1 Jul 08:02→19:35 = 11:33), summary Present 26 / No-Attendance
5 (the Fridays) / Worked 301:14 / Overtime 93:14 — verified via curl (preview +
`.xlsx` export) and through the browser UI end to end.

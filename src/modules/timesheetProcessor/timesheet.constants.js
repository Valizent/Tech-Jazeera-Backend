/**
 * Timesheet Processor — configuration constants.
 *
 * Everything tunable for this admin-only tool lives here so business rules are
 * never scattered as magic numbers. Required working hours default to 08:00 and
 * can be overridden per run from the UI; the column aliases make the Excel
 * reader tolerant of slightly different header names across attendance devices.
 * New device dialects are added here without touching the parser.
 */

/** Default required working time per day, in minutes (08:00). Overridable per run. */
export const DEFAULT_REQUIRED_MINUTES = 8 * 60;

/** Bounds for a per-run required-hours override (1 minute .. 24h). */
export const MIN_REQUIRED_MINUTES = 1;
export const MAX_REQUIRED_MINUTES = 24 * 60;

/**
 * Accepted uploads. We take BOTH modern `.xlsx` and legacy `.xls` — attendance
 * devices (e.g. ZKTeco) export a raw BIFF `.xls`, which the SheetJS reader in
 * the parser handles. Acceptance is by extension (device MIME labels are
 * unreliable — often octet-stream); the parser is the real gate, rejecting
 * anything that isn't a genuine workbook. `.xlsx` is also the export MIME.
 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLS_MIME = 'application/vnd.ms-excel';
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — a month of punches is tiny

/**
 * Worksheet dimension limits (2026-09-22, a real QA-audit finding — P7).
 * `MAX_FILE_BYTES` alone does not bound parsing CPU: a repetitive attendance
 * sheet compresses hard, so the audit's own reproduction fit a 50,000-row
 * workbook under 1.75 MB (well inside the 5 MB cap) and blocked the event
 * loop for ~1.1s parsing it. A real one-employee, one-month device export is
 * a few hundred rows and under a dozen columns at most — these caps are
 * generous for that real shape while bounding the worst case a malformed or
 * oversized upload can cost. Checked against the sheet's `!ref` range
 * BEFORE the expensive `sheet_to_json` materialization (the audit's numbers
 * show the JS-side per-row/per-cell cost dominates, not the initial
 * `XLSX.read`, which the byte limit already bounds), so an oversized file
 * fails fast with a clear 400 instead of paying that cost first.
 */
export const MAX_DATA_ROWS = 5000;
export const MAX_DATA_COLUMNS = 50;

/** Per-day statuses. Frozen so the UI can import the exact labels/order. */
export const STATUS = Object.freeze({
  PRESENT: 'Present',
  DEFICIENT: 'Deficient',
  OVERTIME: 'Overtime',
  SINGLE_PUNCH: 'Single Punch',
  NO_ATTENDANCE: 'No Attendance',
  // Holiday: 0 required hours, never a deficiency. Working it earns overtime.
  HOLIDAY: 'Holiday',
  HOLIDAY_WORKED: 'Holiday (Worked)',
});

/**
 * Header aliases for flexible column mapping. Matching is case-insensitive and
 * whitespace-trimmed, on an EXACT header-cell match. A file may provide EITHER
 * a single combined timestamp column OR separate date + time columns — the
 * parser handles both, preferring a timestamp when present.
 */
export const COLUMN_ALIASES = Object.freeze({
  timestamp: [
    'timestamp', 'time stamp', 'date time', 'datetime', 'date/time',
    'punch time', 'access time', 'event time',
  ],
  date: ['date', 'punch date', 'log date', 'access date', 'att date', 'attendance date'],
  time: ['time', 'log time', 'in/out time', 'clocking'],
  employeeId: [
    'employee id', 'emp id', 'employee code', 'emp code', 'user id', 'badge',
    'card no', 'cardno', 'ac-no', 'ac no', 'no.', 'no', 'id number',
  ],
  employeeName: ['employee name', 'name', 'emp name', 'user name', 'full name'],
});

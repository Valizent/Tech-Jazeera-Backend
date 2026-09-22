/**
 * Timesheet parser — turns a raw workbook buffer into normalized punch records.
 *
 * Reads with SheetJS so BOTH modern `.xlsx` and legacy BIFF `.xls` (the raw
 * format attendance devices like ZKTeco export) work through one path. It does
 * no attendance math — only:
 *  - open the workbook defensively (corrupt files become a friendly 400)
 *  - find the header row and map columns by ALIAS, not position
 *  - read each data row tolerantly: real Date cells, Excel serials, and text
 *    date/times are all handled; unreadable rows are skipped and reported
 *  - keep only punches inside the requested month/year
 *
 * Date text is often ambiguous (7/1 vs 1/7). Device exports store the timestamp
 * as text, so we AUTO-DETECT day/month order per file: a real month always
 * contains a day > 12 (e.g. the 30th), which disambiguates; we fall back to
 * month-first (the common device default) only if a file is entirely ambiguous.
 *
 * A punch reduces to `{ day, minutes }` (minutes = minute-of-day) since the
 * month and year are fixed by the caller's selection.
 */
import * as XLSX from 'xlsx';
import ApiError from '../../utils/ApiError.js';
import { COLUMN_ALIASES, MAX_DATA_ROWS, MAX_DATA_COLUMNS } from './timesheet.constants.js';

/** Plain text for any cell value (SheetJS gives Date / number / string). */
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/** Normalize a header cell for alias comparison: lowercase, single-spaced. */
function normHeader(value) {
  return cellText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Map a candidate header row (array) to column indexes by exact alias match. */
function mapHeaderRow(row) {
  const map = {};
  row.forEach((cell, idx) => {
    const header = normHeader(cell);
    if (!header) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] == null && aliases.includes(header)) {
        map[field] = idx;
        break;
      }
    }
  });
  return map;
}

/** We can process a row if there's a timestamp, OR a date AND a time. */
function hasRequiredColumns(map) {
  return map.timestamp != null || (map.date != null && map.time != null);
}

/** The first three integers of a date-like string, or null. */
function dateTriplet(text) {
  const m = String(text).match(/(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Decide day/month order from the file's string dates. Any component > 12 fixes
 * the order; a full month of data effectively always contains one. Defaults to
 * month-first (MDY) when a file is genuinely ambiguous.
 */
function detectDateOrder(sampleStrings) {
  for (const value of sampleStrings) {
    const triplet = dateTriplet(value);
    if (!triplet) continue;
    const [a, b] = triplet;
    if (a > 12 && a <= 31) return 'DMY'; // first field must be the day
    if (b > 12 && b <= 31) return 'MDY'; // second field must be the day
  }
  return 'MDY';
}

/** { y, m, d } from a date string, honoring the detected order (or ISO if year-first). */
function partsFromDateString(text, order) {
  const triplet = dateTriplet(text);
  if (!triplet) return null;
  const [a, b, c] = triplet;
  if (a > 31) return { y: a, m: b, d: c }; // YYYY-MM-DD
  const y = c < 100 ? 2000 + c : c;
  return order === 'DMY' ? { y, m: b, d: a } : { y, m: a, d: b };
}

/** Minute-of-day (0..1439) from "HH:MM(:SS) [AM/PM]", or null. */
function minutesFromTimeString(text) {
  const m = String(text).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** { y, m, d } from a Date / Excel serial / string date value. */
function dateParts(value, order) {
  if (value instanceof Date) {
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF?.parse_date_code(value);
    return parsed ? { y: parsed.y, m: parsed.m, d: parsed.d } : null;
  }
  return partsFromDateString(cellText(value), order);
}

/** Minute-of-day from a Date / Excel serial / time string. */
function minutesOfDay(value) {
  if (value instanceof Date) return value.getUTCHours() * 60 + value.getUTCMinutes();
  if (typeof value === 'number') return Math.round((value - Math.floor(value)) * 1440) % 1440;
  return minutesFromTimeString(cellText(value));
}

/** Combined { y, m, d, minutes } from a single timestamp cell. */
function timestampParts(value, order) {
  if (value instanceof Date) {
    return {
      y: value.getUTCFullYear(),
      m: value.getUTCMonth() + 1,
      d: value.getUTCDate(),
      minutes: value.getUTCHours() * 60 + value.getUTCMinutes(),
    };
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF?.parse_date_code(value);
    return parsed ? { y: parsed.y, m: parsed.m, d: parsed.d, minutes: parsed.H * 60 + parsed.M } : null;
  }
  const text = cellText(value);
  const date = partsFromDateString(text, order);
  const minutes = minutesFromTimeString(text);
  return date && minutes != null ? { ...date, minutes } : null;
}

/**
 * Parse a buffer into punches for the given month/year.
 * @returns {{ punches: {day:number, minutes:number}[], warnings: string[],
 *            detectedEmployee: {id:string, name:string}|null }}
 */
export async function parseAttendanceWorkbook(buffer, { month, year }) {
  if (!buffer || buffer.length === 0) throw new ApiError(400, 'The uploaded file is empty.');

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new ApiError(400, 'The file is not a valid Excel workbook, or it is corrupted.');
  }

  const sheet = workbook.SheetNames[0] ? workbook.Sheets[workbook.SheetNames[0]] : null;
  if (!sheet) throw new ApiError(400, 'The workbook has no sheets.');

  // Dimension check BEFORE the expensive sheet_to_json materialization (see
  // MAX_DATA_ROWS's own doc comment — this is what actually bounds parsing
  // CPU, since the byte-size limit alone doesn't: a repetitive sheet
  // compresses hard). Reading `!ref` is cheap; it's already on the sheet
  // object from XLSX.read.
  if (sheet['!ref']) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;
    if (rowCount > MAX_DATA_ROWS) {
      throw new ApiError(
        400,
        `This workbook has ${rowCount.toLocaleString()} rows, more than the ${MAX_DATA_ROWS.toLocaleString()} this tool accepts. A real one-employee, one-month export is far smaller — check the file.`
      );
    }
    if (colCount > MAX_DATA_COLUMNS) {
      throw new ApiError(
        400,
        `This workbook has ${colCount} columns, more than the ${MAX_DATA_COLUMNS} this tool accepts. Check the file.`
      );
    }
  }

  // Array-of-arrays; keeps real Dates (cellDates) and raw values.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false, defval: null });
  if (!rows.length) throw new ApiError(400, 'The workbook has no data.');

  // Locate the header row (some exports carry a title band above it).
  let headerMap = null;
  let headerRow = -1;
  const scanLimit = Math.min(rows.length, 15);
  for (let r = 0; r < scanLimit; r++) {
    const map = mapHeaderRow(rows[r] ?? []);
    if (hasRequiredColumns(map)) {
      headerMap = map;
      headerRow = r;
      break;
    }
  }
  if (!headerMap) {
    throw new ApiError(
      400,
      'Could not find the attendance columns. The sheet needs a Date and Time column, or a single Date/Time (Timestamp) column.'
    );
  }

  const dataRows = rows.slice(headerRow + 1);

  // Pass 1: determine day/month order from the string timestamps present.
  const sampleColumn = headerMap.timestamp ?? headerMap.date;
  const order = detectDateOrder(
    dataRows.map((row) => row?.[sampleColumn]).filter((v) => typeof v === 'string')
  );

  // Pass 2: extract punches.
  const punches = [];
  const warnings = [];
  let detectedEmployee = null;
  let skipped = 0;
  let skipWarnShown = 0;
  let outOfMonth = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] ?? [];
    const excelRowNumber = headerRow + i + 2; // 1-based row number in the sheet

    if (!detectedEmployee && (headerMap.employeeId != null || headerMap.employeeName != null)) {
      const id = headerMap.employeeId != null ? cellText(row[headerMap.employeeId]) : '';
      const name = headerMap.employeeName != null ? cellText(row[headerMap.employeeName]) : '';
      if (id || name) detectedEmployee = { id, name };
    }

    let parts;
    if (headerMap.timestamp != null) {
      parts = timestampParts(row[headerMap.timestamp], order);
    } else {
      const date = dateParts(row[headerMap.date], order);
      const minutes = minutesOfDay(row[headerMap.time]);
      parts = date && minutes != null ? { ...date, minutes } : null;
    }

    if (!parts) {
      const hasContent = Array.isArray(row) && row.some((c) => cellText(c) !== '');
      if (hasContent) {
        skipped++;
        if (skipWarnShown < 15) {
          warnings.push(`Row ${excelRowNumber}: could not read the date/time — skipped.`);
          skipWarnShown++;
        }
      }
      continue;
    }

    if (parts.y !== year || parts.m !== month) {
      outOfMonth++;
      continue;
    }
    punches.push({ day: parts.d, minutes: parts.minutes });
  }

  if (skipped > skipWarnShown) warnings.push(`…and ${skipped - skipWarnShown} more unreadable row(s) skipped.`);
  if (outOfMonth > 0) warnings.push(`${outOfMonth} punch(es) outside the selected month were ignored.`);

  return { punches, warnings, detectedEmployee };
}

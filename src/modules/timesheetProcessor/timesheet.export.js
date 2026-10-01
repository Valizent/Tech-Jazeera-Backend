/**
 * Timesheet export — turns a processed result (from timesheet.service) into a
 * professionally formatted .xlsx Buffer. Kept separate from the business logic
 * so the file-format concern never leaks into the processor, and separate
 * from I/O — an optional company logo is handed in as already-fetched bytes
 * (see timesheet.controller.js), this module never fetches anything itself.
 *
 * The exact layout (row heights, fonts, colors, column widths, the blank
 * REMARKS/APPROVED columns) mirrors a real reference export the company
 * already uses for printed/filed timesheets — matched deliberately, not
 * just "close enough."
 *
 * `compactLayout` (2026-10-01, the Timesheet Processor's own ask, matched
 * against a real reference file cell-by-cell — merges, fonts, borders,
 * column widths, everything) turns on a second reference design: a small
 * top-left logo instead of a full-width banner, Title+Month sharing one
 * header row, a 3-pair Monthly Summary grid (Working/Present/Absent,
 * Holidays/Single Punch/Medical) instead of the flat 9-line list, a real
 * TOTAL row under the data table, and boxed Prepared by/Verified By/
 * Approved By signature cells. Defaults OFF — monthlyReport.service.js's
 * own call (a different vocabulary: Absent/Leave/Sick/Off, which doesn't
 * fit a 2-row/3-pair grid) is completely unaffected, byte-for-byte the same
 * as before this was added.
 */
import ExcelJS from 'exceljs';
import { minutesToHHMM } from './timesheet.time.js';

// Theme (ARGB) — matches the app's own ink/muted/border tokens.
const INK = 'FF14162B';
const MUTED = 'FF64748B';
const ZEBRA_FILL = 'FFF3F4FB';
const BORDER = 'FFD8DCEC';
const DARK_BORDER = 'FF000000';

const thin = { style: 'thin', color: { argb: BORDER } };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
const thinDark = { style: 'thin', color: { argb: DARK_BORDER } };
const darkBorders = { top: thinDark, left: thinDark, bottom: thinDark, right: thinDark };

const HEADERS = [
  'Date', 'Day', 'Login', 'Logout', 'Worked', 'Required', 'Deficiency', 'Overtime', 'Status',
];
// REMARKS/APPROVED are blank, hand-filled columns on the printed sheet —
// never populated by this export, only their header cell is styled.
const MANUAL_HEADERS = ['REMARKS', 'APPROVED'];
const WIDTHS = [20, 10, 9, 9, 10, 10, 12, 10, 15, 11, 12];
// Matches the compact-layout reference file's own column widths exactly —
// narrower than WIDTHS above since that design relies on the merged
// Prepared-by/signature-box footer to breathe, not wide data columns.
const COMPACT_WIDTHS = [13.29, 5.29, 7, 7.57, 8.14, 8.43, 10.29, 9.43, 12.86, 10.14, 13.43];

/**
 * Status → font color, so problem days read at a glance. Present/Overtime/
 * Deficient/Single Punch/No Attendance/Holiday come from the Timesheet
 * Processor (device-log) report; Absent/Leave/Sick/Off come from the real
 * Attendance-based monthly report (monthlyReport.service.js) — the same
 * renderer serves both, so both vocabularies live in one map. Looked up by
 * the RAW status value always (never the display label — see
 * `compactLayout`'s own doc comment above), so a compact-layout "Absent"
 * (really the Processor's own No Attendance, just relabeled) keeps its own
 * muted-gray color instead of colliding with the Monthly Report's real,
 * red "Absent" below.
 */
const STATUS_COLOR = {
  Present: 'FF16A34A',
  Overtime: 'FFB45309',
  Deficient: 'FFDC2626',
  'Single Punch': 'FF4F46E5',
  'No Attendance': MUTED,
  Holiday: 'FF0D9488', // teal
  'Holiday (Worked)': 'FFB45309', // amber, like overtime
  Absent: 'FFDC2626', // red, same family as Deficient
  Leave: 'FF0D9488', // teal, same family as Holiday — an excused day off
  Sick: 'FF0D9488', // teal, same family as Holiday — an excused day off
  Off: MUTED, // gray, same family as No Attendance — a neutral non-working day
};

// compactLayout-only: the raw status value shown as different, friendlier
// text — color lookup above still keys off the RAW value, never this.
const COMPACT_DISPLAY_LABEL = {
  'No Attendance': 'Absent',
};

/** Sets a border around a (possibly merged) rectangular range so every
 *  physical row/column of the merge gets the correct edge segment — a
 *  merged cell's hidden sub-cells still need their own border set for the
 *  box to actually render on every row (ExcelJS/xlsx quirk, confirmed
 *  against the reference file's own raw cell styles). */
function applyBoxBorder(ws, r1, c1, r2, c2, style = thin) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const border = {};
      if (r === r1) border.top = style;
      if (r === r2) border.bottom = style;
      if (c === c1) border.left = style;
      if (c === c2) border.right = style;
      ws.getCell(r, c).border = border;
    }
  }
}

/**
 * @param {object} result  the object returned by timesheet.service.processTimesheet
 * @param {{buffer: Buffer, extension: 'png'|'jpeg'|'gif'} | null} [logo]
 *   already-fetched company logo bytes, or null/undefined for no logo — the
 *   normal case until an Admin uploads one (see companySettings module).
 * @param {{compactLayout?: boolean}} [options]
 */
export async function buildTimesheetXlsx(result, logo = null, { compactLayout = false } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Al Jazeera ERP';
  wb.created = new Date();
  const lastCol = HEADERS.length + MANUAL_HEADERS.length; // 11

  const ws = wb.addWorksheet('Timesheet');

  let r = 1;

  // ---- Logo band (optional) ----------------------------------------------
  if (logo) {
    const imageId = wb.addImage({ buffer: logo.buffer, extension: logo.extension });
    ws.mergeCells(r, 1, r, lastCol);
    if (compactLayout) {
      // A small top-left mark, not a stretched full-width banner — matches
      // the reference file's own drawing anchor (≈4 columns wide).
      ws.getRow(r).height = 60;
      ws.addImage(imageId, { tl: { col: 0, row: r - 1 }, br: { col: 4, row: r }, editAs: 'oneCell' });
    } else {
      ws.getRow(r).height = 116.25;
      // 0-indexed cell anchors — fills the merged band exactly, stretching
      // the image to fit (same as a picture pasted and stretched in Excel).
      ws.addImage(imageId, { tl: { col: 0, row: r - 1 }, br: { col: lastCol, row: r }, editAs: 'oneCell' });
    }
    r += 1;
  }

  // ---- Title band ----------------------------------------------------------
  if (compactLayout) {
    // Title (left, 3 cols) and Month/Year (right, one cell) share a single
    // row — matches the reference file exactly, and is what makes the
    // smaller logo above look proportionate instead of leaving a gap.
    ws.mergeCells(r, 1, r, 3);
    const titleCell = ws.getCell(r, 1);
    titleCell.value = 'Monthly Timesheet';
    titleCell.font = { bold: true, size: 16, color: { argb: INK } };
    titleCell.alignment = { horizontal: 'center' };

    const monthCell = ws.getCell(r, lastCol - 1);
    monthCell.value = `${result.monthName.toUpperCase()}-${result.year}`;
    monthCell.font = { bold: true, size: 16 };
    monthCell.border = allBorders;
    ws.getRow(r).height = 21;
    r += 1;

    ws.mergeCells(r, 1, r, lastCol);
    const nameCell = ws.getCell(r, 1);
    nameCell.value = result.employee.fullName;
    nameCell.font = { bold: true, underline: true, size: 14 };
    nameCell.alignment = { horizontal: 'center' };
    r += 1;

    ws.mergeCells(r, 1, r, lastCol - 2);
    const requiredCell = ws.getCell(r, 1);
    requiredCell.value =
      `Required hours/day: ${minutesToHHMM(result.requiredMinutes)}   ·   ` +
      `Generated: ${new Date(result.generatedAt).toLocaleString('en-GB')}`;
    requiredCell.font = { size: 10, color: { argb: MUTED } };
    r += 1;
  } else {
    ws.mergeCells(r, 1, r, lastCol);
    ws.getCell(r, 1).value = 'Monthly Timesheet';
    ws.getCell(r, 1).font = { bold: true, size: 16, color: { argb: INK } };
    r += 1;

    ws.mergeCells(r, 1, r, lastCol);
    ws.getCell(r, 1).value = result.employee.fullName;
    ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: INK } };
    r += 1;

    ws.mergeCells(r, 1, r, lastCol);
    ws.getCell(r, 1).value = `${result.monthName} ${result.year}`;
    ws.getCell(r, 1).font = { size: 11, color: { argb: INK } };
    r += 1;

    ws.mergeCells(r, 1, r, lastCol);
    ws.getCell(r, 1).value =
      `Required hours/day: ${minutesToHHMM(result.requiredMinutes)}   ·   ` +
      `Generated: ${new Date(result.generatedAt).toLocaleString('en-GB')}`;
    ws.getCell(r, 1).font = { size: 10, color: { argb: MUTED } };
    r += 1;
  }

  // ---- Column headers ------------------------------------------------------
  const headerRowNumber = r;
  const headerRow = ws.getRow(r);
  HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = compactLayout ? { bold: true, size: 11 } : { bold: true, color: { argb: INK } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = allBorders;
  });
  // REMARKS/APPROVED — a distinct, hand-fill-in look (Arial, a solid dark
  // border) on the header only; data rows leave these two columns untouched.
  MANUAL_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(HEADERS.length + i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, name: 'Arial' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = darkBorders;
  });
  headerRow.height = compactLayout ? 18 : 20.1;
  r += 1;

  // ---- Data rows -------------------------------------------------------
  const displayLabel = compactLayout ? COMPACT_DISPLAY_LABEL : {};
  result.rows.forEach((row, idx) => {
    const excelRow = ws.getRow(r);
    const values = [
      row.date,
      row.day,
      row.login ?? '',
      row.logout ?? '',
      minutesToHHMM(row.workedMinutes),
      minutesToHHMM(row.requiredMinutes),
      minutesToHHMM(row.deficiencyMinutes),
      minutesToHHMM(row.overtimeMinutes),
      displayLabel[row.status] ?? row.status,
    ];
    values.forEach((v, i) => {
      excelRow.getCell(i + 1).value = v;
    });
    excelRow.eachCell({ includeEmpty: false }, (cell, col) => {
      if (col > HEADERS.length) return; // REMARKS/APPROVED stay blank & unstyled
      cell.border = allBorders;
      cell.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
      if (idx % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } };
      }
    });
    // Colour the status cell — keyed by the RAW status, never the display
    // label (see STATUS_COLOR's own doc comment).
    const statusCell = excelRow.getCell(HEADERS.length);
    statusCell.font = { bold: true, color: { argb: STATUS_COLOR[row.status] ?? INK } };
    r += 1;
  });

  // ---- TOTAL row (compactLayout only — matches the reference file; the
  // classic layout has never had one) ----------------------------------
  if (compactLayout) {
    const s = result.summary;
    const totalRow = ws.getRow(r);
    totalRow.getCell(1).value = 'TOTAL';
    totalRow.getCell(1).font = { bold: true, size: 11 };
    totalRow.getCell(5).value = minutesToHHMM(s.totalWorkedMinutes);
    totalRow.getCell(6).value = minutesToHHMM(s.totalRequiredMinutes);
    totalRow.getCell(7).value = minutesToHHMM(s.totalDeficiencyMinutes);
    totalRow.getCell(8).value = minutesToHHMM(s.totalOvertimeMinutes);
    for (let c = 5; c <= 8; c++) totalRow.getCell(c).alignment = { horizontal: 'center' };
    applyBoxBorder(ws, r, 1, r, lastCol);
    r += 2; // + a blank spacer row, matching the reference
  } else {
    r += 1; // blank spacer row
  }

  // ---- Summary block -----------------------------------------------------
  const s = result.summary;
  if (compactLayout) {
    // 3-pair grid (Working/Present/Absent, Holidays/Single Punch/Medical) —
    // "Medical" has no data source anywhere in this app (a device-log punch
    // report has no way to know a day off was for medical reasons), so it's
    // left blank/manual at 0, same posture as REMARKS/APPROVED above.
    ws.mergeCells(r, 1, r, 8);
    const summaryHeader = ws.getCell(r, 1);
    summaryHeader.value = 'Monthly Summary';
    summaryHeader.font = { bold: true, size: 12, color: { argb: INK } };
    summaryHeader.alignment = { horizontal: 'center' };
    applyBoxBorder(ws, r, 1, r, 8);
    const summaryHeaderRow = r;
    r += 1;

    const gridRows = [
      ['Working Days', String(s.workingDays), 'Present Days', String(s.presentDays), 'Absent', String(s.noAttendanceDays)],
      ['Holidays', String(s.holidayDays), 'Single Punch Days', String(s.singlePunchDays), 'Medical', '0'],
    ];
    for (const [label1, value1, label2, value2, label3, value3] of gridRows) {
      const row = ws.getRow(r);
      row.getCell(1).value = label1;
      row.getCell(1).font = { bold: true, color: { argb: INK } };
      row.getCell(2).value = value1;
      row.getCell(2).alignment = { horizontal: 'center' };
      ws.mergeCells(r, 4, r, 5);
      row.getCell(4).value = label2;
      row.getCell(4).font = { bold: true, color: { argb: INK } };
      row.getCell(4).alignment = { horizontal: 'left' };
      row.getCell(6).value = value2;
      row.getCell(6).alignment = { horizontal: 'center' };
      row.getCell(7).value = label3;
      row.getCell(7).font = { bold: true, color: { argb: INK } };
      row.getCell(8).value = value3;
      row.getCell(8).alignment = { horizontal: 'center' };
      applyBoxBorder(ws, r, 1, r, 8);
      r += 1;
    }
    const summaryLastRow = r - 1;
    // Full outer box around the whole summary block (header + 2 grid rows),
    // on top of each row's own box — matches the reference file.
    applyBoxBorder(ws, summaryHeaderRow, 1, summaryLastRow, 8);

    // ---- Signature footer (Prepared by / Verified By / Approved By) ----
    // No spacer row here — the reference file has the signature block
    // immediately adjacent to the summary grid (confirmed against its own
    // raw borders: row 41's bottom border and row 42's top border meet with
    // nothing in between).
    const sigTop = r;
    const sigBottom = r + 2;
    const signatureBlocks = [
      { labelCols: [1, 2], boxCol: 3 },
      { labelCols: [4, 5], boxCol: 6 },
      { labelCols: [7, 8], boxCol: null },
    ];
    const labels = ['Prepared by', 'Verified By', 'Approved By'];
    signatureBlocks.forEach(({ labelCols, boxCol }, i) => {
      ws.mergeCells(sigTop, labelCols[0], sigBottom, labelCols[1]);
      const cell = ws.getCell(sigTop, labelCols[0]);
      cell.value = labels[i];
      cell.font = { bold: true, underline: true, size: 11 };
      cell.alignment = { horizontal: 'center', vertical: 'top' };
      applyBoxBorder(ws, sigTop, labelCols[0], sigBottom, labelCols[1]);
      if (boxCol) {
        ws.mergeCells(sigTop, boxCol, sigBottom, boxCol);
        applyBoxBorder(ws, sigTop, boxCol, sigBottom, boxCol);
      }
    });

    // ---- Comments box (2026-10-01, confirmed against the user's own
    // reference screenshot — genuinely missing from the first pass) — spans
    // the full height of the summary grid + signature block, columns 9-11. ----
    ws.mergeCells(summaryHeaderRow, 9, sigBottom, lastCol);
    const commentsCell = ws.getCell(summaryHeaderRow, 9);
    commentsCell.value = 'COMMENTS';
    commentsCell.alignment = { horizontal: 'center', vertical: 'top' };
    applyBoxBorder(ws, summaryHeaderRow, 9, sigBottom, lastCol);

    r = sigBottom + 1;
  } else {
    ws.getCell(r, 1).value = 'Monthly Summary';
    ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: INK } };
    r += 1;

    // Callers with a different set of statuses (e.g. the real-attendance
    // monthly report's Absent/Leave/Sick/Off, vs this device-log report's
    // Single Punch/No Attendance) pass their own summaryLines; otherwise this
    // is the original 9-line Processor summary, unchanged.
    const summaryLines = result.summaryLines ?? [
      ['Working Days', String(s.workingDays)],
      ['Holidays', String(s.holidayDays)],
      ['Present Days', String(s.presentDays)],
      ['Single Punch Days', String(s.singlePunchDays)],
      ['No Attendance Days', String(s.noAttendanceDays)],
      ['Total Worked Hours', minutesToHHMM(s.totalWorkedMinutes)],
      ['Total Required Hours', minutesToHHMM(s.totalRequiredMinutes)],
      ['Total Deficiency', minutesToHHMM(s.totalDeficiencyMinutes)],
      ['Total Overtime', minutesToHHMM(s.totalOvertimeMinutes)],
    ];
    for (const [label, value] of summaryLines) {
      const row = ws.getRow(r);
      row.getCell(1).value = label;
      row.getCell(2).value = value;
      row.getCell(1).font = { bold: true, color: { argb: INK } };
      row.getCell(1).border = allBorders;
      row.getCell(2).border = allBorders;
      row.getCell(2).alignment = { horizontal: 'center' };
      r += 1;
    }
  }

  // ---- Column widths -----------------------------------------------------
  const widths = compactLayout ? COMPACT_WIDTHS : WIDTHS;
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  // Freeze pane sits right below the column-header row — computed from the
  // row that was ACTUALLY used, not guessed upfront (fixed 2026-10-01: the
  // old precomputed `logo ? 7 : 6` was off by one for both branches, a
  // harmless but real inconsistency — freezing one row too low).
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

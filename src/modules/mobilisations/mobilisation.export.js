/**
 * Mobilisation Excel export — turns already-visibility-checked mobilisation
 * data (from mobilisation.service.js's getMobilisation/exportMobilisations,
 * which strip fields the caller isn't entitled to see) into a downloadable
 * .xlsx buffer. Mirrors attendance.export.js's own pattern. Columns match
 * the detail page's own two sections (Worker & placement, Rates &
 * financials) exactly, so the spreadsheet reads the same way the screen
 * does; a field simply comes out blank for a row where the caller's own
 * access already stripped it — no separate "can I show this column" logic
 * needed here.
 */
import ExcelJS from 'exceljs';

const WORKER_COLUMNS = [
  { header: 'Serial', key: 'serialNumber', width: 12 },
  { header: 'Worker name', key: 'workerName', width: 24 },
  { header: 'Worker type', key: 'workerType', width: 16 },
  { header: 'Iqama number', key: 'iqamaNumber', width: 16 },
  { header: 'Nationality', key: 'nationality', width: 14 },
  { header: 'Phone', key: 'phone', width: 16 },
  { header: 'Job title', key: 'jobTitle', width: 20 },
  { header: 'Client', key: 'clientName', width: 26 },
  { header: 'Subcontractor', key: 'subcontractorName', width: 20 },
  { header: 'Mobilisation date', key: 'mobilisationDate', width: 16 },
  { header: 'Checkout date', key: 'checkoutDate', width: 16 },
  { header: 'Status', key: 'status', width: 14 },
];

const RATE_COLUMNS = [
  { header: 'Client rate', key: 'clientRate', width: 12 },
  { header: 'Client commission', key: 'clientCommission', width: 14 },
  { header: 'FTA', key: 'fta', width: 10 },
  { header: 'Allowance', key: 'allowance', width: 10 },
  { header: 'Required timesheet hours', key: 'requiredTimesheetHours', width: 18 },
  { header: 'Subcontractor rate', key: 'subcontractorRate', width: 14 },
  { header: 'Subcontractor commission', key: 'subcontractorCommission', width: 18 },
  { header: 'Profit per hour', key: 'profitPerHour', width: 14 },
  { header: 'Profit per month', key: 'profitPerMonth', width: 16 },
  { header: 'OT client rate', key: 'otClientRate', width: 14 },
  { header: 'OT client commission', key: 'otClientCommission', width: 16 },
  { header: 'OT subcontractor rate', key: 'otSubcontractorRate', width: 16 },
  { header: 'OT subcontractor commission', key: 'otSubcontractorCommission', width: 20 },
  { header: 'OT profit per hour', key: 'otProfitPerHour', width: 16 },
];

const COLUMNS = [...WORKER_COLUMNS, ...RATE_COLUMNS];

const DATE_KEYS = new Set(['mobilisationDate', 'checkoutDate']);

function toRow(m) {
  const row = {};
  for (const col of COLUMNS) {
    const value = m[col.key];
    row[col.key] = DATE_KEYS.has(col.key) && value ? new Date(value).toISOString().slice(0, 10) : value ?? '';
  }
  return row;
}

function addSheet(workbook, sheetName, mobilisations) {
  const ws = workbook.addWorksheet(sheetName);
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
  });
  for (const m of mobilisations) ws.addRow(toRow(m));
  return ws;
}

/** One mobilisation, one row, same columns as the bulk export — kept
 *  consistent rather than a special single-record layout, so a person
 *  comparing an individual export against the full sheet sees the same
 *  shape. Returns a Buffer. */
export async function buildMobilisationXlsx(mobilisation) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Al Jazeera ERP';
  addSheet(wb, 'Mobilisation', [mobilisation]);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Every mobilisation matching the caller's current filters/visibility, one
 *  row each. Returns a Buffer. */
export async function buildMobilisationsListXlsx(mobilisations) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Al Jazeera ERP';
  addSheet(wb, 'Mobilisations', mobilisations);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

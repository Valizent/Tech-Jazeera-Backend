/**
 * Deployment Excel export (2026-09-16, the user's own ask) — turns already-
 * visibility-checked deployment data (from deployment.service.js's
 * exportDeployments, which strips otAmount the same way the list/single-
 * record reads already do) into a downloadable .xlsx buffer. Mirrors
 * mobilisation.export.js's own pattern exactly. Columns match the register's
 * own row shape plus every field its detail page shows, so the spreadsheet
 * reads the same way the screen does.
 */
import ExcelJS from 'exceljs';

const COLUMNS = [
  { header: 'Worker', key: 'workerName', width: 24 },
  { header: 'Worker type', key: 'workerType', width: 16 },
  { header: 'Client', key: 'clientName', width: 26 },
  { header: 'Site', key: 'site', width: 18 },
  { header: 'Subcontractor', key: 'subcontractorName', width: 20 },
  { header: 'Contract hours / month', key: 'requiredTimesheetHours', width: 18 },
  { header: 'Start date', key: 'startDate', width: 14 },
  { header: 'End date', key: 'endDate', width: 14 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'End reason', key: 'endReason', width: 20 },
  { header: 'Notes', key: 'notes', width: 30 },
];

const DATE_KEYS = new Set(['startDate', 'endDate']);

function toRow(d) {
  const row = {};
  for (const col of COLUMNS) {
    const value = d[col.key];
    row[col.key] = DATE_KEYS.has(col.key) && value ? new Date(value).toISOString().slice(0, 10) : value ?? '';
  }
  return row;
}

/** Every deployment matching the caller's current filters/visibility, one
 *  row each. Returns a Buffer. */
export async function buildDeploymentsListXlsx(deployments) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Al Jazeera ERP';
  const ws = wb.addWorksheet('Deployments');
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
  });
  for (const d of deployments) ws.addRow(toRow(d));
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

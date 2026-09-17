/**
 * Deployment Excel export (2026-09-16, the user's own ask) — turns already-
 * visibility-checked deployment data (from deployment.service.js's
 * exportDeployments, which strips otAmount the same way the list/single-
 * record reads already do) into a downloadable .xlsx buffer. Mirrors
 * mobilisation.export.js's own pattern exactly. Columns match the register's
 * own row shape plus every field its detail page shows, so the spreadsheet
 * reads the same way the screen does.
 *
 * 2026-09-17 follow-up (the user's own ask — "need every single data entered
 * in mobilisation"): MOBILISATION_COLUMNS appends the fields Mobilisation
 * itself carries, read off the `mobilisation` sub-document deployment.
 * service.js's findDeployments now populates. Same field list/order as
 * mobilisation.export.js's own WORKER_COLUMNS + RATE_COLUMNS, minus whatever
 * Deployment already snapshots as its own column (worker/client/subcontractor
 * name, worker type, site, contract hours, start date) — see
 * deployment.service.js's own MOBILISATION_OVERVIEW_FIELDS doc comment for
 * exactly what's excluded and why. A commercial field the caller's own
 * access already stripped simply comes out blank here too — no separate
 * "can I show this column" logic needed, same posture as mobilisation.
 * export.js's own doc comment.
 */
import ExcelJS from 'exceljs';

const DEPLOYMENT_COLUMNS = [
  { header: 'Worker', key: 'workerName', width: 24 },
  { header: 'Worker type', key: 'workerType', width: 16 },
  { header: 'Client', key: 'clientName', width: 26 },
  { header: 'Site', key: 'site', width: 18 },
  { header: 'Subcontractor', key: 'subcontractorName', width: 20 },
  { header: 'Contract hours / month', key: 'requiredTimesheetHours', width: 18 },
  { header: 'Start date', key: 'startDate', width: 14, date: true },
  { header: 'End date', key: 'endDate', width: 14, date: true },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'End reason', key: 'endReason', width: 20 },
  { header: 'Notes', key: 'notes', width: 30 },
];

const MOBILISATION_COLUMNS = [
  { header: 'Mobilisation #', key: 'mobSerialNumber', width: 14, get: (d) => d.mobilisation?.serialNumber },
  { header: 'Job title', key: 'mobJobTitle', width: 20, get: (d) => d.mobilisation?.jobTitle },
  { header: 'Iqama number', key: 'mobIqamaNumber', width: 16, get: (d) => d.mobilisation?.iqamaNumber },
  { header: 'Nationality', key: 'mobNationality', width: 14, get: (d) => d.mobilisation?.nationality },
  { header: 'Phone', key: 'mobPhone', width: 16, get: (d) => d.mobilisation?.phone },
  { header: 'Checkout date', key: 'mobCheckoutDate', width: 16, date: true, get: (d) => d.mobilisation?.checkoutDate },
  { header: 'FTA', key: 'mobFta', width: 10, get: (d) => d.mobilisation?.fta },
  { header: 'FTA type', key: 'mobFtaType', width: 16, get: (d) => d.mobilisation?.ftaType },
  { header: 'Allowance', key: 'mobAllowance', width: 10, get: (d) => d.mobilisation?.allowance },
  { header: 'Allowance remark', key: 'mobAllowanceRemark', width: 20, get: (d) => d.mobilisation?.allowanceRemark },
  { header: 'Client rate', key: 'mobClientRate', width: 12, get: (d) => d.mobilisation?.clientRate },
  { header: 'Client commission', key: 'mobClientCommission', width: 14, get: (d) => d.mobilisation?.clientCommission },
  { header: 'Subcontractor rate', key: 'mobSubcontractorRate', width: 14, get: (d) => d.mobilisation?.subcontractorRate },
  {
    header: 'Subcontractor commission',
    key: 'mobSubcontractorCommission',
    width: 18,
    get: (d) => d.mobilisation?.subcontractorCommission,
  },
  { header: 'OT client rate', key: 'mobOtClientRate', width: 14, get: (d) => d.mobilisation?.otClientRate },
  { header: 'OT employee rate', key: 'mobOtEmployeeRate', width: 16, get: (d) => d.mobilisation?.otEmployeeRate },
  { header: 'Profit per hour', key: 'mobProfitPerHour', width: 14, get: (d) => d.mobilisation?.profitPerHour },
  { header: 'Profit per month', key: 'mobProfitPerMonth', width: 16, get: (d) => d.mobilisation?.profitPerMonth },
  { header: 'OT profit per hour', key: 'mobOtProfitPerHour', width: 16, get: (d) => d.mobilisation?.otProfitPerHour },
];

const COLUMNS = [...DEPLOYMENT_COLUMNS, ...MOBILISATION_COLUMNS];

function toRow(d) {
  const row = {};
  for (const col of COLUMNS) {
    const value = col.get ? col.get(d) : d[col.key];
    row[col.key] = col.date && value ? new Date(value).toISOString().slice(0, 10) : value ?? '';
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

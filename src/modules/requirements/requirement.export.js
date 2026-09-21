/**
 * Requirements Excel export (Coordinator Workflow, milestone 4) — turns the cards
 * requirement.service.js's exportRequirements already scoped to what the caller may
 * see into a downloadable .xlsx buffer. Two sheets, because the pipeline has two
 * levels a manager wants to filter independently in Excel:
 *
 *   Requirements — one row per card (client, job, headcount, stage, how long it has
 *                  sat there, whether that is stale, who is on it, candidate counts).
 *   Candidates   — one row per worker being lined up, with the card's number, client
 *                  and stage repeated on each row so it filters on its own — e.g. every
 *                  worker from one subcontractor whose documents aren't ready yet.
 *
 * No commercial data appears here because none exists on a requirement (rates are
 * entered at Mobilisation). Header row frozen and auto-filterable.
 */
import ExcelJS from 'exceljs';

const WORKER_TYPE_LABEL = { SupplierEmployee: 'Subcontractor worker', Freelancer: 'Freelancer' };
const CANDIDATE_STATUS_LABEL = {
  Identified: 'Identified',
  DocsInProgress: 'Docs in progress',
  DocsReady: 'Docs ready',
  Mobilised: 'Mobilised',
  Dropped: 'Dropped',
};

const dateOnly = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

const REQUIREMENT_COLUMNS = [
  { header: 'Requirement #', key: 'serialNumber', width: 15 },
  { header: 'Client', key: 'clientName', width: 26 },
  { header: 'Job title', key: 'jobTitle', width: 24 },
  { header: 'Workers needed', key: 'headcount', width: 15 },
  { header: 'Needed by', key: 'neededBy', width: 13 },
  { header: 'Site', key: 'site', width: 20 },
  { header: 'Stage', key: 'stageName', width: 20 },
  { header: 'Days in stage', key: 'daysInStage', width: 14 },
  { header: 'Stale', key: 'stale', width: 8 },
  { header: 'Coordinators', key: 'coordinators', width: 26 },
  { header: 'Candidates', key: 'candidateCount', width: 12 },
  { header: 'Mobilised', key: 'mobilisedCount', width: 11 },
  { header: 'Added on', key: 'createdAt', width: 13 },
  { header: 'Notes', key: 'notes', width: 40 },
];

const CANDIDATE_COLUMNS = [
  { header: 'Requirement #', key: 'serialNumber', width: 15 },
  { header: 'Client', key: 'clientName', width: 26 },
  { header: 'Job title', key: 'jobTitle', width: 24 },
  { header: 'Stage', key: 'stageName', width: 20 },
  { header: 'Worker', key: 'workerName', width: 26 },
  { header: 'Worker type', key: 'workerType', width: 21 },
  { header: 'Subcontractor', key: 'subcontractorName', width: 24 },
  { header: 'Iqama number', key: 'iqamaNumber', width: 15 },
  { header: 'Nationality', key: 'nationality', width: 15 },
  { header: 'Phone', key: 'phone', width: 17 },
  { header: 'Status', key: 'status', width: 17 },
  { header: 'Documents note', key: 'docsNote', width: 36 },
  { header: 'Mobilisation #', key: 'mobilisation', width: 15 },
];

const requirementRow = (r) => ({
  serialNumber: r.serialNumber,
  clientName: r.clientName,
  jobTitle: r.jobTitle,
  headcount: r.headcount,
  neededBy: dateOnly(r.neededBy),
  site: r.site ?? '',
  stageName: r.stageName,
  daysInStage: r.daysInStage,
  stale: r.stale ? 'Yes' : '',
  coordinators: r.coordinators.map((c) => c.name).join(', '),
  candidateCount: r.candidateCount,
  mobilisedCount: r.mobilisedCount,
  createdAt: dateOnly(r.createdAt),
  notes: r.notes ?? '',
});

const candidateRow = (r, c) => ({
  serialNumber: r.serialNumber,
  clientName: r.clientName,
  jobTitle: r.jobTitle,
  stageName: r.stageName,
  workerName: c.workerName,
  workerType: WORKER_TYPE_LABEL[c.workerType] ?? c.workerType,
  subcontractorName: c.subcontractorName ?? '',
  iqamaNumber: c.iqamaNumber ?? '',
  nationality: c.nationality ?? '',
  phone: c.phone ?? '',
  status: CANDIDATE_STATUS_LABEL[c.status] ?? c.status,
  docsNote: c.docsNote ?? '',
  mobilisation: c.mobilisation?.serialNumber ?? '',
});

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const row of rows) sheet.addRow(row);
}

/** `requirements` are the presented cards from exportRequirements (candidates included). Returns a Buffer. */
export async function buildRequirementsXlsx(requirements) {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'Requirements', REQUIREMENT_COLUMNS, requirements.map(requirementRow));
  addSheet(
    workbook,
    'Candidates',
    CANDIDATE_COLUMNS,
    requirements.flatMap((r) => r.candidates.map((c) => candidateRow(r, c)))
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

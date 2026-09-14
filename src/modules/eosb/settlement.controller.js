/**
 * Settlement controller — HTTP translation. The PDF endpoint streams a file
 * (not the JSON envelope), like the quotation PDF.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as settlementService from './settlement.service.js';
import { buildSettlementPdf } from './settlement.pdf.js';
import { getLetterheadData } from '../companySettings/companySettings.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/eosb — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await settlementService.listSettlements(req.query, actor(req));
  res.json(new ApiResponse('Settlements.', data));
}

/** GET /api/eosb/:id — 200 → data: settlement */
export async function get(req, res) {
  const settlement = await settlementService.getSettlement(req.params.id, actor(req));
  res.json(new ApiResponse('Settlement.', settlement));
}

/** POST /api/eosb — 201 → data: settlement (figures computed server-side) */
export async function create(req, res) {
  const settlement = await settlementService.createSettlement(req.body, actor(req));
  res.status(201).json(new ApiResponse('Settlement computed.', settlement));
}

/** DELETE /api/eosb/:id — 200 → data: null */
export async function remove(req, res) {
  await settlementService.deleteSettlement(req.params.id, actor(req));
  res.json(new ApiResponse('Settlement deleted.'));
}

/** GET /api/eosb/:id/pdf — downloads the settlement as a PDF. */
export async function pdf(req, res) {
  const settlement = await settlementService.getSettlement(req.params.id, actor(req));
  const { company, logo } = await getLetterheadData();
  const buffer = await buildSettlementPdf(settlement, company, logo);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="EOSB-${settlement.employeeCode}.pdf"`);
  res.send(buffer);
}

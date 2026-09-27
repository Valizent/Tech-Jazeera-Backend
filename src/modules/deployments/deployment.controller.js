/**
 * Deployment controller — HTTP translation only. The invoice-file endpoint
 * streams bytes (not the JSON envelope), same pattern as reimbursement.
 * controller.js's own receipt endpoint.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import * as deploymentService from './deployment.service.js';
import { buildDeploymentsListXlsx } from './deployment.export.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/deployments — 200 → data: { items, total, page, pages } */
export async function list(req, res) {
  const data = await deploymentService.listDeployments(req.query, actor(req));
  res.json(new ApiResponse('Deployments.', data));
}

/** GET /api/deployments/export?... — downloads a .xlsx, one row per
 *  deployment matching the caller's current filters/visibility (same rules
 *  as `list`). */
export async function exportAll(req, res) {
  const deployments = await deploymentService.exportDeployments(req.query, actor(req));
  const buffer = await buildDeploymentsListXlsx(deployments);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="deployments_${new Date().toISOString().slice(0, 10)}.xlsx"`
  );
  res.send(buffer);
}

/** GET /api/deployments/standby — 200 → data: { ownEmployees, subcontractedWorkers } */
export async function standby(req, res) {
  const data = await deploymentService.getStandbyWorkforce();
  res.json(new ApiResponse('Standby workforce.', data));
}

/** GET /api/deployments/payments-due — 200 → data: [{...}] */
export async function paymentsDue(req, res) {
  const data = await deploymentService.getPaymentsDue(actor(req));
  res.json(new ApiResponse('Payments due.', data));
}

/** GET /api/deployments/ready-to-invoice — 200 → data: [{...}] */
export async function readyToInvoice(req, res) {
  const data = await deploymentService.getReadyToInvoice(actor(req));
  res.json(new ApiResponse('Ready to invoice.', data));
}

/** GET /api/deployments/:id — 200 → data: deployment */
export async function get(req, res) {
  const deployment = await deploymentService.getDeployment(req.params.id, actor(req));
  res.json(new ApiResponse('Deployment.', deployment));
}

/** PATCH /api/deployments/:id — 200 → data: deployment */
export async function update(req, res) {
  const deployment = await deploymentService.updateDeployment(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Deployment updated.', deployment));
}

/** POST /api/deployments/:id/monthly-hours — 201 → data: deployment */
export async function addMonthlyHours(req, res) {
  const deployment = await deploymentService.addMonthlyHours(req.params.id, req.body, actor(req));
  res.status(201).json(new ApiResponse('Monthly hours recorded.', deployment));
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId — 200 → data: deployment */
export async function updateMonthlyHours(req, res) {
  const deployment = await deploymentService.updateMonthlyHours(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Monthly hours updated.', deployment));
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId/decide — 200 → data: deployment */
export async function decideMonthlyHours(req, res) {
  const deployment = await deploymentService.decideMonthlyHours(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Decision recorded.', deployment));
}

/** POST /api/deployments/:id/monthly-hours/:entryId/send-invoice — multipart
 *  (invoiceNumber, invoiceDate, file) — 200 → data: deployment */
export async function sendInvoice(req, res) {
  const deployment = await deploymentService.sendInvoice(req.params.id, req.params.entryId, req.body, req.file, actor(req));
  res.json(new ApiResponse('Invoice marked as sent.', deployment));
}

/** GET /api/deployments/:id/monthly-hours/:entryId/invoice-file — streams the invoice PDF */
export async function invoiceFile(req, res) {
  const fileData = await deploymentService.getInvoiceFile(req.params.id, req.params.entryId, actor(req));
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored invoice file is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId/payment — 200 → data: deployment */
export async function recordPayment(req, res) {
  const deployment = await deploymentService.recordPayment(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Payment recorded.', deployment));
}

/** PATCH /api/deployments/:id/monthly-hours/:entryId/payment/decide — 200 → data: deployment */
export async function decidePayment(req, res) {
  const deployment = await deploymentService.decidePayment(req.params.id, req.params.entryId, req.body, actor(req));
  res.json(new ApiResponse('Payment decision recorded.', deployment));
}

/** POST /api/deployments/:id/demobilise — 200 → data: null */
export async function demobilise(req, res) {
  await deploymentService.demobiliseDeployment(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Deployment demobilised.'));
}

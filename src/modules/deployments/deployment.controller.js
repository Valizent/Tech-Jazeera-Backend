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
import * as clientPaymentService from './clientPayment.service.js';
import * as subcontractorPaymentService from './subcontractorPayment.service.js';
import * as subcontractorInvoiceService from './subcontractorInvoice.service.js';
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

/** GET /api/deployments/payments-due — 200 → data: [{...}], one row per client */
export async function paymentsDue(req, res) {
  const data = await deploymentService.getClientsPaymentSummary(actor(req));
  res.json(new ApiResponse('Payments due.', data));
}

/** GET /api/deployments/paid-invoices — 200 → data: [{...}], flat list of paid invoices */
export async function paidInvoices(req, res) {
  const data = await deploymentService.getPaidInvoices(actor(req));
  res.json(new ApiResponse('Paid invoices.', data));
}

/** GET /api/deployments/payments-due/:clientId — 200 → data: {...} drill-down */
export async function clientPaymentDetail(req, res) {
  const data = await deploymentService.getClientPaymentDetail(req.params.clientId, actor(req));
  res.json(new ApiResponse('Client payment detail.', data));
}

/** GET /api/deployments/pending-hours — 200 → data: [{...}] manager review queue */
export async function pendingHoursQueue(req, res) {
  const data = await deploymentService.getPendingHoursQueue(actor(req));
  res.json(new ApiResponse('Pending hours queue.', data));
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
  const fileData = await deploymentService.getInvoiceFile(req.params.id, req.params.entryId, actor(req), 'invoiceFile');
  await streamInvoiceFile(res, fileData);
}

/** GET /api/deployments/:id/monthly-hours/:entryId/sub-invoice-file — streams
 *  the subcontractor's invoice copy */
export async function subInvoiceFile(req, res) {
  const fileData = await deploymentService.getInvoiceFile(req.params.id, req.params.entryId, actor(req), 'subcontractorInvoiceFile');
  await streamInvoiceFile(res, fileData);
}

async function streamInvoiceFile(res, fileData) {
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored invoice file is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

/** POST /api/deployments/payments-due/:clientId/payments — 201 → data: payment
 *  (2026-09-27 bulk-payment redesign — one payment per CLIENT, not per
 *  worker/entry; see clientPayment.service.js). */
export async function recordClientPayment(req, res) {
  const payment = await clientPaymentService.recordClientPayment(req.params.clientId, req.body, actor(req));
  res.status(201).json(new ApiResponse('Payment recorded.', payment));
}

/** PATCH /api/deployments/client-payments/:paymentId/decide — 200 → data: payment */
export async function decideClientPayment(req, res) {
  const payment = await clientPaymentService.decideClientPayment(req.params.paymentId, req.body, actor(req));
  res.json(new ApiResponse('Payment decision recorded.', payment));
}

/** GET /api/deployments/pending-payments — 200 → data: payment[] */
export async function pendingPaymentsQueue(req, res) {
  const data = await clientPaymentService.getPendingPaymentsQueue(actor(req));
  res.json(new ApiResponse('Pending payments queue.', data));
}

/** GET /api/deployments/sub-pending-payments — 200 → data: payment[] */
export async function subPendingPaymentsQueue(req, res) {
  const data = await subcontractorPaymentService.getPendingPaymentsQueue(actor(req));
  res.json(new ApiResponse('Pending subcontractor payments queue.', data));
}

/** POST /api/deployments/:id/demobilise — 200 → data: null */
export async function demobilise(req, res) {
  await deploymentService.demobiliseDeployment(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Deployment demobilised.'));
}

/** POST /api/deployments/:id/monthly-hours/:entryId/sub-invoice — multipart
 *  (invoiceNumber, invoiceDate, file) — subcontractor-side mirror of
 *  sendInvoice above — 200 → data: deployment */
export async function recordSubInvoice(req, res) {
  const file = req.file;
  const data = await subcontractorInvoiceService.recordSubInvoice(req.params.id, req.params.entryId, req.body, file, actor(req));
  res.json(new ApiResponse('Subcontractor invoice recorded.', data));
}

/** GET /api/deployments/ready-for-sub-invoice — 200 → data: [{...}] */
export async function readyForSubInvoice(req, res) {
  const data = await subcontractorInvoiceService.getReadyForSubInvoice(actor(req));
  res.json(new ApiResponse('Ready for sub-invoice.', data));
}

/** GET /api/deployments/sub-payments-due — 200 → data: [{...}], one row per subcontractor */
export async function subPaymentsDue(req, res) {
  const data = await subcontractorInvoiceService.getSubcontractorsPaymentSummary(actor(req));
  res.json(new ApiResponse('Subcontractor payments due.', data));
}

/** GET /api/deployments/paid-sub-invoices — 200 → data: [{...}] */
export async function paidSubInvoices(req, res) {
  const data = await subcontractorInvoiceService.getPaidSubInvoices(actor(req));
  res.json(new ApiResponse('Paid subcontractor invoices.', data));
}

/** GET /api/deployments/sub-payments-due/:subcontractorId — 200 → data: {...} drill-down */
export async function subcontractorPaymentDetail(req, res) {
  const data = await subcontractorInvoiceService.getSubcontractorPaymentDetail(req.params.subcontractorId, actor(req));
  res.json(new ApiResponse('Subcontractor payment detail.', data));
}

/** POST /api/deployments/sub-payments-due/:subcontractorId/payments — 201 → data: payment */
export async function recordSubcontractorPayment(req, res) {
  const data = await subcontractorPaymentService.recordSubcontractorPayment(req.params.subcontractorId, req.body, actor(req));
  res.status(201).json(new ApiResponse('Payment recorded.', data));
}

/** PATCH /api/deployments/sub-payments/:paymentId/decide — 200 → data: payment */
export async function decideSubcontractorPayment(req, res) {
  const data = await subcontractorPaymentService.decideSubcontractorPayment(req.params.paymentId, req.body, actor(req));
  res.json(new ApiResponse('Payment decision recorded.', data));
}

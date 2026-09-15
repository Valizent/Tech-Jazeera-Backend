/**
 * Certificate request controller — HTTP translation only. `submit` is the
 * staff self-submission counterpart to /api/me (see exitDocuments.routes.js).
 * The PDF endpoint streams a file, same pattern as the quotation/settlement
 * PDFs.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import * as certificateService from './certificate.service.js';
import { buildSalaryCertificatePdf, buildServiceCertificatePdf } from './certificate.pdf.js';
import { getLetterheadData } from '../companySettings/companySettings.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

const BUILDERS = {
  SalaryCertificate: buildSalaryCertificatePdf,
  ServiceCertificate: buildServiceCertificatePdf,
};

/** POST /api/exit-documents/certificates — a staff member's own request. */
export async function submit(req, res) {
  if (!req.user.employee) {
    throw new ApiError(
      400,
      'Your account has no linked employee record, so there is nothing to submit a personal request against.'
    );
  }
  const request = await certificateService.submitCertificate(req.user.employee, req.body, actor(req));
  res.status(201).json(new ApiResponse('Certificate request submitted.', request));
}

export async function list(req, res) {
  const data = await certificateService.listCertificates(req.query, actor(req));
  res.json(new ApiResponse('Certificate requests.', data));
}

export async function decide(req, res) {
  const request = await certificateService.decideCertificate(req.params.id, req.body, actor(req));
  res.json(new ApiResponse(`Request ${request.status.toLowerCase()}.`, request));
}

export async function markIssued(req, res) {
  const request = await certificateService.markCertificateIssued(req.params.id, actor(req));
  res.json(new ApiResponse('Marked as issued.', request));
}

/** GET /api/exit-documents/certificates/:id/pdf — staff, any employee's request. */
export async function pdf(req, res) {
  const resolved = await certificateService.resolveCertificateForPdf(req.params.id, null, actor(req));
  await sendCertificatePdf(resolved, res);
}

export async function sendCertificatePdf({ request, employee, exitDate }, res) {
  const { company, logo } = await getLetterheadData();
  const buffer = await BUILDERS[request.type]({ employee, request, exitDate }, company, logo);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${request.type}-${employee.employeeId}.pdf"`);
  res.send(buffer);
}

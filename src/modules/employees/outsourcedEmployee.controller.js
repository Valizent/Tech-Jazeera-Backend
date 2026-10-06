import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as service from './outsourcedEmployee.service.js';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

export async function list(req, res) {
  const data = await service.listOutsourcedEmployees({
    search: req.query.search,
    workerType: req.query.workerType,
    limit: req.query.limit,
  });
  res.json(new ApiResponse('Outsourced employees retrieved.', data));
}

export async function get(req, res) {
  const data = await service.getOutsourcedEmployee(req.params.id);
  res.json(new ApiResponse('Outsourced employee retrieved.', data));
}

export async function create(req, res) {
  const data = await service.createOutsourcedEmployee(req.body, actor(req));
  res.status(201).json(new ApiResponse('Outsourced employee created.', data));
}

export async function update(req, res) {
  const data = await service.updateOutsourcedEmployee(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Outsourced employee updated.', data));
}

export async function remove(req, res) {
  await service.deleteOutsourcedEmployee(req.params.id, actor(req));
  res.json(new ApiResponse('Outsourced employee deleted.', null));
}

// ---- documents ----

/** POST /api/outsourced-employees/:id/documents — multipart, field `file` + `title`/`expiryDate` */
export async function addDocument(req, res) {
  if (!req.file) throw new ApiError(400, 'Attach a file.');
  const data = await service.addDocument(req.params.id, req.file, req.body, actor(req));
  res.status(201).json(new ApiResponse('Document uploaded.', data));
}

/** DELETE /api/outsourced-employees/:id/documents/:fileId */
export async function removeDocument(req, res) {
  const data = await service.removeDocument(req.params.id, req.params.fileId, actor(req));
  res.json(new ApiResponse('Document removed.', data));
}

/** GET /api/outsourced-employees/:id/documents/:fileId/file — streams the file. */
export async function documentFile(req, res) {
  const fileData = await service.getDocumentFile(req.params.id, req.params.fileId);
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored document is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

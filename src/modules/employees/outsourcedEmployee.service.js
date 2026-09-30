import OutsourcedEmployee from './outsourcedEmployee.model.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { signedDownloadUrl, destroyDocumentFile } from '../../middleware/upload.js';
import { logAudit } from '../audit/audit.service.js';

const audit = (action, employee, actor, meta = {}) =>
  logAudit({
    user: actor.userId,
    action,
    targetType: 'OutsourcedEmployee',
    targetId: employee._id,
    meta: { name: employee.name, ...meta },
    ip: actor.ip,
  });

export async function listOutsourcedEmployees({ search, workerType, limit = 100 }) {
  const filter = {};
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: re }, { iqamaNumber: re }];
  }
  if (workerType) filter.workerType = workerType;

  return OutsourcedEmployee.find(filter)
    .sort({ name: 1 })
    .limit(limit)
    .populate('subcontractor', 'name')
    .lean();
}

export async function getOutsourcedEmployee(id) {
  const employee = await OutsourcedEmployee.findById(id).populate('subcontractor', 'name').lean();
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  return employee;
}

export async function createOutsourcedEmployee(data, actor) {
  const employee = await OutsourcedEmployee.create({
    ...data,
    createdBy: actor.userId,
  });
  await audit('outsourcedEmployee.create', employee, actor);
  return employee.toObject();
}

export async function updateOutsourcedEmployee(id, data, actor) {
  const employee = await OutsourcedEmployee.findByIdAndUpdate(id, data, { new: true, runValidators: true }).populate('subcontractor', 'name').lean();
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  await audit('outsourcedEmployee.update', employee, actor, { fields: Object.keys(data) });
  return employee;
}

export async function deleteOutsourcedEmployee(id, actor) {
  const employee = await OutsourcedEmployee.findByIdAndDelete(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  await audit('outsourcedEmployee.delete', employee, actor);
  return employee;
}

// ---- documents (added 2026-09-30 — see outsourcedEmployee.model.js's own
// doc comment: this field existed since the module was first built with no
// route ever wired to it) ----

export async function addDocument(id, file, { title, expiryDate }, actor) {
  const employee = await OutsourcedEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');

  employee.documents.push({
    title,
    fileName: file.filename,
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    expiryDate: expiryDate ?? null,
    uploadedBy: actor.userId,
    uploadedAt: new Date(),
  });
  await employee.save();
  await audit('outsourcedEmployee.documents.add', employee, actor, { title });
  return (await employee.populate('subcontractor', 'name')).toObject();
}

export async function removeDocument(id, fileId, actor) {
  const employee = await OutsourcedEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');

  const doc = employee.documents.id(fileId);
  if (!doc) throw new ApiError(404, 'Document not found');

  await destroyDocumentFile(doc.fileName, doc.resourceType).catch(() => {});
  employee.documents = employee.documents.filter((d) => d._id.toString() !== fileId);
  await employee.save();
  await audit('outsourcedEmployee.documents.remove', employee, actor, { fileId });
  return (await employee.populate('subcontractor', 'name')).toObject();
}

/** A document's file for whoever can already view the record (route-gated
 *  the same way as every other read on this module). */
export async function getDocumentFile(id, fileId) {
  const employee = await OutsourcedEmployee.findById(id).lean();
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  const doc = (employee.documents ?? []).find((d) => d._id.toString() === fileId);
  if (!doc) throw new ApiError(404, 'Document not found');
  return {
    url: signedDownloadUrl(doc.fileName, doc.resourceType),
    mimeType: doc.mimeType,
    originalName: doc.originalName,
  };
}

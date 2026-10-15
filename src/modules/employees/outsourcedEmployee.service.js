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

// ---- documents ----

const storedFile = (file) => ({
  fileName: file.filename,
  resourceType: 'raw',
  originalName: file.originalname,
  mimeType: file.mimetype,
  size: file.size,
});

const titleOf = ({ type, title }) => (type === 'Other' ? title : type);

/** Record a document: its kind, number, expiry and reminder lead time; the file is optional. */
export async function addDocument(id, file, { type, title, number, expiryDate, reminderDays }, actor) {
  const employee = await OutsourcedEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');

  employee.documents.push({
    type,
    title: titleOf({ type, title }),
    number: number ?? null,
    expiryDate: expiryDate ?? null,
    ...(reminderDays && { reminderDays }),
    ...(file ? storedFile(file) : {}),
    uploadedBy: actor.userId,
    uploadedAt: new Date(),
  });
  await employee.save();
  await audit('outsourcedEmployee.documents.add', employee, actor, { type, title: titleOf({ type, title }) });
  return (await employee.populate('subcontractor', 'name')).toObject();
}

/** Change a document's details, and optionally put a (new) file on it. */
export async function updateDocument(id, fileId, file, body, actor) {
  const employee = await OutsourcedEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  const doc = employee.documents.id(fileId);
  if (!doc) throw new ApiError(404, 'Document not found');

  if (body.type !== undefined) doc.type = body.type;
  if (body.type !== undefined || body.title !== undefined) {
    doc.title = titleOf({ type: doc.type, title: body.title ?? doc.title });
  }
  if (body.number !== undefined) doc.number = body.number;
  if (body.expiryDate !== undefined) doc.expiryDate = body.expiryDate;
  if (body.clearExpiry) doc.expiryDate = null;
  if (body.reminderDays !== undefined) doc.reminderDays = body.reminderDays;
  if (file) {
    if (doc.fileName) await destroyDocumentFile(doc.fileName, doc.resourceType).catch(() => {});
    Object.assign(doc, storedFile(file), { uploadedAt: new Date() });
  }
  await employee.save();
  await audit('outsourcedEmployee.documents.update', employee, actor, { fileId, fields: Object.keys(body) });
  return (await employee.populate('subcontractor', 'name')).toObject();
}

export async function removeDocument(id, fileId, actor) {
  const employee = await OutsourcedEmployee.findById(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');

  const doc = employee.documents.id(fileId);
  if (!doc) throw new ApiError(404, 'Document not found');

  if (doc.fileName) await destroyDocumentFile(doc.fileName, doc.resourceType).catch(() => {});
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
  if (!doc.fileName) throw new ApiError(404, 'No file has been attached to this document yet.');
  return {
    url: signedDownloadUrl(doc.fileName, doc.resourceType),
    mimeType: doc.mimeType,
    originalName: doc.originalName,
  };
}

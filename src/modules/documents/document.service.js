/**
 * Document service — upload, versioning, listing/search, file resolution,
 * and deletion (which also removes files from disk).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import Document from './document.model.js';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import {
  DOCUMENT_RESOURCE_TYPE,
  signedDownloadUrl,
  destroyDocumentFile,
} from '../../middleware/upload.js';
import { logAudit } from '../audit/audit.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';

/** Documents expiring within this many days (or already expired) are "expiring". */
export const EXPIRY_WARNING_DAYS = 30;

/** Refuse to attach a document to an owner that doesn't exist. */
async function assertOwnerExists(ownerType, owner) {
  const Model = ownerType === 'Employee' ? Employee : Client;
  const exists = await Model.exists({ _id: owner });
  if (!exists) throw new ApiError(404, `${ownerType} not found.`);
}

/** Absolute path of a stored file. */
function diskPath(fileName) {
  return path.join(env.uploadDir, fileName);
}

/**
 * Build one embedded version object from a Multer file.
 *
 * `file.filename` is Cloudinary's public_id; `file.path` is a SIGNED delivery
 * URL. We record the public_id and throw the URL away — see the fileName field
 * comment on the model for why storing that URL would be a leak.
 */
function versionFromFile(file, version, userId) {
  return {
    version,
    storage: 'cloudinary',
    fileName: file.filename,
    resourceType: DOCUMENT_RESOURCE_TYPE,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: userId,
    uploadedAt: new Date(),
  };
}

/**
 * Classify a stored version so callers never have to sniff a URL.
 *
 * Three shapes exist in the wild:
 *   - `storage: 'cloudinary'` — current: fileName is a public_id.
 *   - `storage: 'local'` + a plain filename — the original on-disk era.
 *   - `storage: 'local'` + an http(s) URL in fileName — files written during
 *     the brief window when the full delivery URL was stored. These are
 *     PUBLIC (`type: 'upload'`) legacy objects; we can still read and delete
 *     them, but they must be treated as compromised and re-uploaded.
 */
function describeStorage(version) {
  const value = version.fileName ?? '';
  if (version.storage === 'cloudinary') {
    return {
      kind: 'cloudinary',
      publicId: value,
      resourceType: version.resourceType || DOCUMENT_RESOURCE_TYPE,
      deliveryType: 'authenticated',
    };
  }
  if (/^https?:\/\//i.test(value)) {
    // Legacy public URL: <...>/<image|raw>/upload/v<n>/<folder>/<file>.<ext>
    const resourceType = value.includes('/raw/') ? 'raw' : 'image';
    const [folder, file] = value.split('/').slice(-2);
    const publicId = `${folder}/${resourceType === 'raw' ? file : file.split('.')[0]}`;
    return { kind: 'cloudinary', publicId, resourceType, deliveryType: 'upload' };
  }
  return { kind: 'local', diskName: value };
}

/** Create a new document (version 1) from an uploaded file. */
export async function createDocument({ title, category, ownerType, owner, expiryDate, file }, actor) {
  if (!file) throw new ApiError(400, 'A file is required.');
  await assertOwnerExists(ownerType, owner);
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: uploading for a
  // foreign employee had no team-ownership check at all, unlike getDocument/
  // resolveFile below — a Coordinator could attach a document to any
  // employee's record, not just their own team's.
  if (ownerType === 'Employee') await assertEmployeeVisibleToActor(owner, actor);

  const document = await Document.create({
    title,
    category,
    ownerType,
    owner,
    expiryDate: expiryDate ?? null,
    versions: [versionFromFile(file, 1, actor.userId)],
  });

  await logAudit({
    user: actor.userId,
    action: 'document.create',
    targetType: 'Document',
    targetId: document._id,
    meta: { title, category, ownerType },
    ip: actor.ip,
  });
  return document.toObject();
}

/** Append a new version (the uploaded file) to an existing document. */
export async function addVersion(id, file, actor) {
  if (!file) throw new ApiError(400, 'A file is required.');
  const document = await Document.findById(id);
  if (!document) throw new ApiError(404, 'Document not found.');
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: same missing
  // team-ownership check as createDocument above.
  if (document.ownerType === 'Employee') await assertEmployeeVisibleToActor(document.owner, actor);

  const nextVersion = document.versions[document.versions.length - 1].version + 1;
  document.versions.push(versionFromFile(file, nextVersion, actor.userId));
  await document.save();

  await logAudit({
    user: actor.userId,
    action: 'document.version',
    targetType: 'Document',
    targetId: document._id,
    meta: { title: document.title, version: nextVersion },
    ip: actor.ip,
  });
  return document.toObject();
}

/**
 * List/search documents. Filters: ownerType, owner, category, search (title),
 * expiring (within EXPIRY_WARNING_DAYS or past).
 *
 * Coordinator team-scoping (added 2026-09-14, a real QA-audit-found gap):
 * this had NO actor-based scoping at all — a Coordinator could list, view,
 * or download any Employee-owned document, not just their own team's, even
 * though the employee's own profile correctly 403s them. Client-owned
 * documents are left unscoped here — no Client-Coordinator visibility rule
 * was demonstrated broken, and inventing one isn't this fix's job.
 */
export async function listDocuments({ page, limit, ownerType, owner, category, search, expiring }, actor) {
  const conditions = [];
  if (ownerType) conditions.push({ ownerType });
  if (owner) conditions.push({ owner });
  if (category) conditions.push({ category });
  if (search) conditions.push({ title: { $regex: escapeRegex(search), $options: 'i' } });
  if (expiring === 'true') {
    const threshold = new Date(Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);
    conditions.push({ expiryDate: { $ne: null, $lte: threshold } });
  }
  if (actor?.role === 'Coordinator') {
    const teamIds = await Employee.find({ coordinator: actor.userId }).distinct('_id');
    conditions.push({ $or: [{ ownerType: 'Client' }, { ownerType: 'Employee', owner: { $in: teamIds } }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [items, total] = await Promise.all([
    Document.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('owner', 'fullName employeeId companyName')
      .lean(),
    Document.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getDocument(id, actor) {
  const document = await Document.findById(id)
    .populate('owner', 'fullName employeeId companyName')
    .populate('versions.uploadedBy', 'name')
    .lean();
  if (!document) throw new ApiError(404, 'Document not found.');
  if (document.ownerType === 'Employee') {
    await assertEmployeeVisibleToActor(document.owner?._id, actor);
  }
  return document;
}

/**
 * Resolve a stored file so the controller can stream it. Defaults to the
 * current version.
 *
 * Returns either `{ source: 'disk', absolutePath, … }` or
 * `{ source: 'remote', url, … }`. The remote `url` is signed and must be
 * fetched BY THE SERVER — handing it to the client would put the file back
 * outside our authorization checks, which is exactly the bug this replaces.
 */
export async function resolveFile(id, versionNumber, actor) {
  const document = await Document.findById(id).lean();
  if (!document) throw new ApiError(404, 'Document not found.');
  if (document.ownerType === 'Employee') {
    await assertEmployeeVisibleToActor(document.owner, actor);
  }

  const version = versionNumber
    ? document.versions.find((v) => v.version === versionNumber)
    : document.versions[document.versions.length - 1];
  if (!version) throw new ApiError(404, 'That version does not exist.');

  const meta = { mimeType: version.mimeType, originalName: version.originalName };
  const stored = describeStorage(version);

  if (stored.kind === 'cloudinary') {
    // A legacy public object needs its plain URL; an authenticated one needs a
    // signature. signedDownloadUrl() covers both — signing a public asset is
    // harmless, and the delivery type is what actually differs.
    const url =
      stored.deliveryType === 'upload'
        ? version.fileName
        : signedDownloadUrl(stored.publicId, stored.resourceType);
    return { source: 'remote', url, ...meta };
  }

  const absolutePath = diskPath(stored.diskName);
  // Confirm the file is actually on disk before claiming success (legacy local
  // files; on an ephemeral host these may not have survived a redeploy).
  try {
    await fs.access(absolutePath);
  } catch {
    throw new ApiError(410, 'The stored file is missing on the server.');
  }
  return { source: 'disk', absolutePath, ...meta };
}

/**
 * Delete a document and remove ALL its version files from storage.
 *
 * Deletion is best-effort against the DB row — a storage hiccup must not leave
 * an undeletable record in the UI. But it is NOT silent: every file that does
 * not actually go away is counted and written to the audit entry, because
 * "deleted" on a passport scan has to mean deleted, and the previous version
 * of this function reported success while leaving the file public forever.
 */
export async function deleteDocument(id, actor) {
  const document = await Document.findById(id);
  if (!document) throw new ApiError(404, 'Document not found.');
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: deleting had NO
  // team-ownership check at all — a Coordinator could permanently remove a
  // foreign employee's document AND its real stored file, even though
  // reading that same document already correctly 403s.
  if (document.ownerType === 'Employee') await assertEmployeeVisibleToActor(document.owner, actor);

  const failures = [];
  await Promise.all(
    document.versions.map(async (version) => {
      const stored = describeStorage(version);
      try {
        if (stored.kind === 'cloudinary') {
          const result = await destroyDocumentFile(
            stored.publicId,
            stored.resourceType,
            stored.deliveryType
          );
          if (result !== 'ok') failures.push(`v${version.version}: ${result}`);
        } else {
          await fs.unlink(diskPath(stored.diskName));
        }
      } catch (err) {
        // ENOENT means the file was already gone — that is the desired state.
        if (err.code === 'ENOENT') return;
        failures.push(`v${version.version}: ${err.message}`);
      }
    })
  );

  await document.deleteOne();

  if (failures.length > 0) {
    logger.error(
      `[documents] "${document.title}" (${document._id}) removed from the database, but ` +
        `${failures.length} of ${document.versions.length} stored file(s) could NOT be deleted: ` +
        failures.join('; ')
    );
  }

  await logAudit({
    user: actor.userId,
    action: 'document.delete',
    targetType: 'Document',
    targetId: document._id,
    meta: {
      title: document.title,
      versions: document.versions.length,
      ...(failures.length > 0 ? { filesNotDeleted: failures } : {}),
    },
    ip: actor.ip,
  });
}

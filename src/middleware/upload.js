/**
 * File-upload middleware (Multer) → Cloudinary.
 *
 * These files are passports, visas, iqamas, medical records and contracts, so
 * two properties matter more than anything else here:
 *
 * 1. THE BYTES ARE NEVER PUBLIC. Uploads use `type: 'authenticated'`, which
 *    makes the ordinary `res.cloudinary.com/<cloud>/raw/upload/<id>` URL 404.
 *    The only way to read a file is a SIGNED url, minted per request by
 *    `signedDownloadUrl()` and used server-side only — the browser receives
 *    the bytes from our own authenticated endpoint and never sees a
 *    Cloudinary URL. (Before this, every upload sat on a public CDN URL that
 *    outlived the uploader's account entirely.)
 *
 * 2. WE ALWAYS KNOW HOW TO DELETE IT AGAIN. Everything is stored as
 *    `resource_type: 'raw'` — chosen explicitly, never 'auto'. 'auto' lets
 *    Cloudinary pick image-vs-raw per file, but multer-storage-cloudinary does
 *    not report which it picked, and a delete that guesses wrong returns
 *    `{ result: 'not found' }` WITHOUT throwing — so the file silently
 *    survives forever while the app reports success. Picking it ourselves
 *    removes the guess.
 *
 * 'raw' also stores bytes verbatim: no image pipeline, so a slightly malformed
 * PDF is still stored as the document the user actually has, instead of being
 * rejected mid-upload.
 *
 * 3. THE FILE IS WHAT IT CLAIMS TO BE. The declared MIME type is written by the
 *    client and means nothing on its own — HTML labelled as a Word document was
 *    previously accepted and stored. Uploads are now buffered in memory, their
 *    leading bytes checked against the real format signature, and only then
 *    sent to storage.
 *
 * See docs/SECURITY-AUDIT.md (C-1, C-2, H-1, M-1) for the findings this replaces.
 */
import { Readable } from 'node:stream';
import multer from 'multer';
import { cloudinary } from '../config/cloudinary.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/**
 * The declared-MIME allowlist. This is the FIRST gate and the weakest one:
 * `file.mimetype` is just the Content-Type the client wrote into the multipart
 * part, so it is entirely attacker-controlled. It filters honest mistakes, not
 * attackers. `SIGNATURES` below is the gate that actually holds.
 */
const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The storage contract, in one place. Every upload, every signed read and
 * every delete must agree on these three values or files leak (see the header).
 */
const CLOUDINARY_FOLDER = 'crm-documents';
export const DOCUMENT_RESOURCE_TYPE = 'raw';
export const DOCUMENT_DELIVERY_TYPE = 'authenticated';

/* ---------------------------------------------------------------------------
 * Content verification — does the file's FIRST BYTES match what it claims?
 *
 * Every real format begins with a fixed marker. Checking it turns the allowlist
 * from a suggestion into an actual control: an HTML page or a Windows binary
 * renamed and relabelled as a Word document no longer gets stored, because its
 * bytes do not start with a ZIP header.
 *
 * Office formats are containers rather than single formats:
 *   .docx/.xlsx — OOXML, which is a ZIP archive  -> "PK\x03\x04"
 *   .doc/.xls   — legacy OLE2 compound documents -> D0 CF 11 E0 A1 B1 1A E1
 * ------------------------------------------------------------------------- */

const startsWith = (buf, bytes) =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

const isZip = (b) => startsWith(b, [0x50, 0x4b]) && [0x03, 0x05, 0x07].includes(b[2]);
const isOle2 = (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const SIGNATURES = {
  'application/pdf': { label: 'PDF', ok: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  'image/jpeg': { label: 'JPEG image', ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  'image/png': {
    label: 'PNG image',
    ok: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  'image/webp': {
    label: 'WebP image',
    ok: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      b.length >= 12 &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  'application/msword': { label: 'Word document', ok: isOle2 },
  'application/vnd.ms-excel': { label: 'Excel workbook', ok: isOle2 },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    label: 'Word document',
    ok: isZip,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    label: 'Excel workbook',
    ok: isZip,
  },
};

/** null when the bytes match the declared type, otherwise a user-facing reason. */
function verifyContent(file) {
  const rule = SIGNATURES[file.mimetype];
  if (!rule) return 'Unsupported file type.';
  if (!file.buffer?.length) return 'The uploaded file is empty.';
  if (!rule.ok(file.buffer)) {
    logger.warn(
      `[documents] content/type mismatch: "${file.originalname}" declared ${file.mimetype} ` +
        `but does not look like a ${rule.label}`
    );
    return `This file does not appear to be a real ${rule.label}. Re-save it and try again.`;
  }
  return null;
}

/* ------------------------------------------------------------------------- */

/** Push a verified buffer to Cloudinary under the storage contract above. */
function uploadBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_FOLDER,
        resource_type: DOCUMENT_RESOURCE_TYPE,
        type: DOCUMENT_DELIVERY_TYPE,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

/**
 * Turn a Cloudinary failure into our standard envelope.
 *
 * Cloudinary rejects with a plain object, not an Error, so it has no stack and
 * previously fell through to the generic handler as an unhandled 500 — the user
 * saw "Something went wrong" and the logs recorded nothing useful.
 */
function cloudinaryUploadError(err) {
  const status = err?.error?.http_code ?? err?.http_code;
  const detail = err?.error?.message ?? err?.message ?? 'unknown error';
  logger.error(`[documents] Cloudinary upload failed (${status ?? 'no status'}): ${detail}`);
  if (status >= 400 && status < 500) {
    return new ApiError(400, 'That file could not be stored. Please check the file and try again.');
  }
  return new ApiError(502, 'File storage is temporarily unavailable. Please try again shortly.');
}

/**
 * Mint a signed, time-unbounded delivery URL for a stored document.
 *
 * SECURITY: this URL is a bearer capability for the file — anyone holding it
 * can read the bytes. It must NEVER be written to the database, logged, put in
 * an API response, or sent as a redirect. It exists only to be fetched by this
 * server, in-process, during an already-authenticated request.
 */
export function signedDownloadUrl(publicId, resourceType = DOCUMENT_RESOURCE_TYPE) {
  return cloudinary.url(publicId, {
    resource_type: resourceType,
    type: DOCUMENT_DELIVERY_TYPE,
    sign_url: true,
    secure: true,
  });
}

/**
 * Delete a stored file from Cloudinary.
 *
 * `deliveryType` is a parameter because files uploaded before this module was
 * hardened are `type: 'upload'`, not 'authenticated', and destroy() will not
 * find them under the wrong one.
 *
 * Returns Cloudinary's own verdict ('ok' | 'not found' | …) rather than
 * swallowing it: destroy() resolves normally when it deletes NOTHING, so the
 * caller has to inspect the result to know whether the file is really gone.
 */
export async function destroyDocumentFile(
  publicId,
  resourceType = DOCUMENT_RESOURCE_TYPE,
  deliveryType = DOCUMENT_DELIVERY_TYPE
) {
  const { result } = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type: deliveryType,
    invalidate: true, // purge the CDN edge cache too, or it keeps serving
  });
  if (result !== 'ok') {
    logger.warn(
      `[documents] Cloudinary did not delete ${publicId} (${resourceType}/${deliveryType}): ${result}`
    );
  }
  return result;
}

function fileFilter(req, file, cb) {
  if (!ALLOWED_TYPES[file.mimetype]) {
    return cb(new ApiError(400, 'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, Word, Excel.'));
  }
  cb(null, true);
}

/**
 * Multer buffers into MEMORY rather than streaming straight to Cloudinary.
 *
 * That is the whole point: the bytes have to exist here, before storage, or we
 * cannot check that the file is what it claims to be. Streaming direct to
 * Cloudinary meant the first opportunity to look at the content came after it
 * was already stored. Capped at 10 MB, so the memory cost is bounded and small.
 */
const multerUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
}).single('file');

const CHAT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const multerChatUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter(req, file, cb) {
    if (!CHAT_TYPES.has(file.mimetype)) {
      return cb(new ApiError(400, 'Only images (JPG, PNG, WEBP) and PDF files can be sent in chat.'));
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
}).single('file');

const MAX_MOBILISATION_FILES = 10;
const multerUploadMany = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_MOBILISATION_FILES },
}).array('files', MAX_MOBILISATION_FILES);

/**
 * Parse the upload, verify it, then store it. Field name must be `file`.
 *
 * On success `req.file` carries `filename` (the Cloudinary public_id) and the
 * usual multer metadata, matching what the rest of the module already expects.
 * The raw buffer is dropped once stored so it does not sit in memory for the
 * remainder of the request.
 */
export const uploadSingle = singleUploader(multerUpload);

/**
 * Chat attachments: images and PDFs only, same verification and storage as every
 * other upload. Field name `file`.
 */
export const uploadChatAttachment = singleUploader(multerChatUpload);

function singleUploader(parse) {
  return (req, res, next) => storeSingle(parse, req, res, next);
}

function storeSingle(parse, req, res, next) {
  parse(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(400, 'File is too large (maximum 10 MB).'));
        }
        return next(new ApiError(400, `Upload error: ${err.message}`));
      }
      return next(err); // ApiError from fileFilter, or anything unexpected
    }

    // No file on the request: the service layer decides whether that is an
    // error (create requires one), so pass through rather than guessing here.
    if (!req.file) return next();

    const problem = verifyContent(req.file);
    if (problem) return next(new ApiError(400, problem));

    try {
      const result = await uploadBuffer(req.file.buffer);
      req.file.filename = result.public_id;
      req.file.size = result.bytes ?? req.file.size;
    } catch (uploadErr) {
      return next(cloudinaryUploadError(uploadErr));
    } finally {
      delete req.file.buffer;
    }

    next();
  });
}

/**
 * Same contract as uploadSingle, for multiple files in one request under
 * field name `files` (used by mobilisation documents — a contract, an ID
 * copy, etc. attached together). Field name must be `files`.
 *
 * On success `req.files` is an array where each entry carries `filename`
 * (the Cloudinary public_id), matching uploadSingle's single-file shape.
 */
export function uploadMultiple(req, res, next) {
  multerUploadMany(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(400, 'A file is too large (maximum 10 MB).'));
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(new ApiError(400, `Too many files (maximum ${MAX_MOBILISATION_FILES}).`));
        }
        return next(new ApiError(400, `Upload error: ${err.message}`));
      }
      return next(err);
    }

    if (!req.files?.length) return next();

    for (const file of req.files) {
      const problem = verifyContent(file);
      if (problem) return next(new ApiError(400, `${file.originalname}: ${problem}`));
    }

    try {
      await Promise.all(
        req.files.map(async (file) => {
          const result = await uploadBuffer(file.buffer);
          file.filename = result.public_id;
          file.size = result.bytes ?? file.size;
        })
      );
    } catch (uploadErr) {
      return next(cloudinaryUploadError(uploadErr));
    } finally {
      for (const file of req.files) delete file.buffer;
    }

    next();
  });
}

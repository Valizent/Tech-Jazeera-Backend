import multer from 'multer';
import ApiError from './ApiError.js';

/** The 3 image types every image-upload pipeline in this app accepts
 *  (avatar, company logo, NFC media) — a face crop, a logo, and a card
 *  photo all have the same trust/format requirements. */
export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Shared multer `fileFilter` — rejects anything outside IMAGE_MIME_TYPES
 *  with the same message every image pipeline already used. */
export function imageFileFilter(req, file, cb) {
  if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
    return cb(new ApiError(400, 'Upload a PNG, JPG, or WEBP image.'));
  }
  cb(null, true);
}

/** Wraps a configured multer middleware (already `.single(fieldName)`) so
 *  its errors become our standard ApiError instead of multer's own shape —
 *  every image-upload endpoint (avatar/logo/NFC media) used the identical
 *  wrapper body. `maxSizeLabel` is just the human-readable limit for the
 *  file-too-large message (e.g. "2 MB") — the actual limit is still
 *  enforced by the multer config itself (`limits.fileSize`), not here. */
export function wrapImageUpload(upload, maxSizeLabel) {
  return function handleImageUpload(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, `Image is too large (maximum ${maxSizeLabel}).`));
        return next(new ApiError(400, `Upload error: ${err.message}`));
      }
      return next(err);
    });
  };
}

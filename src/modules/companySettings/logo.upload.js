/**
 * Company logo upload — a public Cloudinary image, same trust category as a
 * profile avatar (see auth/avatar.upload.js, which this mirrors) rather than
 * the signed-URL documents pipeline.
 *
 * Always stored as PNG regardless of what the admin uploads (Cloudinary's
 * `format` param transcodes on upload): the Timesheet Processor embeds this
 * image into a real .xlsx via exceljs, which only accepts jpeg/png/gif —
 * forcing one known format here means the export code never has to branch
 * on what got uploaded. `crop: 'limit'` only shrinks an oversized image and
 * never crops it — a logo's aspect ratio is part of the logo, unlike an
 * avatar's deliberate face-crop square.
 */
import multer from 'multer';
import { cloudinary, CloudinaryStorage } from '../../config/cloudinary.js';
import logger from '../../config/logger.js';
import { imageFileFilter, wrapImageUpload } from '../../utils/imageUpload.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — a logo, not a photo library

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'company-logo',
    format: 'png',
    transformation: [{ width: 800, crop: 'limit' }],
  },
});

const upload = multer({ storage, fileFilter: imageFileFilter, limits: { fileSize: MAX_BYTES } }).single('logo');

/** Field name: `logo`. */
export const uploadLogoImage = wrapImageUpload(upload, '2 MB');

/** Best-effort delete of the stored logo (on replace/remove) — never blocks the request on failure. */
export async function deleteLogoMedia(url) {
  if (!url) return;
  try {
    const parts = url.split('/');
    const folderAndFile = parts.slice(-2).join('/'); // "company-logo/xyz.png"
    const publicId = folderAndFile.split('.')[0]; // "company-logo/xyz"
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    logger.error(`[companySettings] Failed to delete logo from Cloudinary: ${url} — ${err.message}`);
  }
}

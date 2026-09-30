import { Router } from 'express';
import * as controller from './outsourcedEmployee.controller.js';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../config/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import {
  createOutsourcedEmployeeSchema,
  updateOutsourcedEmployeeSchema,
  outsourcedEmployeeIdParamSchema,
  outsourcedEmployeeDocumentBodySchema,
  outsourcedEmployeeDocumentParamSchema,
} from './outsourcedEmployee.validation.js';

const router = Router();

router.use(requireAuth);

const canWrite = requireSectionAccess('employeeCreate', 'write');

// Fixed 2026-09-30: 'employees' is not a real Section Access key (see
// sectionAccess.model.js's SECTION_KEYS) — canAccessSection silently found
// no grants for it and fell through to Admin-only forever, while the
// client's own route guard (router.jsx) already correctly gates this whole
// page on 'employeeCreate', the real key the rest of the Employees module
// uses. Aligned to match.
router.get('/', asyncHandler(controller.list));
router.post('/', canWrite, validate({ body: createOutsourcedEmployeeSchema }), asyncHandler(controller.create));
router.get('/:id', validate({ params: outsourcedEmployeeIdParamSchema }), asyncHandler(controller.get));
router.patch(
  '/:id',
  canWrite,
  validate({ params: outsourcedEmployeeIdParamSchema, body: updateOutsourcedEmployeeSchema }),
  asyncHandler(controller.update)
);
router.delete('/:id', canWrite, validate({ params: outsourcedEmployeeIdParamSchema }), asyncHandler(controller.remove));

// ---- documents (added 2026-09-30 — see outsourcedEmployee.model.js's own
// doc comment: this field existed since the module was first built with no
// route ever wired to it). Upload flow order matches document.routes.js's
// own: uploadSingle (Multer streams the file to Cloudinary) → validate the
// multipart text fields → controller; the trailing error handler below
// deletes the just-stored file if anything after that fails, so a rejected
// upload never leaves an orphan on Cloudinary.
router.post(
  '/:id/documents',
  canWrite,
  validate({ params: outsourcedEmployeeIdParamSchema }),
  uploadSingle,
  validate({ body: outsourcedEmployeeDocumentBodySchema }),
  asyncHandler(controller.addDocument)
);
router.delete(
  '/:id/documents/:fileId',
  canWrite,
  validate({ params: outsourcedEmployeeDocumentParamSchema }),
  asyncHandler(controller.removeDocument)
);
router.get(
  '/:id/documents/:fileId/file',
  validate({ params: outsourcedEmployeeDocumentParamSchema }),
  asyncHandler(controller.documentFile)
);

router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[outsourcedEmployees] orphaned upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

/**
 * "Me" routes — the ESS portal's entire API surface (P2-M2). Worker and
 * Staff logins only: everyone else uses the full admin modules instead.
 * Every route resolves data against req.user.employee, never a
 * client-supplied employee id.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRoles } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingle, destroyDocumentFile } from '../../middleware/upload.js';
import Employee from '../employees/employee.model.js';
import { documentIdParamSchema, fileQuerySchema } from '../documents/document.validation.js';
import { updateMyProfileSchema } from './me.validation.js';
import {
  submitLeaveRequestSchema,
  listMyLeaveRequestsSchema,
  leaveRequestIdParamSchema,
} from '../leave/leave.validation.js';
import { selfMarkSchema, listMyAttendanceSchema } from '../attendance/attendance.validation.js';
import { submitAdvanceSchema, listMyAdvancesSchema, advanceIdParamSchema } from '../financialRequests/advance.validation.js';
import {
  submitReimbursementSchema,
  listMyReimbursementsSchema,
  reimbursementIdParamSchema,
} from '../financialRequests/reimbursement.validation.js';
import {
  submitExitReentrySchema,
  listMyExitReentrySchema,
  exitReentryIdParamSchema,
} from '../exitDocuments/exitReentry.validation.js';
import {
  submitCertificateSchema,
  listMyCertificatesSchema,
  certificateIdParamSchema,
} from '../exitDocuments/certificate.validation.js';
import { submitTimesheetSchema, listMyTimesheetsSchema } from '../timesheets/timesheet.validation.js';
import { payrollRunIdParamSchema } from '../payroll/payroll.validation.js';
import { z } from 'zod';
import * as meController from './me.controller.js';

// payroll.validation.js's param schema uses {id}, but this route's param is
// named :runId — a tiny local alias rather than a shared schema mismatch.
const payslipRunIdParamSchema = z.object({ runId: payrollRunIdParamSchema.shape.id });

const router = Router();

router.use(requireAuth);
router.use(requireRoles('Worker', 'Staff'));
// Milestone 4: the ESS portal is now Own-type-only — an Outsourced/
// Subcontracted employee's login (old or newly attempted) 403s at every
// single route below, in one place, rather than needing a per-route check.
// No `req.user.employee` at all falls through unmolested (myEmployeeId() in
// the controller is still the real 404 for that separate, pre-existing edge
// case), same as an employee record that no longer resolves.
router.use(
  asyncHandler(async (req, res, next) => {
    if (!req.user.employee) return next();
    const employee = await Employee.findById(req.user.employee).select('type').lean();
    if (employee && employee.type !== 'Own') {
      throw new ApiError(403, 'This portal is only available to internal staff.');
    }
    next();
  })
);

router.get('/', asyncHandler(meController.getProfile));
router.patch('/', validate({ body: updateMyProfileSchema }), asyncHandler(meController.updateProfile));
router.get('/documents', asyncHandler(meController.listDocuments));
router.get(
  '/documents/:id/file',
  validate({ params: documentIdParamSchema, query: fileQuerySchema }),
  asyncHandler(meController.documentFile)
);
router.get('/leave', validate({ query: listMyLeaveRequestsSchema }), asyncHandler(meController.listLeave));
router.post(
  '/leave',
  uploadSingle,
  validate({ body: submitLeaveRequestSchema }),
  asyncHandler(meController.submitLeave)
);
router.get(
  '/leave/:id/attachment',
  validate({ params: leaveRequestIdParamSchema }),
  asyncHandler(meController.leaveAttachment)
);
router.patch(
  '/leave/:id/cancel',
  validate({ params: leaveRequestIdParamSchema }),
  asyncHandler(meController.cancelLeave)
);

router.post(
  '/attendance/punch',
  validate({ body: selfMarkSchema }),
  asyncHandler(meController.punch)
);
router.get(
  '/attendance',
  validate({ query: listMyAttendanceSchema }),
  asyncHandler(meController.listAttendance)
);

router.get('/advances', validate({ query: listMyAdvancesSchema }), asyncHandler(meController.listAdvances));
router.post('/advances', validate({ body: submitAdvanceSchema }), asyncHandler(meController.submitAdvance));
router.patch(
  '/advances/:id/cancel',
  validate({ params: advanceIdParamSchema }),
  asyncHandler(meController.cancelAdvance)
);

router.get(
  '/reimbursements',
  validate({ query: listMyReimbursementsSchema }),
  asyncHandler(meController.listReimbursements)
);
router.post(
  '/reimbursements',
  uploadSingle,
  validate({ body: submitReimbursementSchema }),
  asyncHandler(meController.submitReimbursement)
);
router.get(
  '/reimbursements/:id/receipt',
  validate({ params: reimbursementIdParamSchema }),
  asyncHandler(meController.reimbursementReceipt)
);
router.patch(
  '/reimbursements/:id/cancel',
  validate({ params: reimbursementIdParamSchema }),
  asyncHandler(meController.cancelReimbursement)
);

router.get(
  '/exit-reentry',
  validate({ query: listMyExitReentrySchema }),
  asyncHandler(meController.listExitReentry)
);
router.post(
  '/exit-reentry',
  validate({ body: submitExitReentrySchema }),
  asyncHandler(meController.submitExitReentry)
);
router.patch(
  '/exit-reentry/:id/cancel',
  validate({ params: exitReentryIdParamSchema }),
  asyncHandler(meController.cancelExitReentry)
);

router.get(
  '/certificates',
  validate({ query: listMyCertificatesSchema }),
  asyncHandler(meController.listCertificates)
);
router.post(
  '/certificates',
  validate({ body: submitCertificateSchema }),
  asyncHandler(meController.submitCertificate)
);
router.get(
  '/certificates/:id/pdf',
  validate({ params: certificateIdParamSchema }),
  asyncHandler(meController.certificatePdf)
);
router.patch(
  '/certificates/:id/cancel',
  validate({ params: certificateIdParamSchema }),
  asyncHandler(meController.cancelCertificate)
);

router.get('/assets', asyncHandler(meController.listAssets));

router.get(
  '/timesheets',
  validate({ query: listMyTimesheetsSchema }),
  asyncHandler(meController.listTimesheets)
);
router.post(
  '/timesheets',
  validate({ body: submitTimesheetSchema }),
  asyncHandler(meController.submitTimesheet)
);

router.get('/payslips', asyncHandler(meController.listPayslips));
router.get(
  '/payslips/:runId/pdf',
  validate({ params: payslipRunIdParamSchema }),
  asyncHandler(meController.payslipPdf)
);

/** Same orphaned-upload cleanup as document.routes.js — the leave and
 *  reimbursement POSTs above are the only routes that set req.file on
 *  this router. */
router.use((err, req, res, next) => {
  if (req.file?.filename) {
    destroyDocumentFile(req.file.filename).catch((cleanupErr) =>
      logger.error(`[me] orphaned receipt upload ${req.file.filename}: ${cleanupErr.message}`)
    );
  }
  next(err);
});

export default router;

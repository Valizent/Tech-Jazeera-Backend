/**
 * NFC admin routes — the whole platform behind Section Access key 'nfc',
 * default [] (nobody but Admin, same as before), both tiers starting
 * identical (Read = Write on day one; an Admin can since let someone view
 * companies/cards/batches without letting them create/edit/assign/delete).
 * Separate from the public tap routes (nfc.public.routes.js), which are
 * unauthenticated.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSectionAccess } from '../sectionAccess/sectionAccess.middleware.js';
import { validate } from '../../middleware/validate.js';
import {
  createCompanySchema,
  updateCompanySchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  generateBatchSchema,
  updateCardSchema,
  assignCardSchema,
  assignCardToCompanySchema,
  listCardsSchema,
  listCompaniesSchema,
  idParamSchema,
  analyticsQuerySchema,
} from './nfc.validation.js';
import { uploadNfcImage } from './nfc.upload.js';
import * as nfc from './nfc.controller.js';

const router = Router();
router.use(requireAuth);

const canRead = requireSectionAccess('nfc', 'read');
const canWrite = requireSectionAccess('nfc', 'write');

// Analytics (see nfc.analytics.service.js). Mounted before the resource routes
// so /analytics is never mistaken for an id.
router.get('/analytics', canRead, validate({ query: analyticsQuerySchema }), asyncHandler(nfc.overviewAnalytics));
router.get('/cards/:id/analytics', canRead, validate({ params: idParamSchema, query: analyticsQuerySchema }), asyncHandler(nfc.cardAnalytics));
router.get('/companies/:id/analytics', canRead, validate({ params: idParamSchema, query: analyticsQuerySchema }), asyncHandler(nfc.companyAnalytics));

// Companies
router.get('/companies', canRead, validate({ query: listCompaniesSchema }), asyncHandler(nfc.listCompanies));
router.post('/companies', canWrite, validate({ body: createCompanySchema }), asyncHandler(nfc.createCompany));
router.get('/companies/:id', canRead, validate({ params: idParamSchema }), asyncHandler(nfc.getCompany));
router.patch('/companies/:id', canWrite, validate({ params: idParamSchema, body: updateCompanySchema }), asyncHandler(nfc.updateCompany));
router.delete('/companies/:id', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.deleteCompany));
router.post('/companies/:id/logo', canWrite, validate({ params: idParamSchema }), uploadNfcImage, asyncHandler(nfc.uploadCompanyLogo));
router.delete('/companies/:id/logo', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.removeCompanyLogo));

// People
router.post('/employees', canWrite, validate({ body: createEmployeeSchema }), asyncHandler(nfc.createEmployee));
router.patch('/employees/:id', canWrite, validate({ params: idParamSchema, body: updateEmployeeSchema }), asyncHandler(nfc.updateEmployee));
router.delete('/employees/:id', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.deleteEmployee));
router.post('/employees/:id/photo', canWrite, validate({ params: idParamSchema }), uploadNfcImage, asyncHandler(nfc.uploadEmployeePhoto));
router.delete('/employees/:id/photo', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.removeEmployeePhoto));

// Batches
router.post('/batches', canWrite, validate({ body: generateBatchSchema }), asyncHandler(nfc.generateBatch));
router.get('/batches', canRead, asyncHandler(nfc.listBatches));
router.get('/batches/:id/cards.csv', canRead, validate({ params: idParamSchema }), asyncHandler(nfc.batchCsv));

// Cards
router.get('/cards', canRead, validate({ query: listCardsSchema }), asyncHandler(nfc.listCards));
router.get('/cards/:id', canRead, validate({ params: idParamSchema }), asyncHandler(nfc.getCard));
router.get('/cards/:id/qr.png', canRead, validate({ params: idParamSchema }), asyncHandler(nfc.cardQr));
router.patch('/cards/:id', canWrite, validate({ params: idParamSchema, body: updateCardSchema }), asyncHandler(nfc.updateCard));
router.delete('/cards/:id', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.deleteCard));
router.post('/cards/:id/assign', canWrite, validate({ params: idParamSchema, body: assignCardSchema }), asyncHandler(nfc.assignCard));
router.post('/cards/:id/assign-company', canWrite, validate({ params: idParamSchema, body: assignCardToCompanySchema }), asyncHandler(nfc.assignCardToCompany));
router.post('/cards/:id/unassign', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.unassignCard));
router.post('/cards/:id/lost', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.markLost));
router.post('/cards/:id/return', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.markReturned));
router.post('/cards/:id/disable', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.disableCard));
router.post('/cards/:id/rotate', canWrite, validate({ params: idParamSchema }), asyncHandler(nfc.rotateToken));

export default router;

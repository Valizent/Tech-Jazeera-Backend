/**
 * Credit note controller — HTTP translation. The PDF endpoint streams a
 * file, same pattern as the invoice PDF.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as creditNoteService from './creditNote.service.js';
import { buildCreditNotePdf } from './creditNote.pdf.js';
import { getLetterheadData } from '../companySettings/companySettings.service.js';

const actor = (req) => ({ userId: req.user.id, ip: req.ip });

export async function create(req, res) {
  const creditNote = await creditNoteService.createCreditNote(req.body, actor(req));
  res.status(201).json(new ApiResponse('Credit note issued.', creditNote));
}

export async function list(req, res) {
  const data = await creditNoteService.listCreditNotes(req.query);
  res.json(new ApiResponse('Credit notes.', data));
}

export async function get(req, res) {
  const creditNote = await creditNoteService.getCreditNote(req.params.id);
  res.json(new ApiResponse('Credit note.', creditNote));
}

export async function pdf(req, res) {
  const creditNote = await creditNoteService.getCreditNote(req.params.id);
  const { company, logo } = await getLetterheadData();
  const buffer = await buildCreditNotePdf(creditNote, company, logo);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${creditNote.creditNoteNumber}.pdf"`);
  res.send(buffer);
}

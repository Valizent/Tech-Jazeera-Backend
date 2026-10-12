/**
 * Zod schemas for the subcontractor-transfer endpoints (2026-10-12).
 */
import { z } from 'zod';
import { TRANSFER_STATUSES } from './subcontractorTransfer.model.js';

const emptyToUndef = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

export const listTransfersSchema = z.object({
  status: z.preprocess(emptyToUndef, z.enum(TRANSFER_STATUSES).optional()),
});

export const transferIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid transfer id.'),
});

/** Rejecting needs a reason: it goes back to the coordinators. */
export const decideTransferSchema = z
  .object({
    decision: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
    decisionNote: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'Rejected' && !data.decisionNote) {
      ctx.addIssue({ code: 'custom', path: ['decisionNote'], message: 'Say why the transfer is rejected.' });
    }
  });

/**
 * Zod schemas for mobilisation endpoints — Section 1 create/update, joint-
 * coordinator invite, Section 2 commercial-details, decide, and document
 * category. Same conventions as employees/clients — empty strings from HTML
 * forms become undefined; numeric/boolean fields left unset here fall
 * through to the model's own Mongoose defaults (see employee.validation.js's
 * "No .default() here on purpose" note — the same reasoning applies to
 * `mobilisationFields.partial()` below).
 */
import { z } from 'zod';
import { REJECTION_TARGETS } from './mobilisation.model.js';

const emptyToUndef = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const id = (label) => z.string().regex(/^[a-f0-9]{24}$/i, `Invalid ${label} id.`);
const optionalNonNegNumber = z.preprocess(emptyToUndef, z.coerce.number().min(0).optional());
const requiredNonNegNumber = (message) => z.coerce.number({ error: message }).min(0, 'Cannot be negative.');
const optionalDate = z.preprocess(emptyToUndef, z.coerce.date().optional());

// Saudi Iqama numbers are exactly 10 digits. Only meaningful for a
// SupplierEmployee/Freelancer mobilisation (Employee-type gets this from
// the linked Employee's own record instead — unvalidated there, since that
// snapshot isn't user-typed here).
const iqamaRegex = /^\d{10}$/;
const optionalIqama = z.preprocess(
  emptyToUndef,
  z.string().trim().regex(iqamaRegex, 'Iqama number must be exactly 10 digits.').optional()
);

// Saudi mobile only (this company operates in Saudi Arabia) — local
// 05XXXXXXXX (10 digits) or international +9665XXXXXXXX/9665XXXXXXXX (966 +
// 9 digits starting with 5). Scoped to Mobilisation's own phone field only —
// Employee's phone regex is deliberately looser (covers non-Saudi contacts).
const saudiPhoneRegex = /^(?:\+?9665\d{8}|05\d{8})$/;
// '+966' alone is the form's own pre-filled placeholder (see
// mobilisations.schema.js's emptyMobilisationForm), not a value someone
// actually typed — treat it the same as empty, or every Own Employee
// mobilisation (whose phone field isn't even shown — the real number
// lives on their Employee record) fails validation on a placeholder that
// was never really "filled in". Bug found 2026-09-12: this silently
// blocked every Own Employee Draft save with no visible error, since the
// errored field wasn't rendered for that worker type.
const phoneToUndef = (value) => {
  const cleaned = emptyToUndef(value);
  return cleaned === '+966' ? undefined : cleaned;
};
const optionalSaudiPhone = z.preprocess(
  phoneToUndef,
  z
    .string()
    .trim()
    .regex(saudiPhoneRegex, 'Enter a valid Saudi mobile number (e.g. 05XXXXXXXX or +9665XXXXXXXX).')
    .optional()
);

const workerType = z.enum(['Employee', 'SupplierEmployee', 'Freelancer']);

const mobilisationFields = {
  workerType,
  worker: z.preprocess(emptyToUndef, id('worker').optional()),
  // Free-typed only for SupplierEmployee/Freelancer — required by
  // withWorkerTypeRefine below, not here, since Employee-type mobilisations
  // get these from the snapshot instead.
  workerName: optionalStr(150),
  iqamaNumber: optionalIqama,
  nationality: optionalStr(80),
  phone: optionalSaudiPhone,
  jobTitle: z.string().trim().min(1, 'Job title is required.').max(150),
  // Both moved into Worker & Job (2026-09-13, the user's own ask) — the
  // coordinator/whoever creates the mobilisation sets the target hours AND
  // the OT client rate/commission up front now, instead of the OT rate
  // half waiting on the current-step reviewer's later Section 2 pass (see
  // commercialDetailsSchema below, which no longer carries these two).
  requiredTimesheetHours: optionalNonNegNumber,
  otClientRate: optionalNonNegNumber,
  otClientCommission: optionalNonNegNumber,

  client: id('client'),
  site: optionalStr(150),
  // Required (2026-09-13, the user's own ask) — every mobilisation needs a
  // real client rate from the start; every other Section 1 commercial field
  // here stays optional (fta/allowance/commission can genuinely be zero or
  // unknown yet, this one can't).
  clientRate: requiredNonNegNumber('Client rate is required.'),
  clientCommission: optionalNonNegNumber,
  fta: optionalNonNegNumber,
  allowance: optionalNonNegNumber,

  subcontractor: z.preprocess(emptyToUndef, id('subcontractor').optional()),
  subcontractorRate: optionalNonNegNumber,
  subcontractorCommission: optionalNonNegNumber,
  // Moved alongside subcontractorRate/subcontractorCommission above, same
  // reasoning as otClientRate/otClientCommission — SupplierEmployee only,
  // silently unused by computeProfitFields for any other workerType.
  otSubcontractorRate: optionalNonNegNumber,
  otSubcontractorCommission: optionalNonNegNumber,

  mobilisationDate: z.coerce.date({ error: 'Mobilisation date is required.' }),
  checkoutDate: optionalDate,

  remark: optionalStr(1000),

  // Create-only — an Office Secretary creating this "for" a Coordinator
  // who's busy must say which one. Ignored by updateMobilisation (nothing
  // reads it there); required by createMobilisation only when the caller is
  // Office Secretary — see mobilisation.service.js's createMobilisation.
  onBehalfOf: z.preprocess(emptyToUndef, id('user').optional()),
};
// NOTE: hasSubcontractor, profitPerHour/profitPerMonth, and every ot* field
// are deliberately absent from this schema — hasSubcontractor is derived
// server-side from workerType, the rest are either server-computed or only
// ever set via commercialDetailsSchema (the current-step reviewer's form).
// Any of these sent by a client here is silently dropped, never applied.

/** workerType drives which identity fields are actually required: an
 *  Employee mobilisation needs a real `worker` id (its name/Iqama/etc. come
 *  from the snapshot); a SupplierEmployee/Freelancer one has no Employee
 *  record at all, so `workerName` must be typed directly. A subcontractor
 *  must be selected only for SupplierEmployee — Freelancer gets no
 *  subcontractor-side fields at all. */
function withWorkerTypeRefine(schema) {
  return schema.superRefine((data, ctx) => {
    if (data.workerType === 'Employee' && !data.worker) {
      ctx.addIssue({ code: 'custom', path: ['worker'], message: 'Select a worker.' });
    }
    if (data.workerType && data.workerType !== 'Employee' && !data.workerName) {
      ctx.addIssue({ code: 'custom', path: ['workerName'], message: 'Worker name is required.' });
    }
    if (data.workerType === 'SupplierEmployee' && !data.subcontractor) {
      ctx.addIssue({ code: 'custom', path: ['subcontractor'], message: 'Select a subcontractor.' });
    }
  });
}

export const createMobilisationSchema = withWorkerTypeRefine(z.object(mobilisationFields));

/** PATCH: any subset of the same fields — only while Draft (enforced in the
 *  service). `client` stays required even on an edit; an in-progress Draft
 *  always names a real client, there's no "half-set" state. `workerType`
 *  defaults to undefined here, so withWorkerTypeRefine's checks only fire
 *  when the caller is actually changing worker identity — the service
 *  falls back to the existing document's workerType otherwise. */
export const updateMobilisationSchema = withWorkerTypeRefine(z.object(mobilisationFields).partial());

export const listMobilisationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(emptyToUndef, z.enum(['Draft', 'PendingReview', 'Approved', 'Rejected', 'Completed']).optional()),
  client: z.preprocess(emptyToUndef, id('client').optional()),
  worker: z.preprocess(emptyToUndef, id('worker').optional()),
  search: optionalStr(100),
  sortBy: z.enum(['mobilisationDate', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const mobilisationIdParamSchema = z.object({
  id: id('mobilisation'),
});

/** Same filters as listMobilisationsSchema, minus pagination — an export
 *  fetches every matching record at once (see mobilisation.service.js's
 *  exportMobilisations / EXPORT_MAX_ROWS). */
export const exportMobilisationsSchema = z.object({
  status: z.preprocess(emptyToUndef, z.enum(['Draft', 'PendingReview', 'Approved', 'Rejected', 'Completed']).optional()),
  client: z.preprocess(emptyToUndef, id('client').optional()),
  worker: z.preprocess(emptyToUndef, id('worker').optional()),
  search: optionalStr(100),
  sortBy: z.enum(['mobilisationDate', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** GET /mobilisations/suggestions?field=... — `site` only now: worker
 *  identity (name/Iqama) is recognized by the Iqama lookup instead (see
 *  lookupWorkerByIqama), and nationality always used the CountrySelect
 *  picker, never this. */
export const mobilisationSuggestionQuerySchema = z.object({
  field: z.enum(['site']),
});

/** GET /mobilisations/lookup-by-iqama?iqamaNumber=... — a SupplierEmployee/
 *  Freelancer worker has no Employee record, so this is how "he's been
 *  mobilised before" is recognized: full 10-digit Iqama only, no partial
 *  lookups. */
export const mobilisationIqamaLookupQuerySchema = z.object({
  iqamaNumber: z.string().trim().regex(iqamaRegex, 'Iqama number must be exactly 10 digits.'),
});

export const mobilisationCoordinatorParamSchema = z.object({
  id: id('mobilisation'),
  userId: id('user'),
});

export const addCoordinatorSchema = z.object({
  user: id('user'),
});

/** Section 2 — filled by whoever holds the CURRENT approval step (Office
 *  Secretary, then Marketing Manager, once configured), during review.
 *  Every field is optional individually: a reviewer fills in what they have
 *  as it arrives — the client side today, the subcontractor side once that
 *  quote arrives. No actual-hours field here at all (2026-09-12) — a real
 *  worker isn't placed yet at this stage, so there's no timesheet to enter;
 *  that now lives entirely on the Deployment this mobilisation produces
 *  once Approved (see deployment.validation.js's addMonthlyHoursSchema).
 *  No OT rate fields here either as of 2026-09-13 — the user's own ask
 *  moved that responsibility to Section 1 (`mobilisationFields` above),
 *  filled by the coordinator up front instead of the reviewer during
 *  review; this schema is now purely the client/sub quotation-PO paper
 *  trail plus the reviewer's own remark. */
export const commercialDetailsSchema = z.object({
  clientQuotation: optionalStr(100),
  clientQuotationDate: optionalDate,
  clientPO: optionalStr(100),
  clientPODate: optionalDate,
  subQuotation: optionalStr(100),
  subQuotationDate: optionalDate,
  subPO: optionalStr(100),
  subPODate: optionalDate,
  remark: optionalStr(1000),
});

/** Rejecting requires a note (so whoever it's sent back to knows what to
 *  fix) AND a rejectionTarget (who it's sent back to — Coordinator/Office
 *  Secretary/Both, see mobilisation.service.js's rejectMobilisation);
 *  approving needs neither — same note rule as decideClientSchema. */
export const decideMobilisationSchema = z
  .object({
    status: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
    decisionNote: optionalStr(500),
    rejectionTarget: z.enum(REJECTION_TARGETS).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === 'Rejected' && !data.decisionNote) {
      ctx.addIssue({ code: 'custom', path: ['decisionNote'], message: 'Explain what needs fixing before rejecting.' });
    }
    if (data.status === 'Rejected' && !data.rejectionTarget) {
      ctx.addIssue({ code: 'custom', path: ['rejectionTarget'], message: 'Choose who this should go back to.' });
    }
  });

export const mobilisationDocumentCategorySchema = z.object({
  category: z.enum(['Contract', 'IDCopy', 'Other'], { error: 'Choose a document category.' }),
});

export const mobilisationDocumentParamSchema = z.object({
  id: id('mobilisation'),
  fileId: id('document'),
});

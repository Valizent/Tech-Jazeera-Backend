/**
 * Zod schemas for client endpoints — the write gate for all client data.
 * Same conventions as employees: empty strings from HTML forms become
 * undefined, transforms double as sanitization.
 */
import { z } from 'zod';
import { CLIENT_STATUSES, CLIENT_APPROVAL_STATUSES } from './client.model.js';

const emptyToUndef = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalStr = (max) => z.preprocess(emptyToUndef, z.string().trim().max(max).optional());
const optionalPhone = z.preprocess(
  emptyToUndef,
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 -]{5,18}$/, 'Enter a valid phone number.')
    .optional()
);

/** One site. Name is the key field and is required; the rest are optional. */
const siteSchema = z.object({
  name: z.string().trim().min(1, 'Site name is required.').max(100),
  city: optionalStr(60),
  address: optionalStr(200),
});

export const createClientSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required.').max(150),
  contactPerson: optionalStr(100),
  phone: optionalPhone,
  email: z.preprocess(
    (v) => (typeof v === 'string' ? emptyToUndef(v.trim().toLowerCase()) : v),
    z.email('Enter a valid email address.').optional()
  ),
  address: optionalStr(300),
  // KSA identifiers have fixed lengths; validate the shape when provided so
  // bad data can't slip in, but keep them optional (not every record has one).
  vatNumber: z.preprocess(
    emptyToUndef,
    z.string().trim().regex(/^\d{15}$/, 'Saudi VAT number is 15 digits.').optional()
  ),
  crNumber: z.preprocess(
    emptyToUndef,
    z.string().trim().regex(/^\d{10}$/, 'Commercial Registration is 10 digits.').optional()
  ),
  industry: optionalStr(80),
  sites: z.array(siteSchema).max(50).optional(),
  status: z.enum(CLIENT_STATUSES).default('Active'),
  notes: optionalStr(2000),
});

/** PATCH: any subset of the same fields, same rules. `status` is explicitly
 *  overridden to drop `.default('Active')` (fixed 2026-09-14, a real
 *  QA-audit-found gap — same bug class as employee.validation.js's own
 *  `updateEmployeeSchema`): `.partial()` only makes a field OPTIONAL, it
 *  doesn't strip the field's `.default()`, so omitting `status` from a PATCH
 *  body still resolved it to 'Active' and silently reactivated an Inactive
 *  client on any unrelated field edit. */
export const updateClientSchema = createClientSchema.partial().extend({
  status: z.enum(CLIENT_STATUSES).optional(),
});

export const listClientsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: optionalStr(100),
  status: z.preprocess(emptyToUndef, z.enum(CLIENT_STATUSES).optional()),
  // Distinct from `status` — see client.model.js. Deployment/quotation client
  // pickers pass 'Approved'; the Clients list and the Coordinator Activity
  // page leave it unset to show every approval state.
  approvalStatus: z.preprocess(emptyToUndef, z.enum(CLIENT_APPROVAL_STATUSES).optional()),
  // 'Coordinator' → only clients created by a Coordinator account. Powers the
  // Coordinator Activity page.
  createdByRole: z.preprocess(emptyToUndef, z.enum(['Coordinator']).optional()),
  industry: optionalStr(80),
  sortBy: z.enum(['companyName', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const clientIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid client id.'),
});

/**
 * Body for deciding a Pending client (Admin, or the submitting Coordinator's
 * own manager — enforced in the service). Rejecting requires a note so the
 * Coordinator knows what to fix before resubmitting; approving does not.
 */
export const decideClientSchema = z
  .object({
    status: z.enum(['Approved', 'Rejected'], { error: 'Decision must be Approved or Rejected.' }),
    decisionNote: optionalStr(500),
  })
  .superRefine((data, ctx) => {
    if (data.status === 'Rejected' && !data.decisionNote) {
      ctx.addIssue({ code: 'custom', path: ['decisionNote'], message: 'Explain what needs fixing before rejecting.' });
    }
  });

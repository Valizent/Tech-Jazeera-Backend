/**
 * Audit controller — read-only. Audit rows are written by logAudit() inside
 * other modules; no endpoint creates, edits, or deletes them.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import { listAuditLogs } from './audit.service.js';
import { describeEntries } from './audit.describe.js';

/**
 * GET /api/audit?page=1&limit=20
 * Auth: Admin only — the audit trail exposes who-did-what across the company.
 * 200 → data: { items, total, page, pages } — each item carries `description`, the
 * plain-language sentences for its details (see audit.describe.js).
 * 401 no/bad token / 403 non-admin
 */
export async function list(req, res) {
  const data = await listAuditLogs(req.query);
  res.json(new ApiResponse('Audit log.', { ...data, items: await describeEntries(data.items) }));
}

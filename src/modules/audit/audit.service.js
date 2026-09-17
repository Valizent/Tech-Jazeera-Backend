/**
 * Audit service — the write helper every module calls, plus the admin query.
 *
 * logAudit() is fire-and-forget by design: an audit-write failure must never
 * fail the user's actual request (imagine login breaking because the audit
 * collection hiccuped). It logs the failure and moves on.
 */
import AuditLog from './audit.model.js';
import logger from '../../config/logger.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

/**
 * Record an audit event. Await it if you like — it never throws.
 * @param {object} entry
 * @param {string|null} [entry.user]     acting user's id (null for anonymous)
 * @param {string}      entry.action     e.g. 'auth.login.success'
 * @param {string|null} [entry.targetType]
 * @param {string|null} [entry.targetId]
 * @param {object}      [entry.meta]     small context — never secrets
 * @param {string|null} [entry.ip]
 */
export async function logAudit(entry) {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    logger.error(`Audit write failed for action "${entry.action}": ${err.message}`);
  }
}

/**
 * Paginated audit listing for the Security Log screen, newest first.
 * action → substring match on the dot-namespaced verb (e.g. "nfc" matches
 * every nfc.* action). from/to → inclusive date range on createdAt.
 * @returns {Promise<{items: object[], total: number, page: number, pages: number}>}
 */
export async function listAuditLogs({ page = 1, limit = 20, action, from, to }) {
  const filter = {};
  if (action) filter.action = { $regex: escapeRegex(action), $options: 'i' };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('user', 'name email role') // show who acted, not just an id
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

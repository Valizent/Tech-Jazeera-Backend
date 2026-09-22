/**
 * The "assign coordinators" / coordinator-filter picker — extracted
 * 2026-09-22 (a real QA-audit finding: `dailyUpdate.service.js` and
 * `requirement.service.js` had byte-identical `listCoordinators` bodies).
 * Deliberately takes the ALREADY-RESOLVED `teamRead` boolean, not an actor —
 * each module keeps its own `resolveAccess`/Section Access resolution
 * exactly as it was (the audit's own caution: "share only while preserving
 * each module's own access resolution"). Own-only access never needs
 * anyone else's name, so this stays team-read-gated in both callers.
 */
import User from '../modules/auth/user.model.js';
import ApiError from './ApiError.js';

const FORBIDDEN = 'You do not have permission to perform this action.';

export async function listActiveCoordinators(teamRead) {
  if (!teamRead) throw new ApiError(403, FORBIDDEN);
  return User.find({ role: 'Coordinator', isActive: true }).select('name').sort({ name: 1 }).lean();
}

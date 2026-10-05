/**
 * Stale-mobilisation warning job — structurally mirrors expiryAlert.job.js
 * (same setInterval registration pattern in server.js, same notifyUser
 * dedupe-key fan-out), but for a different kind of "sat too long" problem:
 * a mobilisation waiting PendingReview on a client's timesheet/PO/quotation
 * can realistically sit for months, so a Manager should be warned rather
 * than the record silently going stale.
 *
 * Checks the CURRENT step, whichever step that is — not specifically "the
 * Office Secretary step." There's no robust way to identify that step
 * generically (label text and ApprovalRole names are both admin-editable,
 * not a stable identifier), and in practice it's usually step 0 anyway,
 * since an Admin configuring this workflow puts Office Secretary first. The
 * settings field keeps the name `officeSecretaryStaleDays` for the same
 * reason, even though the check itself is step-agnostic.
 *
 * Company-wide, not Coordinator-scoped — same reasoning as the expiry job:
 * "warning for the manager" (the user's own words) means every Manager
 * login, not a per-team view.
 */
import Mobilisation from '../mobilisations/mobilisation.model.js';
import User from '../auth/user.model.js';
import { getMobilisationSettings } from '../mobilisationSettings/mobilisationSettings.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
// A week number (not a day), so a mobilisation stuck for six months doesn't
// re-notify daily — one nudge per calendar week per recipient is enough.
const weekKey = () => Math.floor(Date.now() / (7 * 86_400_000));

export async function runMobilisationStaleCheck() {
  const { officeSecretaryStaleDays } = await getMobilisationSettings();
  const threshold = new Date(Date.now() - officeSecretaryStaleDays * 86_400_000);

  const [staleMobilisations, managers] = await Promise.all([
    Mobilisation.find({
      status: 'PendingReview',
      currentStepEnteredAt: { $ne: null, $lte: threshold },
    })
      .select('workerName clientName currentStep steps currentStepEnteredAt')
      .lean(),
    User.find({ role: 'Manager', isActive: true }).select('_id').lean(),
  ]);

  if (staleMobilisations.length === 0 || managers.length === 0) {
    logger.info('[mobilisationStaleJob] nothing stale, or no Manager to notify skipped.');
    return { itemsFound: staleMobilisations.length, notificationsSent: 0 };
  }

  const week = weekKey();
  let notificationsSent = 0;
  for (const m of staleMobilisations) {
    const stepLabel = m.steps?.[m.currentStep]?.label || 'review';
    const days = daysSince(m.currentStepEnteredAt);
    const title = `Mobilisation for ${m.workerName} stuck at "${stepLabel}"`;
    const body = `${days} day(s) with no decision (${m.clientName}).`;
    for (const manager of managers) {
      const result = await notifyUser(manager._id, {
        type: 'RequestStatus',
        title,
        body,
        url: `/mobilisations/${m._id}`,
        dedupeKey: `mobilisation-stale:${m._id}:${week}:${manager._id}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
  }

  logger.info(`[mobilisationStaleJob] ${staleMobilisations.length} stale mobilisation(s) → ${notificationsSent} notification(s).`);
  return { itemsFound: staleMobilisations.length, notificationsSent };
}

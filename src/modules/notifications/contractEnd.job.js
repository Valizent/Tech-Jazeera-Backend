/**
 * Contract-end alert job (2026-10-14, the user's own ask): HR is told when an
 * employee's contract is about to end and again when it has. Nothing else
 * happens at that date by itself (see docs/ANNUAL-VACATION-notes.md); this makes
 * sure HR is not the last to find out.
 *
 *  - 'soon':  the end date is within CONTRACT_ALERT_DAYS (once per contract).
 *  - 'ended': the end date passed within the last ENDED_ALERT_DAYS, so a
 *             backlog of long-ended contracts never floods HR; those are on the
 *             dashboard's "Contracts ended, not renewed" list instead.
 *
 * Re-running daily is safe: `dedupeKey` is per (employee, end date, stage,
 * person), so renewing a contract (a new end date) starts a fresh cycle.
 * A plain setInterval in server.js drives it, like the other jobs.
 */
import Employee from '../employees/employee.model.js';
import User from '../auth/user.model.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const DAY = 86_400_000;
export const CONTRACT_ALERT_DAYS = 30;
export const ENDED_ALERT_DAYS = 7;

const utcDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const dayKey = (date) => utcDay(date).toISOString().slice(0, 10);

export async function runContractEndCheck() {
  const hr = await User.find({ role: 'HR', isActive: true }).select('_id').lean();
  if (hr.length === 0) {
    logger.info('[contractEndJob] no active HR login to notify - skipped.');
    return { itemsFound: 0, notificationsSent: 0 };
  }

  const today = utcDay(new Date());
  const employees = await Employee.find({
    status: { $ne: 'Exited' },
    contractEndDate: {
      $ne: null,
      $lte: new Date(today.getTime() + CONTRACT_ALERT_DAYS * DAY),
      $gte: new Date(today.getTime() - ENDED_ALERT_DAYS * DAY),
    },
  })
    .select('fullName employeeId contractEndDate')
    .lean();

  let notificationsSent = 0;
  for (const employee of employees) {
    const daysLeft = Math.round((utcDay(employee.contractEndDate).getTime() - today.getTime()) / DAY);
    const ended = daysLeft < 0;
    const stage = ended ? 'ended' : 'soon';
    const title = ended ? 'A contract has ended' : daysLeft === 0 ? 'A contract ends today' : 'A contract is about to end';
    const body = ended
      ? `${employee.fullName} (${employee.employeeId}): the contract ended ${Math.abs(daysLeft)} day(s) ago. Enter the renewed dates or start the exit.`
      : `${employee.fullName} (${employee.employeeId}): the contract ends in ${daysLeft} day(s).`;
    for (const person of hr) {
      const result = await notifyUser(person._id, {
        type: 'Expiry',
        title,
        body,
        url: `/employees/${employee._id}`,
        dedupeKey: `contract:${employee._id}:${dayKey(employee.contractEndDate)}:${stage}:${person._id}`,
      });
      if (result.wasNew) notificationsSent += 1;
    }
  }
  logger.info(`[contractEndJob] ${employees.length} contract(s) in the window -> ${notificationsSent} new notification(s).`);
  return { itemsFound: employees.length, notificationsSent };
}

/**
 * Missing company details: reminders and escalation (2026-10-12, milestone 3
 * of the company-profile programme). A client or subcontractor can be saved
 * without its Arabic name, CR, National Address, people, coordinators and
 * documents (companyProfile.service.js says what is missing). This job nags,
 * and escalates, until it is complete:
 *
 *   day 30 after the record was first seen incomplete -> whoever created it
 *   day 40                                           -> the BDM
 *   day 45, then every 5 days                        -> the Marketing Manager
 *
 * The BDM and Marketing Manager are not hard-coded: they are the members of
 * the approval roles an Admin ticks under Write on the Section Access cards
 * `companyDetailsBdm` / `companyDetailsManager` (the same "notify the members
 * of a granted role" precedent as deploymentsHoursDecide). With nobody
 * configured, that step simply waits and fires once someone is.
 *
 * The clock is `missingDetailsSince`: set when a record is created, or the
 * first time this job sees an older record incomplete (so every existing
 * record gets its 30 days from the release, not from its original date);
 * cleared the moment the record is complete. Each stage is recorded on the
 * record, so a job that missed days sends each stage once, not in a burst.
 *
 * Same scheduling approach as expiryAlert.job.js: a daily setInterval.
 */
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import User from '../auth/user.model.js';
import { withMissingDetails } from '../companyProfile/companyProfile.service.js';
import { getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUser } from './notification.service.js';
import logger from '../../config/logger.js';

const DAY = 86_400_000;
export const CREATOR_REMINDER_DAYS = 30;
export const BDM_ESCALATION_DAYS = 40;
export const MANAGER_ESCALATION_DAYS = 45;
export const MANAGER_REPEAT_DAYS = 5;

const dayKey = (date) => date.toISOString().slice(0, 10);

const ITEM_LABELS = {
  arabicName: 'Arabic company name',
  crNumber: 'CR number',
  crExpiry: 'CR expiry date',
  nationalAddress: 'National address',
  contact: 'Contact person',
  finance: 'Finance person',
  owner: 'Owner',
  coordinators: 'Coordinators',
  agreementDocument: 'Agreement document with expiry date',
  crDocument: 'CR document with expiry date',
  nationalAddressDocument: 'National address document',
};

/**
 * Which reminders are due now. `reminders` is the record's own bookkeeping
 * ({ creatorAt, bdmAt, managerAt }); a stage already sent is never repeated,
 * except the manager stage which repeats every MANAGER_REPEAT_DAYS.
 */
export function dueReminders({ since, now, reminders = {} }) {
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / DAY);
  const due = [];
  if (days >= CREATOR_REMINDER_DAYS && !reminders.creatorAt) due.push('creator');
  if (days >= BDM_ESCALATION_DAYS && !reminders.bdmAt) due.push('bdm');
  if (
    days >= MANAGER_ESCALATION_DAYS &&
    (!reminders.managerAt || now.getTime() - new Date(reminders.managerAt).getTime() >= MANAGER_REPEAT_DAYS * DAY)
  ) {
    due.push('manager');
  }
  return due;
}

const KINDS = [
  { Model: Client, ownerType: 'Client', nameOf: (c) => c.companyName, path: 'clients', filter: { status: 'Active', approvalStatus: 'Approved' } },
  { Model: Subcontractor, ownerType: 'Subcontractor', nameOf: (c) => c.name, path: 'subcontractors', filter: { status: 'Active' } },
];

async function recipientsFor(sectionKey) {
  const settings = await getSectionAccess(sectionKey);
  return membersOfRoles(settings.writeApprovalRoles);
}

export async function runCompanyDetailsCheck(now = new Date()) {
  const [bdmIds, managerIds] = await Promise.all([recipientsFor('companyDetailsBdm'), recipientsFor('companyDetailsManager')]);
  let checked = 0;
  let sent = 0;

  for (const kind of KINDS) {
    const companies = await withMissingDetails(kind.ownerType, await kind.Model.find(kind.filter).lean());
    for (const company of companies) {
      checked += 1;
      const update = {};

      if (company.missingDetails.length === 0) {
        if (company.missingDetailsSince) {
          update.$set = { missingDetailsSince: null, missingDetailsReminders: { creatorAt: null, bdmAt: null, managerAt: null } };
        }
      } else if (!company.missingDetailsSince) {
        update.$set = { missingDetailsSince: now, missingDetailsReminders: { creatorAt: null, bdmAt: null, managerAt: null } };
      } else {
        const due = dueReminders({ since: company.missingDetailsSince, now, reminders: company.missingDetailsReminders });
        const missingText = company.missingDetails.map((key) => ITEM_LABELS[key] ?? key).join(', ');
        const base = {
          type: 'Task',
          title: `${kind.nameOf(company)}: company details missing`,
          body: `${company.missingDetails.length} missing: ${missingText}.`.slice(0, 480),
          url: `/${kind.path}/${company._id}`,
        };
        const stamp = {};

        for (const stage of due) {
          let recipients = stage === 'bdm' ? bdmIds : managerIds;
          if (stage === 'creator') {
            const creator = company.createdBy
              ? await User.findOne({ _id: company.createdBy, isActive: true }).select('_id').lean()
              : null;
            recipients = creator ? [String(creator._id)] : [];
          }
          if (recipients.length === 0) {
            // A creator who is unknown or gone is skipped for good; an
            // unconfigured BDM / Marketing Manager step waits for someone to be ticked.
            if (stage === 'creator') stamp['missingDetailsReminders.creatorAt'] = now;
            continue;
          }
          for (const userId of recipients) {
            const result = await notifyUser(userId, {
              ...base,
              dedupeKey: `companyDetails:${stage}:${company._id}:${dayKey(now)}:${userId}`,
            });
            if (result.wasNew) sent += 1;
          }
          stamp[`missingDetailsReminders.${stage}At`] = now;
        }
        if (Object.keys(stamp).length > 0) update.$set = stamp;
      }

      if (update.$set) await kind.Model.updateOne({ _id: company._id }, update);
    }
  }

  logger.info(`[companyDetailsJob] ${checked} compan(ies) checked, ${sent} reminder(s) sent.`);
  return { checked, sent };
}

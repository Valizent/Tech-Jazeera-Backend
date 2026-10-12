/**
 * companyDetails.job.test.js - missing company details: who is reminded and
 * when (2026-10-12). Day 30 the creator, day 40 the BDM, day 45 and every 5
 * days the Marketing Manager; the clock starts when a record is first seen
 * incomplete and stops when it is complete.
 */
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Notification from './notification.model.js';
import Document from '../documents/document.model.js';
import { dueReminders, runCompanyDetailsCheck } from './companyDetails.job.js';

const DAY = 86_400_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const daysAgo = (n, from = new Date()) => new Date(from.getTime() - n * DAY);

async function login(role = 'Manager') {
  return User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
}

/** Make `user` the recipient of a reminder step by ticking a role under Write on its card. */
async function recipient(sectionKey, user) {
  const role = await ApprovalRole.create({ name: `Recipients ${unique()}`, members: [user._id] });
  await SectionAccess.updateOne({ sectionKey }, { $addToSet: { writeApprovalRoles: role._id }, $setOnInsert: { readApprovalRoles: [] } }, { upsert: true });
}

const count = (userId, companyId) => Notification.countDocuments({ user: userId, url: new RegExp(String(companyId)) });

describe('dueReminders', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  const since = (days) => daysAgo(days, now);

  it('sends nothing before day 30', () => {
    expect(dueReminders({ since: since(29), now })).toEqual([]);
  });

  it('day 30: the creator; day 40: the BDM added; day 45: the Marketing Manager added', () => {
    expect(dueReminders({ since: since(30), now })).toEqual(['creator']);
    expect(dueReminders({ since: since(40), now, reminders: { creatorAt: since(10) } })).toEqual(['bdm']);
    expect(dueReminders({ since: since(45), now, reminders: { creatorAt: since(15), bdmAt: since(5) } })).toEqual(['manager']);
  });

  it('a job that missed days catches up with each stage once', () => {
    expect(dueReminders({ since: since(60), now })).toEqual(['creator', 'bdm', 'manager']);
  });

  it('repeats the Marketing Manager every 5 days, not sooner', () => {
    const reminders = { creatorAt: since(30), bdmAt: since(20), managerAt: since(4) };
    expect(dueReminders({ since: since(70), now, reminders })).toEqual([]);
    expect(dueReminders({ since: since(70), now, reminders: { ...reminders, managerAt: since(5) } })).toEqual(['manager']);
  });
});

describe('runCompanyDetailsCheck', () => {
  it('starts the clock the first time it sees an old incomplete record, and sends nothing yet', async () => {
    const client = await Client.create({ companyName: `Old ${unique()}` }); // no missingDetailsSince: predates the feature
    const result = await runCompanyDetailsCheck(new Date());
    expect(result.sent).toBe(0);
    const after = await Client.findById(client._id).lean();
    expect(after.missingDetailsSince).toBeTruthy();
  });

  it('walks a client through creator, BDM and Marketing Manager, once each, and stops when complete', async () => {
    const creator = await login('Coordinator');
    const bdm = await login('Manager');
    const mm = await login('Manager');
    await recipient('companyDetailsBdm', bdm);
    await recipient('companyDetailsManager', mm);
    const start = new Date('2026-12-01T00:00:00Z');
    const client = await Client.create({ companyName: `Walk ${unique()}`, createdBy: creator._id, missingDetailsSince: start });

    await runCompanyDetailsCheck(new Date(start.getTime() + 29 * DAY));
    expect(await count(creator._id, client._id)).toBe(0);

    await runCompanyDetailsCheck(new Date(start.getTime() + 30 * DAY));
    expect(await count(creator._id, client._id)).toBe(1);
    expect(await count(bdm._id, client._id)).toBe(0);

    await runCompanyDetailsCheck(new Date(start.getTime() + 31 * DAY)); // nothing new
    expect(await count(creator._id, client._id)).toBe(1);

    await runCompanyDetailsCheck(new Date(start.getTime() + 40 * DAY));
    expect(await count(bdm._id, client._id)).toBe(1);
    expect(await count(mm._id, client._id)).toBe(0);

    await runCompanyDetailsCheck(new Date(start.getTime() + 45 * DAY));
    await runCompanyDetailsCheck(new Date(start.getTime() + 47 * DAY)); // too soon to repeat
    expect(await count(mm._id, client._id)).toBe(1);
    await runCompanyDetailsCheck(new Date(start.getTime() + 50 * DAY));
    expect(await count(mm._id, client._id)).toBe(2);
    expect(await count(creator._id, client._id)).toBe(1);
    expect(await count(bdm._id, client._id)).toBe(1);

    // Completing the record (here: every detail and document) stops it and clears the clock.
    await Client.updateOne(
      { _id: client._id },
      {
        $set: {
          arabicName: 'شركة', crNumber: '1010123456', crExpiry: new Date('2030-01-01'), contactPerson: 'A', contactPosition: 'B', phone: '+966500000001', email: 'a@b.co',
          financePerson: { name: 'A', position: 'B', phone: '+966500000001', email: 'a@b.co' },
          owner: { name: 'A', position: 'B', phone: '+966500000001', email: 'a@b.co' },
          nationalAddress: { buildingNumber: '1234', streetName: 'S', district: 'D', city: 'C', postalCode: '12345', additionalNumber: '1234' },
          coordinators: [{ name: 'Omar' }],
        },
      }
    );
    const file = { version: 1, fileName: 'f', originalName: 'f.pdf', mimeType: 'application/pdf', size: 1 };
    for (const category of ['Agreement', 'Commercial Registration']) {
      await Document.create({ title: category, category, ownerType: 'Client', owner: client._id, expiryDate: new Date('2030-01-01'), versions: [file] });
    }
    await Document.create({ title: 'NA', category: 'National Address', ownerType: 'Client', owner: client._id, versions: [file] });
    await runCompanyDetailsCheck(new Date(start.getTime() + 60 * DAY));
    expect(await count(mm._id, client._id)).toBe(2);
    const done = await Client.findById(client._id).lean();
    expect(done.missingDetailsSince).toBeNull();
  });

  it('holds the BDM step until someone is configured, then sends it', async () => {
    const creator = await login('Coordinator');
    const start = new Date('2027-01-01T00:00:00Z');
    const sub = await Subcontractor.create({ name: `Wait ${unique()}`, createdBy: creator._id, missingDetailsSince: start });
    await SectionAccess.updateOne({ sectionKey: 'companyDetailsBdm' }, { $set: { writeApprovalRoles: [] } }, { upsert: true });

    await runCompanyDetailsCheck(new Date(start.getTime() + 41 * DAY));
    expect(await count(creator._id, sub._id)).toBe(1);
    const held = await Subcontractor.findById(sub._id).lean();
    expect(held.missingDetailsReminders.bdmAt).toBeNull();

    const bdm = await login('Manager');
    await recipient('companyDetailsBdm', bdm);
    await runCompanyDetailsCheck(new Date(start.getTime() + 42 * DAY));
    expect(await count(bdm._id, sub._id)).toBe(1);
  });

  it('ignores inactive companies', async () => {
    const start = new Date('2027-03-01T00:00:00Z');
    const client = await Client.create({ companyName: `Inactive ${unique()}`, status: 'Inactive', missingDetailsSince: start });
    await runCompanyDetailsCheck(new Date(start.getTime() + 100 * DAY));
    const after = await Client.findById(client._id).lean();
    expect(after.missingDetailsReminders.creatorAt).toBeNull();
  });
});

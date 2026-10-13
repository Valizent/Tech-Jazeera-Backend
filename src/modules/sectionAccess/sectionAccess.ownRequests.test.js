/**
 * sectionAccess.ownRequests.test.js - milestone 2 (2026-10-13): the "my own"
 * permissions split off Leave and Timesheets (leaveApply, timesheetOwn), and the
 * "All office staff, except these roles" list.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from './sectionAccess.model.js';
import { canAccessSection, getMySectionAccess, updateSectionAccess } from './sectionAccess.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });

async function person(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s+/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { user, actor: { userId: user._id.toString(), role } };
}

const roleWith = (...users) => ApprovalRole.create({ name: `Role ${unique()}`, members: users.map((u) => u._id) });

describe('leaveApply follows leaveRequests Write until it is configured', () => {
  it('a member of the leave Write circle may apply; a reader may not', async () => {
    const decider = await person('HR');
    const reader = await person('Accounts');
    const writeRole = await roleWith(decider.user);
    const readRole = await roleWith(reader.user);
    await SectionAccess.create({ sectionKey: 'leaveRequests', readApprovalRoles: [readRole._id], writeApprovalRoles: [writeRole._id] });

    expect(await canAccessSection('leaveApply', decider.actor, 'write')).toBe(true);
    expect(await canAccessSection('leaveApply', reader.actor, 'write')).toBe(false);
    expect(await canAccessSection('leaveRequests', reader.actor, 'read')).toBe(true);
  });

  it('once configured it stops following, and applying no longer lets you see the queue', async () => {
    const hr = await person('HR');
    const clerk = await person('Accounts');
    const hrRole = await roleWith(hr.user);
    const applyRole = await roleWith(clerk.user);
    await SectionAccess.create({ sectionKey: 'leaveRequests', readApprovalRoles: [hrRole._id], writeApprovalRoles: [hrRole._id] });
    await SectionAccess.create({ sectionKey: 'leaveApply', writeApprovalRoles: [applyRole._id] });

    expect(await canAccessSection('leaveApply', clerk.actor, 'write')).toBe(true);
    expect(await canAccessSection('leaveRequests', clerk.actor, 'read')).toBe(false);
    expect(await canAccessSection('leaveApply', hr.actor, 'write')).toBe(false);
  });
});

describe('timesheetOwn follows everyone who can read Timesheet requests until configured', () => {
  it('readers and writers of the requests may open their own', async () => {
    const reader = await person('HR');
    const writer = await person('Manager');
    const outsider = await person('Accounts');
    const readRole = await roleWith(reader.user);
    const writeRole = await roleWith(writer.user);
    await SectionAccess.create({ sectionKey: 'timesheetRequests', readApprovalRoles: [readRole._id], writeApprovalRoles: [writeRole._id] });

    expect(await canAccessSection('timesheetOwn', reader.actor, 'read')).toBe(true);
    expect(await canAccessSection('timesheetOwn', writer.actor, 'read')).toBe(true);
    expect(await canAccessSection('timesheetOwn', outsider.actor, 'read')).toBe(false);
  });
});

describe('All office staff, except these roles', () => {
  it('covers every office login except members of the except roles', async () => {
    const top = await person('Executive');
    const clerk = await person('Accounts');
    const coordinator = await person('Coordinator');
    const exceptRole = await roleWith(top.user);
    await updateSectionAccess(
      'leaveApply',
      { readApprovalRoles: [], writeApprovalRoles: [], writeAllStaff: true, allStaffExceptRoles: [exceptRole._id.toString()] },
      admin()
    );

    expect(await canAccessSection('leaveApply', clerk.actor, 'write')).toBe(true);
    expect(await canAccessSection('leaveApply', coordinator.actor, 'write')).toBe(true);
    expect(await canAccessSection('leaveApply', top.actor, 'write')).toBe(false);
    expect((await getMySectionAccess(clerk.actor)).write).toContain('leaveApply');
    expect((await getMySectionAccess(top.actor)).write).not.toContain('leaveApply');
  });

  it('an except role never removes a person who is also named in a role grant', async () => {
    const both = await person('HR');
    const role = await roleWith(both.user);
    await updateSectionAccess(
      'leaveApply',
      { readApprovalRoles: [], writeApprovalRoles: [role._id.toString()], writeAllStaff: true, allStaffExceptRoles: [role._id.toString()] },
      admin()
    );
    expect(await canAccessSection('leaveApply', both.actor, 'write')).toBe(true);
  });

  it('refuses an unknown role in the except list', async () => {
    await expect(
      updateSectionAccess('leaveApply', { readApprovalRoles: [], writeApprovalRoles: [], allStaffExceptRoles: [new mongoose.Types.ObjectId().toString()] }, admin())
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

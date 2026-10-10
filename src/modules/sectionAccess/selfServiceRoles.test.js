/**
 * selfServiceRoles.test.js — the reserved "Worker" and "Staff" approval roles
 * (2026-10-10): who may be a member, which sections they can ever be granted,
 * and that the route floor opens only for a granted module.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from './sectionAccess.model.js';
import { ensureSelfServiceRoles, createApprovalRole, updateApprovalRole } from '../approvals/approvals.service.js';
import { canAccessSection, getMySectionAccess, updateSectionAccess } from './sectionAccess.service.js';
import { requireStaffOrSelfServiceGrant } from './sectionAccess.middleware.js';
import { SELF_SERVICE_GRANTABLE_KEYS } from './selfService.constants.js';

const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function makeUser(role, extra = {}) {
  return User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role, ...extra });
}

async function workerRole() {
  await ensureSelfServiceRoles();
  return ApprovalRole.findOne({ name: 'Worker' });
}

describe('reserved Worker and Staff roles', () => {
  it('are created once, flagged, and the call is idempotent', async () => {
    await ensureSelfServiceRoles();
    await ensureSelfServiceRoles();
    const roles = await ApprovalRole.find({ name: { $in: ['Worker', 'Staff'] } }).lean();
    expect(roles).toHaveLength(2);
    expect(roles.every((r) => r.allowsSelfService)).toBe(true);
  });

  it('adopts a same-named role an Admin had already created', async () => {
    await ApprovalRole.create({ name: 'Staff', members: [] });
    await ensureSelfServiceRoles();
    const staff = await ApprovalRole.findOne({ name: 'Staff' }).lean();
    expect(staff.allowsSelfService).toBe(true);
  });

  it('accept Worker logins as members; a normal role still refuses them', async () => {
    const role = await workerRole();
    const worker = await makeUser('Worker');
    const updated = await updateApprovalRole(role._id.toString(), { members: [worker._id.toString()] }, admin());
    expect(updated.members).toHaveLength(1);

    const normal = await createApprovalRole({ name: `Normal ${unique()}`, members: [] }, admin());
    await expect(updateApprovalRole(normal._id.toString(), { members: [worker._id.toString()] }, admin())).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Section Access for a self-service login', () => {
  async function granted(sectionKey, level = 'read') {
    const role = await workerRole();
    const worker = await makeUser('Worker');
    await ApprovalRole.updateOne({ _id: role._id }, { $set: { members: [worker._id] } });
    const grant = level === 'write' ? { writeApprovalRoles: [role._id] } : { readApprovalRoles: [role._id] };
    await SectionAccess.updateOne({ sectionKey }, { sectionKey, readApprovalRoles: [], writeApprovalRoles: [], ...grant }, { upsert: true });
    return { actor: { userId: worker._id.toString(), role: 'Worker' }, role };
  }

  it('Read on a safe section opens it, and only it', async () => {
    const { actor } = await granted('assetsManage');
    expect(await canAccessSection('assetsManage', actor, 'read')).toBe(true);
    expect(await canAccessSection('assetsManage', actor, 'write')).toBe(false);
    expect(await canAccessSection('holidays', actor, 'read')).toBe(false);
    expect(await getMySectionAccess(actor)).toEqual({ read: ['assetsManage'], write: [] });
  });

  it('Write implies Read', async () => {
    const { actor } = await granted('documentsManage', 'write');
    expect(await canAccessSection('documentsManage', actor, 'write')).toBe(true);
    expect(await canAccessSection('documentsManage', actor, 'read')).toBe(true);
    expect((await getMySectionAccess(actor)).write).toEqual(['documentsManage']);
  });

  it('a section outside the safe list stays closed even if a grant exists in the database', async () => {
    const { actor } = await granted('eosb', 'write'); // written straight to the DB, bypassing the save-time check
    expect(await canAccessSection('eosb', actor, 'read')).toBe(false);
    expect(await getMySectionAccess(actor)).toEqual({ read: [], write: [] });
  });

  it('saving a grant of an unsafe section to the Worker role is refused with an explanation; a safe one is accepted', async () => {
    const role = await workerRole();
    await expect(updateSectionAccess('eosb', { readApprovalRoles: [role._id.toString()], writeApprovalRoles: [] }, admin())).rejects.toMatchObject({
      statusCode: 400,
    });
    const ok = await updateSectionAccess('holidays', { readApprovalRoles: [role._id.toString()], writeApprovalRoles: [] }, admin());
    expect(ok.readApprovalRoles).toHaveLength(1);
  });

  it('the safe list contains no money, payroll-adjacent, employee-record or admin section', () => {
    for (const forbidden of ['eosb', 'expenses', 'employeeCreate', 'companySettings', 'team', 'approvalHierarchy', 'auditLog', 'deploymentsInvoicing', 'dashboardProfit']) {
      expect(SELF_SERVICE_GRANTABLE_KEYS).not.toContain(forbidden);
    }
  });
});

describe('requireStaffOrSelfServiceGrant', () => {
  const run = (role, userId, ...keys) =>
    new Promise((resolve) => {
      const middleware = requireStaffOrSelfServiceGrant(...keys);
      middleware({ user: { id: userId, role } }, {}, (err) => resolve(err ? err.statusCode : 'next'));
    });

  it('lets a staff role through, blocks an ungranted Worker, and lets a granted one in', async () => {
    const role = await workerRole();
    const worker = await makeUser('Worker');
    expect(await run('HR', new mongoose.Types.ObjectId().toString(), 'assetsManage')).toBe('next');
    expect(await run('Worker', worker._id.toString(), 'assetsManage')).toBe(403);

    await ApprovalRole.updateOne({ _id: role._id }, { $set: { members: [worker._id] } });
    await SectionAccess.updateOne({ sectionKey: 'assetsManage' }, { sectionKey: 'assetsManage', readApprovalRoles: [role._id], writeApprovalRoles: [] }, { upsert: true });
    expect(await run('Worker', worker._id.toString(), 'assetsManage')).toBe('next');
    expect(await run('Worker', worker._id.toString(), 'documentsManage')).toBe(403);
  });
});

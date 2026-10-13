/**
 * sectionAccess.employees.test.js - the Employees permissions added 2026-10-13
 * (employeeEdit / employeeDelete / employeeFinancial) and the "All office staff"
 * switch: edit follows Add until configured, delete and pay start Admin-only,
 * the switch opens a tier to every office login but never to Worker/Staff.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import SectionAccess from './sectionAccess.model.js';
import { canAccessSection, getMySectionAccess, updateSectionAccess } from './sectionAccess.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });

async function person(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
  return { user, actor: { userId: user._id.toString(), role } };
}

async function roleWith(user) {
  return ApprovalRole.create({ name: `Role ${unique()}`, members: [user._id] });
}

describe('employee edit follows Add until it is configured', () => {
  it('a member of the Add circle may edit, and may not delete or see pay', async () => {
    const { user, actor } = await person('Coordinator');
    const role = await roleWith(user);
    await SectionAccess.create({ sectionKey: 'employeeCreate', writeApprovalRoles: [role._id] });

    expect(await canAccessSection('employeeCreate', actor, 'write')).toBe(true);
    expect(await canAccessSection('employeeEdit', actor, 'write')).toBe(true);
    expect(await canAccessSection('employeeDelete', actor, 'write')).toBe(false);
    expect(await canAccessSection('employeeFinancial', actor, 'read')).toBe(false);
    expect((await getMySectionAccess(actor)).write).toEqual(expect.arrayContaining(['employeeCreate', 'employeeEdit']));
  });

  it('viewing alone does not give edit', async () => {
    const { user, actor } = await person('HR');
    const role = await roleWith(user);
    await SectionAccess.create({ sectionKey: 'employeeCreate', readApprovalRoles: [role._id] });
    expect(await canAccessSection('employeeCreate', actor, 'read')).toBe(true);
    expect(await canAccessSection('employeeEdit', actor, 'write')).toBe(false);
  });

  it('once employeeEdit is configured it stops following Add', async () => {
    const adder = await person('Coordinator');
    const editor = await person('Manager');
    const addRole = await roleWith(adder.user);
    const editRole = await roleWith(editor.user);
    await SectionAccess.create({ sectionKey: 'employeeCreate', writeApprovalRoles: [addRole._id] });
    await SectionAccess.create({ sectionKey: 'employeeEdit', writeApprovalRoles: [editRole._id] });

    expect(await canAccessSection('employeeEdit', adder.actor, 'write')).toBe(false);
    expect(await canAccessSection('employeeEdit', editor.actor, 'write')).toBe(true);
  });
});

describe('pay and delete start Admin-only', () => {
  it('Admin always passes; a view-only office login does not', async () => {
    const hr = await person('HR');
    expect(await canAccessSection('employeeFinancial', { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin' }, 'read')).toBe(true);
    expect(await canAccessSection('employeeFinancial', hr.actor, 'read')).toBe(false);
    expect(await canAccessSection('employeeDelete', hr.actor, 'write')).toBe(false);
  });

  it('an Executive login reaches pay once its role is granted', async () => {
    const { user, actor } = await person('Executive');
    const role = await roleWith(user);
    await SectionAccess.create({ sectionKey: 'employeeFinancial', readApprovalRoles: [role._id] });
    expect(await canAccessSection('employeeFinancial', actor, 'read')).toBe(true);
    expect(await canAccessSection('employeeFinancial', actor, 'write')).toBe(false);
  });
});

describe('the All office staff switch', () => {
  it('opens Read to every office login but not to Worker or Staff', async () => {
    await updateSectionAccess('employeeCreate', { readApprovalRoles: [], writeApprovalRoles: [], readAllStaff: true }, admin());
    for (const role of ['Manager', 'HR', 'Accounts', 'Coordinator', 'Executive', 'Office Secretary']) {
      const { actor } = await person(role);
      expect(await canAccessSection('employeeCreate', actor, 'read')).toBe(true);
      expect(await canAccessSection('employeeCreate', actor, 'write')).toBe(false);
      expect((await getMySectionAccess(actor)).read).toContain('employeeCreate');
    }
    for (const role of ['Worker', 'Staff']) {
      const { actor } = await person(role);
      expect(await canAccessSection('employeeCreate', actor, 'read')).toBe(false);
    }
  });

  it('an update that omits the switch leaves it as it was', async () => {
    await updateSectionAccess('employeeCreate', { readApprovalRoles: [], writeApprovalRoles: [], readAllStaff: true }, admin());
    const kept = await updateSectionAccess('employeeCreate', { readApprovalRoles: [], writeApprovalRoles: [] }, admin());
    expect(kept.readAllStaff).toBe(true);
  });
});

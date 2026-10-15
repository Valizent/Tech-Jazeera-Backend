/**
 * specialRoles.test.js - the role treated as HR (its step on an annual vacation may change the days) comes from the
 * Approval Hierarchy settings, and falls back to the role named HR.
 */
import ApprovalRole from './approvalRole.model.js';
import { resolveHrRole, getSpecialRoles, setSpecialRoles } from './approvals.service.js';

const actor = { userId: '64b000000000000000000001', ip: '127.0.0.1' };
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe('HR approval role', () => {
  it('finds the role by its usual name until one is chosen, then uses the chosen one', async () => {
    const named = await ApprovalRole.create({ name: 'HR' });
    expect((await resolveHrRole())._id).toEqual(named._id);

    const other = await ApprovalRole.create({ name: `People team ${unique()}` });
    await setSpecialRoles({ hr: String(other._id) }, actor);
    expect((await resolveHrRole())._id).toEqual(other._id);
    expect((await getSpecialRoles()).hr).toMatchObject({ chosen: String(other._id) });

    // clearing it goes back to the usual name; an inactive chosen role is ignored too
    await setSpecialRoles({ hr: null }, actor);
    expect((await resolveHrRole())._id).toEqual(named._id);
    await setSpecialRoles({ hr: String(other._id) }, actor);
    await ApprovalRole.updateOne({ _id: other._id }, { isActive: false });
    expect((await resolveHrRole())._id).toEqual(named._id);
  });

  it('refuses a role that is not active, and finds nothing when there is no HR role', async () => {
    const off = await ApprovalRole.create({ name: `Off ${unique()}`, isActive: false });
    await expect(setSpecialRoles({ hr: String(off._id) }, actor)).rejects.toMatchObject({ statusCode: 400 });
    expect(await resolveHrRole()).toBeNull();
  });
});

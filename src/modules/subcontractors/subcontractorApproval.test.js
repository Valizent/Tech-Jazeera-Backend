/**
 * subcontractorApproval.test.js - a subcontractor added by anyone but an Admin or Manager waits for approval
 * (the SubcontractorApproval hierarchy), cannot be put on a mobilisation until approved, and goes back to review
 * when its submitter edits it.
 */
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Subcontractor from './subcontractor.model.js';
import { createSubcontractor, updateSubcontractor, decideSubcontractor, listSubcontractors } from './subcontractor.service.js';
import { resolveSubcontractorSnapshot } from '../mobilisations/mobilisation.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const login = async (role) => {
  const u = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(u._id), role, ip: '127.0.0.1' };
};
const input = (name) => ({ name, status: 'Active', creditLimitDays: 30 });

describe('subcontractor approval', () => {
  it('Admin and Manager add straight in; anyone else waits, with no hierarchy an Admin or Manager decides', async () => {
    const admin = await login('Admin');
    const hr = await login('HR');
    const direct = await createSubcontractor(input(`Direct ${unique()}`), admin);
    expect(direct.approvalStatus).toBe('Approved');

    const waiting = await createSubcontractor(input(`Waiting ${unique()}`), hr);
    expect(waiting.approvalStatus).toBe('Pending');

    await expect(resolveSubcontractorSnapshot('SupplierEmployee', String(waiting._id))).rejects.toMatchObject({ statusCode: 409 });

    const decided = await decideSubcontractor(String(waiting._id), { status: 'Approved' }, admin);
    expect(decided.approvalStatus).toBe('Approved');
    const snapshot = await resolveSubcontractorSnapshot('SupplierEmployee', String(waiting._id));
    expect(snapshot.hasSubcontractor).toBe(true);
  });

  it('the submitter can fix a rejected one (it goes back to Pending) but not an approved one', async () => {
    const admin = await login('Admin');
    const hr = await login('HR');
    const created = await createSubcontractor(input(`Fix ${unique()}`), hr);
    await decideSubcontractor(String(created._id), { status: 'Rejected', decisionNote: 'Add the CR number' }, admin);
    const resubmitted = await updateSubcontractor(String(created._id), { crNumber: '1010' }, hr);
    expect(resubmitted).toMatchObject({ approvalStatus: 'Pending', decisionNote: '' });

    await decideSubcontractor(String(created._id), { status: 'Approved' }, admin);
    await expect(updateSubcontractor(String(created._id), { phone: '0500000000' }, hr)).rejects.toMatchObject({ statusCode: 403 });
    // somebody else's submission is not theirs to edit either
    const other = await createSubcontractor(input(`Other ${unique()}`), await login('Accounts'));
    await expect(updateSubcontractor(String(other._id), { phone: '0500000000' }, hr)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('with a hierarchy, only a member of the current step decides; the list filters Approved including older records', async () => {
    const admin = await login('Admin');
    const hr = await login('HR');
    const approver = await login('Manager');
    const outsider = await login('Accounts');
    const role = await ApprovalRole.create({ name: `Sub approvers ${unique()}`, members: [approver.userId] });
    await ApprovalWorkflow.create({ name: `Sub flow ${unique()}`, appliesTo: ['SubcontractorApproval'], steps: [{ label: 'Check', roles: [role._id] }] });
    await SectionAccess.create({ sectionKey: 'subcontractorsManage', writeApprovalRoles: [role._id] });

    const created = await createSubcontractor(input(`Flow ${unique()}`), hr);
    expect(created.workflow).toBeTruthy();
    await expect(decideSubcontractor(String(created._id), { status: 'Approved' }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    const done = await decideSubcontractor(String(created._id), { status: 'Approved' }, approver);
    expect(done.approvalStatus).toBe('Approved');

    // a record stored before the field existed still counts as Approved
    await Subcontractor.collection.insertOne({ name: `Old ${unique()}`, status: 'Active', creditLimitDays: 30, createdAt: new Date(), updatedAt: new Date() });
    const approved = await listSubcontractors({ page: 1, limit: 50, approvalStatus: 'Approved', sortBy: 'name', sortOrder: 'asc' }, admin);
    expect(approved.items.map((i) => i.name).some((n) => n.startsWith('Old '))).toBe(true);
    expect(approved.items.every((i) => (i.approvalStatus ?? 'Approved') === 'Approved')).toBe(true);
  });
});

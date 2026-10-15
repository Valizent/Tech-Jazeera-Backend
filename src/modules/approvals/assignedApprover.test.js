/**
 * assignedApprover.test.js - a step of a request on a hierarchy is given to ONE member of its roles when the
 * request is raised (2026-10-14): only they (or an Admin) may decide it, only they are told, and an assignee who
 * has left the role no longer blocks the rest.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow from './approvalWorkflow.model.js';
import Notification from '../notifications/notification.model.js';
import { createClient, decideClient, listClients } from '../clients/client.service.js';
import { updateApprovalRole } from './approvals.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id, ip: '127.0.0.1' };
}

async function setup() {
  const [a, b, coordinator] = await Promise.all([login('Manager'), login('Manager'), login('Coordinator')]);
  const role = await ApprovalRole.create({ name: `Pool ${unique()}`, members: [a.id, b.id] });
  await ApprovalWorkflow.create({ name: `Assign ${unique()}`, appliesTo: ['ClientApproval'], steps: [{ label: 'Pool', roles: [role._id] }] });
  const client = await createClient({ companyName: `Client ${unique()}` }, coordinator);
  const assigneeId = String(client.steps[0].assignee);
  const assignee = [a, b].find((m) => m.userId === assigneeId);
  const other = [a, b].find((m) => m.userId !== assigneeId);
  return { a, b, assignee, other, role, client };
}

describe('assigned approver', () => {
  it('gives each step to one member of its role and tells only them', async () => {
    const { assignee, other, client } = await setup();
    expect([assignee, other].every(Boolean)).toBe(true);
    expect(await Notification.countDocuments({ user: assignee.id })).toBe(1);
    expect(await Notification.countDocuments({ user: other.id })).toBe(0);
    expect(client.steps[0].label).toBe('Pool');
  });

  it('only the assignee (or Admin) may decide it, and the list says so', async () => {
    const { assignee, other, client } = await setup();
    await expect(decideClient(String(client._id), { status: 'Approved' }, other)).rejects.toMatchObject({ statusCode: 403 });

    const query = { page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'desc', search: client.companyName };
    expect((await listClients(query, other)).items[0].canDecideCurrentStep).toBe(false);
    const mine = await listClients(query, assignee);
    expect(mine.items[0].canDecideCurrentStep).toBe(true);
    expect(mine.items[0].steps[0].assignee.name).toBe(assignee.userId ? (await User.findById(assignee.userId)).name : '');

    const decided = await decideClient(String(client._id), { status: 'Approved' }, assignee);
    expect(decided.approvalStatus).toBe('Approved');
  });

  it('Admin can always decide, and an assignee who left the role no longer blocks the others', async () => {
    const { assignee, other, role, client } = await setup();
    await ApprovalRole.updateOne({ _id: role._id }, { $pull: { members: assignee.id } });
    const decided = await decideClient(String(client._id), { status: 'Approved' }, other);
    expect(decided.approvalStatus).toBe('Approved');

    const coordinator = await login('Coordinator');
    const second = await createClient({ companyName: `Client ${unique()}` }, coordinator);
    const admin = { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' };
    expect((await decideClient(String(second._id), { status: 'Approved' }, admin)).approvalStatus).toBe('Approved');
  });

  it('gives a waiting stage to the remaining member when its assignee is taken out of the role', async () => {
    const { assignee, other, role, client } = await setup();
    const admin = { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' };

    await updateApprovalRole(String(role._id), { members: [other.userId] }, admin);

    const query = { page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'desc', search: client.companyName };
    const after = (await listClients(query, other)).items[0];
    expect(String(after.steps[0].assignee._id)).toBe(other.userId);
    expect(after.canDecideCurrentStep).toBe(true);
    expect(assignee.userId).not.toBe(other.userId);
  });
});

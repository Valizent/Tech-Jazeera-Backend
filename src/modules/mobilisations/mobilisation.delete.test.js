/**
 * mobilisation.delete.test.js - deleting a mobilisation before it is approved
 * (2026-10-14): the people who made a Draft may delete it, only Admin once it has
 * been sent for review or rejected, nobody once it is approved (except an Admin removing
 * a broken approved leftover that has no deployment); what pointed at it is cleaned up.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import Client from '../clients/client.model.js';
import Mobilisation from './mobilisation.model.js';
import SubcontractorTransfer from '../subcontractorTransfers/subcontractorTransfer.model.js';
import Notification from '../notifications/notification.model.js';
import Deployment from '../deployments/deployment.model.js';
import { deleteMobilisation, getMobilisation } from './mobilisation.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let serial = 0;

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id, ip: '127.0.0.1' };
}

async function mobilisation(owner, status = 'Draft', extra = {}) {
  const client = await Client.create({ companyName: `Client ${unique()}` });
  return Mobilisation.create({
    serialNumber: `MOB-D${Date.now()}${serial++}`,
    workerType: 'Freelancer',
    workerName: `Worker ${unique()}`,
    jobTitle: 'Helper',
    client: client._id,
    clientName: client.companyName,
    mobilisationDate: new Date(),
    status,
    createdBy: owner.id,
    coordinators: [{ user: owner.id, isPrimary: true, confirmed: true }],
    ...extra,
  });
}

describe('deleting a mobilisation before approval', () => {
  it('lets a coordinator on a Draft delete it, and the detail says so', async () => {
    const coordinator = await login('Coordinator');
    const draft = await mobilisation(coordinator);

    expect((await getMobilisation(draft._id, coordinator)).canDelete).toBe(true);
    await deleteMobilisation(draft._id, coordinator);

    expect(await Mobilisation.findById(draft._id)).toBeNull();
  });

  it('refuses someone who is not on the Draft', async () => {
    const owner = await login('Coordinator');
    const other = await login('Coordinator');
    const draft = await mobilisation(owner);

    await expect(deleteMobilisation(draft._id, other)).rejects.toMatchObject({ statusCode: 403 });
    expect(await Mobilisation.findById(draft._id)).not.toBeNull();
  });

  it('leaves a submitted or rejected one to Admin', async () => {
    const coordinator = await login('Coordinator');
    const admin = await login('Admin');
    const pending = await mobilisation(coordinator, 'PendingReview');
    const rejected = await mobilisation(coordinator, 'Rejected');

    await expect(deleteMobilisation(pending._id, coordinator)).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteMobilisation(rejected._id, coordinator)).rejects.toMatchObject({ statusCode: 403 });
    await deleteMobilisation(pending._id, admin);
    await deleteMobilisation(rejected._id, admin);

    expect(await Mobilisation.countDocuments({ _id: { $in: [pending._id, rejected._id] } })).toBe(0);
  });

  it('never deletes an approved one that has a deployment, not even for Admin', async () => {
    const admin = await login('Admin');
    const approved = await mobilisation(admin, 'Approved');
    await Deployment.create({
      mobilisation: approved._id,
      workerType: 'Freelancer',
      workerName: approved.workerName,
      client: approved.client,
      clientName: approved.clientName,
      startDate: new Date(),
    });

    await expect(deleteMobilisation(approved._id, admin)).rejects.toMatchObject({ statusCode: 409 });
    expect(await Mobilisation.findById(approved._id)).not.toBeNull();
  });

  it('lets Admin, and only Admin, remove an approved leftover that has no deployment', async () => {
    const admin = await login('Admin');
    const coordinator = await login('Coordinator');
    const leftover = await mobilisation(coordinator, 'Approved');
    const candidateId = new mongoose.Types.ObjectId();
    const requirementId = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('requirements').insertOne({
      _id: requirementId,
      serialNumber: `REQ-${unique()}`,
      clientName: 'Any',
      candidates: [{ _id: candidateId, workerName: 'Candidate', status: 'Mobilised', mobilisation: leftover._id }],
    });

    await expect(deleteMobilisation(leftover._id, coordinator)).rejects.toMatchObject({ statusCode: 403 });
    await deleteMobilisation(leftover._id, admin);

    expect(await Mobilisation.findById(leftover._id)).toBeNull();
    const requirement = await mongoose.connection.collection('requirements').findOne({ _id: requirementId });
    expect(requirement.candidates[0]).toMatchObject({ mobilisation: null, status: 'DocsReady' });
  });

  it('frees the requirement candidate and removes its transfer request and notifications', async () => {
    const coordinator = await login('Coordinator');
    const draft = await mobilisation(coordinator);
    const candidateId = new mongoose.Types.ObjectId();
    const requirementId = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('requirements').insertOne({
      _id: requirementId,
      serialNumber: `REQ-${unique()}`,
      clientName: 'Any',
      candidates: [{ _id: candidateId, workerName: 'Candidate', mobilisation: draft._id }],
    });
    await SubcontractorTransfer.collection.insertOne({ mobilisation: draft._id, status: 'Pending' });
    await Notification.collection.insertOne({ user: coordinator.id, title: 'Waiting', url: `/mobilisations/${draft._id}` });

    await deleteMobilisation(draft._id, coordinator);

    const requirement = await mongoose.connection.collection('requirements').findOne({ _id: requirementId });
    expect(requirement.candidates[0].mobilisation).toBeNull();
    expect(await SubcontractorTransfer.collection.countDocuments({ mobilisation: draft._id })).toBe(0);
    expect(await Notification.collection.countDocuments({ url: `/mobilisations/${draft._id}` })).toBe(0);
  });
});

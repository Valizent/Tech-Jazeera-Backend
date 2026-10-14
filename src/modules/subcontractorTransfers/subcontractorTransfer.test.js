/**
 * subcontractorTransfer.test.js - moving a subcontractor's employee to another
 * subcontractor (2026-10-12): when a request is raised, who may decide it, what
 * approving and rejecting do, and that the final approval waits.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import OutsourcedEmployee from '../employees/outsourcedEmployee.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Notification from '../notifications/notification.model.js';
import SubcontractorTransfer from './subcontractorTransfer.model.js';
import { createMobilisation, lookupWorkerByIqama, updateMobilisation } from '../mobilisations/mobilisation.service.js';
import { decideTransferSchema } from './subcontractorTransfer.validation.js';
import {
  assertNoPendingTransfer,
  decideTransfer,
  knownSubcontractorFor,
  listTransfers,
  transferSummaryFor,
} from './subcontractorTransfer.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const iqama = () => String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
const adminActor = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });

let secretary;
let mm;
let outsider;
let client;

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id };
}

// The test database is emptied between tests, so the actors and the workflow are rebuilt each time.
beforeEach(async () => {
  [secretary, mm, outsider] = await Promise.all([login('Office Secretary'), login('Manager'), login('Coordinator')]);
  const stepZero = await ApprovalRole.create({ name: `Secretaries ${unique()}`, members: [secretary.id] });
  const finalStep = await ApprovalRole.create({ name: `Marketing Managers ${unique()}`, members: [mm.id] });
  await ApprovalWorkflow.create({
    name: `Mobilisation flow ${unique()}`,
    appliesTo: ['Mobilisation'],
    steps: [
      { label: 'Office Secretary', roles: [stepZero._id] },
      { label: 'Marketing Manager', roles: [finalStep._id] },
    ],
  });
  client = await Client.create({ companyName: `Client ${unique()}` });
});

/** A person on record with subcontractor A, and a new mobilisation putting him with B. */
async function scenario({ wanted = true, chooseSame = false } = {}) {
  const [subA, subB] = await Promise.all([
    Subcontractor.create({ name: `Sub A ${unique()}` }),
    Subcontractor.create({ name: `Sub B ${unique()}` }),
  ]);
  const number = iqama();
  await OutsourcedEmployee.create({
    name: 'Known Person',
    workerType: 'SupplierEmployee',
    subcontractor: subA._id,
    iqamaNumber: number,
    createdBy: new mongoose.Types.ObjectId(),
  });
  const mobilisation = await createMobilisation(
    {
      workerType: 'SupplierEmployee',
      workerName: 'Known Person',
      iqamaNumber: number,
      jobTitle: 'Helper',
      client: String(client._id),
      clientRate: 30,
      subcontractor: String(chooseSame ? subA._id : subB._id),
      subcontractorRate: 20,
      mobilisationDate: new Date('2031-01-01'),
      requestSubcontractorTransfer: wanted,
    },
    adminActor()
  );
  return { subA, subB, number, mobilisation };
}

describe('raising a request', () => {
  it('knows the subcontractor from the register', async () => {
    const { subA, number } = await scenario({ wanted: false });
    expect(await knownSubcontractorFor(number)).toMatchObject({ id: String(subA._id) });
  });

  it('fills a person in from the register even when he was never mobilised', async () => {
    const sub = await Subcontractor.create({ name: `Sub ${unique()}` });
    const number = iqama();
    await OutsourcedEmployee.create({
      name: 'Register Only',
      workerType: 'SupplierEmployee',
      subcontractor: sub._id,
      iqamaNumber: number,
      phone: '0500000099',
      createdBy: new mongoose.Types.ObjectId(),
    });
    expect(await lookupWorkerByIqama(number)).toMatchObject({
      workerName: 'Register Only',
      phone: '0500000099',
      registeredSubcontractor: { id: String(sub._id), name: sub.name },
    });
    expect(await lookupWorkerByIqama(iqama())).toBeNull();
  });

  it('creates one pending request when the answer is yes and the subcontractor differs', async () => {
    const { subA, subB, mobilisation } = await scenario();
    const requests = await SubcontractorTransfer.find({ mobilisation: mobilisation._id }).lean();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: 'Pending', from: { name: subA.name }, to: { name: subB.name } });
    expect(await Notification.countDocuments({ user: mm.id, url: '/subcontractor-transfers' })).toBeGreaterThan(0);
    expect(await transferSummaryFor(mobilisation._id)).toMatchObject({ status: 'Pending', fromName: subA.name, toName: subB.name });
  });

  it('creates nothing when the answer is no, or when he is already with that subcontractor', async () => {
    const declined = await scenario({ wanted: false });
    expect(await SubcontractorTransfer.countDocuments({ mobilisation: declined.mobilisation._id })).toBe(0);
    const same = await scenario({ chooseSame: true });
    expect(await SubcontractorTransfer.countDocuments({ mobilisation: same.mobilisation._id })).toBe(0);
  });

  it('withdraws the request when the coordinator answers no later, or changes the subcontractor', async () => {
    const { mobilisation } = await scenario();
    await updateMobilisation(String(mobilisation._id), { requestSubcontractorTransfer: false }, adminActor());
    expect((await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id }).lean()).status).toBe('Cancelled');

    const second = await scenario();
    const another = await Subcontractor.create({ name: `Sub C ${unique()}` });
    await updateMobilisation(String(second.mobilisation._id), { subcontractor: String(another._id) }, adminActor());
    expect((await SubcontractorTransfer.findOne({ mobilisation: second.mobilisation._id }).lean()).status).toBe('Cancelled');
  });
});

describe('the final approval waits', () => {
  it('is blocked while the request is pending and free once it is approved', async () => {
    const { mobilisation } = await scenario();
    await expect(assertNoPendingTransfer(mobilisation._id)).rejects.toMatchObject({ statusCode: 409 });
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    await decideTransfer(String(transfer._id), { decision: 'Approved' }, mm);
    await expect(assertNoPendingTransfer(mobilisation._id)).resolves.toBeUndefined();
  });
});

describe('deciding', () => {
  it('lets the final-step approver (and Admin) decide, not the first-step reviewer or a coordinator', async () => {
    const { mobilisation } = await scenario();
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    await expect(decideTransfer(String(transfer._id), { decision: 'Approved' }, secretary)).rejects.toMatchObject({ statusCode: 403 });
    await expect(decideTransfer(String(transfer._id), { decision: 'Approved' }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    const decided = await decideTransfer(String(transfer._id), { decision: 'Approved' }, mm);
    expect(decided.status).toBe('Approved');
  });

  it('approving moves him in the register', async () => {
    const { subB, number, mobilisation } = await scenario();
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    await decideTransfer(String(transfer._id), { decision: 'Approved' }, adminActor());
    const record = await OutsourcedEmployee.findOne({ iqamaNumber: number }).lean();
    expect(String(record.subcontractor)).toBe(String(subB._id));
    expect(await knownSubcontractorFor(number)).toMatchObject({ id: String(subB._id) });
  });

  it('rejecting sends a mobilisation in review back to the coordinators with the reason', async () => {
    const { mobilisation, subA, number } = await scenario();
    await Mobilisation.updateOne({ _id: mobilisation._id }, { $set: { status: 'PendingReview' } });
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    await decideTransfer(String(transfer._id), { decision: 'Rejected', decisionNote: 'Keep him with Sub A' }, mm);

    const after = await Mobilisation.findById(mobilisation._id).lean();
    expect(after.status).toBe('Rejected');
    expect(after.rejectionTarget).toBe('Both');
    expect(after.decisionNote).toContain('Keep him with Sub A');
    expect(String((await OutsourcedEmployee.findOne({ iqamaNumber: number }).lean()).subcontractor)).toBe(String(subA._id));
    await expect(assertNoPendingTransfer(mobilisation._id)).resolves.toBeUndefined();
  });

  it('a rejection must say why', () => {
    expect(decideTransferSchema.safeParse({ decision: 'Rejected' }).success).toBe(false);
    expect(decideTransferSchema.safeParse({ decision: 'Rejected', decisionNote: 'No' }).success).toBe(true);
    expect(decideTransferSchema.safeParse({ decision: 'Approved' }).success).toBe(true);
  });

  it('a decided request cannot be decided again', async () => {
    const { mobilisation } = await scenario();
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    await decideTransfer(String(transfer._id), { decision: 'Approved' }, mm);
    await expect(decideTransfer(String(transfer._id), { decision: 'Approved' }, mm)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listing', () => {
  it('shows everything to a decider and only their own requests to anyone else', async () => {
    const mine = adminActor();
    const [subA, subB] = await Promise.all([Subcontractor.create({ name: `Sub A ${unique()}` }), Subcontractor.create({ name: `Sub B ${unique()}` })]);
    const number = iqama();
    await OutsourcedEmployee.create({ name: 'Listed', workerType: 'SupplierEmployee', subcontractor: subA._id, iqamaNumber: number, createdBy: new mongoose.Types.ObjectId() });
    await createMobilisation(
      { workerType: 'SupplierEmployee', workerName: 'Listed', iqamaNumber: number, jobTitle: 'Helper', client: String(client._id), clientRate: 30, subcontractor: String(subB._id), mobilisationDate: new Date('2032-01-01'), requestSubcontractorTransfer: true },
      mine
    );
    const asDecider = await listTransfers({ status: 'Pending' }, mm);
    expect(asDecider.canDecide).toBe(true);
    expect(asDecider.items.length).toBeGreaterThan(0);
    const asOutsider = await listTransfers({ status: 'Pending' }, outsider);
    expect(asOutsider.canDecide).toBe(false);
    expect(asOutsider.items).toHaveLength(0);
    const asRequester = await listTransfers({ status: 'Pending' }, { ...mine, role: 'Coordinator' });
    expect(asRequester.items.length).toBe(1);
  });
});

describe('with a Subcontractor Transfer hierarchy set up (2026-10-14)', () => {
  it('walks its own steps instead of the Mobilisation final step, and shows who may decide it now', async () => {
    const [stepOne, stepTwo] = await Promise.all([login('Manager'), login('Executive')]);
    const [r1, r2] = await Promise.all([
      ApprovalRole.create({ name: `Transfer one ${unique()}`, members: [stepOne.id] }),
      ApprovalRole.create({ name: `Transfer two ${unique()}`, members: [stepTwo.id] }),
    ]);
    await ApprovalWorkflow.create({
      name: `Transfer flow ${unique()}`,
      appliesTo: ['SubcontractorTransfer'],
      steps: [{ label: 'One', roles: [r1._id] }, { label: 'Two', roles: [r2._id] }],
    });
    const { subB, number, mobilisation } = await scenario();
    const transfer = await SubcontractorTransfer.findOne({ mobilisation: mobilisation._id });
    expect(transfer.steps).toHaveLength(2);
    expect(await Notification.countDocuments({ user: stepOne.id, url: '/subcontractor-transfers' })).toBeGreaterThan(0);

    // the Mobilisation final-step member (mm) is not in this hierarchy
    await expect(decideTransfer(String(transfer._id), { decision: 'Approved' }, mm)).rejects.toMatchObject({ statusCode: 403 });
    await expect(decideTransfer(String(transfer._id), { decision: 'Approved' }, stepTwo)).rejects.toMatchObject({ statusCode: 403 });

    const first = await decideTransfer(String(transfer._id), { decision: 'Approved' }, stepOne);
    expect(first).toMatchObject({ status: 'Pending', currentStep: 1 });
    expect((await OutsourcedEmployee.findOne({ iqamaNumber: number })).subcontractor.toString()).not.toBe(String(subB._id));

    const listed = await listTransfers({ status: 'Pending' }, stepTwo);
    expect(listed.items[0].canDecideCurrentStep).toBe(true);

    const final = await decideTransfer(String(transfer._id), { decision: 'Approved' }, stepTwo);
    expect(final.status).toBe('Approved');
    expect((await OutsourcedEmployee.findOne({ iqamaNumber: number })).subcontractor.toString()).toBe(String(subB._id));
  });
});

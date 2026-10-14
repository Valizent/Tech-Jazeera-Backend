/**
 * decisionHierarchy.test.js - the decisions brought onto the approval hierarchy on 2026-10-14: client approval,
 * client payment and monthly hours. With no hierarchy set up the original rule stands; with one, the request walks
 * its steps and only the members of the current step (or Admin) decide.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import Client from '../clients/client.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import ClientPayment from '../deployments/clientPayment.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow from './approvalWorkflow.model.js';
import { createClient, decideClient, listClients } from '../clients/client.service.js';
import { recordClientPaymentForInvoices, addMonthlyHours, decideMonthlyHours, getDeployment } from '../deployments/deployment.service.js';
import { decideClientPayment, getPendingPaymentsQueue } from '../deployments/clientPayment.service.js';
import { listApprovalLog } from './approvals.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const admin = () => ({ userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' });

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id, ip: '127.0.0.1' };
}

/** Two approvers, two roles, and an (optional) hierarchy of those two steps for one request type. */
async function twoSteps(requestType) {
  const [first, second, outsider] = await Promise.all([login('Manager'), login('Executive'), login('Manager')]);
  const [r1, r2] = await Promise.all([
    ApprovalRole.create({ name: `First ${unique()}`, members: [first.id] }),
    ApprovalRole.create({ name: `Second ${unique()}`, members: [second.id] }),
  ]);
  if (requestType) {
    await ApprovalWorkflow.create({
      name: `${requestType} ${unique()}`,
      appliesTo: [requestType],
      steps: [
        { label: 'Step one', roles: [r1._id] },
        { label: 'Step two', roles: [r2._id] },
      ],
    });
  }
  return { first, second, outsider, r1, r2 };
}

describe('client approval', () => {
  it('with no hierarchy the Admin still decides, and a Manager who is not the coordinator manager cannot', async () => {
    const coordinator = await login('Coordinator');
    const manager = await login('Manager');
    const client = await createClient({ companyName: `Client ${unique()}` }, coordinator);
    expect(client).toMatchObject({ approvalStatus: 'Pending', workflow: null });

    await expect(decideClient(String(client._id), { status: 'Approved' }, manager)).rejects.toMatchObject({ statusCode: 403 });
    const decided = await decideClient(String(client._id), { status: 'Approved' }, admin());
    expect(decided.approvalStatus).toBe('Approved');
  });

  it('walks its steps, refuses the wrong step, and ends on the last', async () => {
    const { first, second, outsider } = await twoSteps('ClientApproval');
    const coordinator = await login('Coordinator');
    const client = await createClient({ companyName: `Client ${unique()}` }, coordinator);
    expect(client.steps).toHaveLength(2);
    expect(client.workflowName).toMatch(/^ClientApproval/);

    await expect(decideClient(String(client._id), { status: 'Approved' }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    await expect(decideClient(String(client._id), { status: 'Approved' }, second)).rejects.toMatchObject({ statusCode: 403 });

    const afterFirst = await decideClient(String(client._id), { status: 'Approved' }, first);
    expect(afterFirst).toMatchObject({ approvalStatus: 'Pending', currentStep: 1 });
    const afterSecond = await decideClient(String(client._id), { status: 'Approved' }, second);
    expect(afterSecond.approvalStatus).toBe('Approved');
    expect(afterSecond.approvalTrail).toHaveLength(2);

    const listed = await listClients({ page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'desc', search: client.companyName }, second);
    expect(listed.items[0].approvalTrail[0].approvedBy.name).toMatch(/^Manager/);
  });

  it('a rejection at any step ends it, and the log shows it with its subject', async () => {
    const { first } = await twoSteps('ClientApproval');
    const coordinator = await login('Coordinator');
    const client = await createClient({ companyName: `Client ${unique()}` }, coordinator);
    const rejected = await decideClient(String(client._id), { status: 'Rejected', decisionNote: 'Incomplete papers' }, first);
    expect(rejected.approvalStatus).toBe('Rejected');

    const log = await listApprovalLog({ type: 'ClientApproval', page: 1, limit: 10 });
    expect(log.items[0]).toMatchObject({ requestType: 'ClientApproval', subject: client.companyName, status: 'Rejected' });
  });
});

describe('client payment', () => {
  async function paidClient() {
    const client = await Client.create({ companyName: `Client ${unique()}` });
    const mobilisation = await Mobilisation.create({
      serialNumber: `MOB-D${unique()}`,
      workerType: 'Freelancer',
      workerName: 'Billed Worker',
      jobTitle: 'Labour',
      client: client._id,
      clientName: client.companyName,
      clientRate: 10,
      otClientRate: 10,
      mobilisationDate: new Date('2026-01-01'),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    const sent = new Date(Date.UTC(2026, 5, 1));
    await Deployment.create({
      mobilisation: mobilisation._id,
      workerType: 'Freelancer',
      workerName: 'Billed Worker',
      client: client._id,
      clientName: client.companyName,
      startDate: new Date('2026-01-01'),
      monthlyHours: [
        {
          month: '2026-02',
          contractHours: 400,
          actualHours: 400,
          otHours: 0,
          enteredBy: new mongoose.Types.ObjectId(),
          status: 'Approved',
          invoiceSentAt: sent,
          invoiceNumber: 'INV-1',
          invoiceDate: sent,
          invoiceDueAt: sent,
        },
      ],
    });
    return String(client._id);
  }

  it('walks the hierarchy; the Section Access grant is the floor', async () => {
    const { first, second, outsider, r1, r2 } = await twoSteps('ClientPayment');
    await SectionAccess.create({ sectionKey: 'deploymentsPaymentDecide', writeApprovalRoles: [r1._id, r2._id] });
    const clientId = await paidClient();
    const payment = await recordClientPaymentForInvoices(clientId, { amount: 1000 }, admin());
    expect(payment.workflow).toBeTruthy();

    // not in the hierarchy (and without the grant) -> 403
    await expect(decideClientPayment(String(payment._id), { decision: 'Approved' }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    await expect(decideClientPayment(String(payment._id), { decision: 'Approved' }, second)).rejects.toMatchObject({ statusCode: 403 });

    const queueForFirst = await getPendingPaymentsQueue(first);
    expect(queueForFirst[0].canDecideCurrentStep).toBe(true);
    const queueForSecond = await getPendingPaymentsQueue(second);
    expect(queueForSecond[0].canDecideCurrentStep).toBe(false);

    await decideClientPayment(String(payment._id), { decision: 'Approved' }, first);
    expect((await ClientPayment.findById(payment._id)).decisionStatus).toBe('Pending');
    await decideClientPayment(String(payment._id), { decision: 'Approved' }, second);
    expect((await ClientPayment.findById(payment._id)).decisionStatus).toBe('Approved');
  });

  it('with no hierarchy it is decided exactly as before', async () => {
    const clientId = await paidClient();
    const payment = await recordClientPaymentForInvoices(clientId, { amount: 500 }, admin());
    expect(payment.workflow).toBeNull();
    const decided = await decideClientPayment(String(payment._id), { decision: 'Rejected', note: 'wrong client' }, admin());
    expect(decided).toMatchObject({ decisionStatus: 'Rejected', decisionNote: 'wrong client' });
  });
});

describe('monthly hours', () => {
  async function deployment() {
    const client = await Client.create({ companyName: `Client ${unique()}` });
    const mobilisation = await Mobilisation.create({
      serialNumber: `MOB-H${unique()}`,
      workerType: 'Freelancer',
      workerName: 'Hours Worker',
      jobTitle: 'Labour',
      client: client._id,
      clientName: client.companyName,
      clientRate: 10,
      otClientRate: 10,
      mobilisationDate: new Date('2026-01-01'),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    return Deployment.create({
      mobilisation: mobilisation._id,
      workerType: 'Freelancer',
      workerName: 'Hours Worker',
      client: client._id,
      clientName: client.companyName,
      startDate: new Date('2026-01-01'),
      requiredTimesheetHours: 200,
    });
  }

  it('an entry walks the hierarchy on its own, and shows who may decide it now', async () => {
    const { first, second, outsider } = await twoSteps('MonthlyHours');
    const dep = await deployment();
    const after = await addMonthlyHours(String(dep._id), { month: '2026-02', actualHours: 180 }, admin());
    const entryId = String(after.monthlyHours[0]._id);
    expect(after.monthlyHours[0].steps).toHaveLength(2);

    await expect(decideMonthlyHours(String(dep._id), entryId, { decision: 'Approved' }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    await decideMonthlyHours(String(dep._id), entryId, { decision: 'Approved' }, first);

    let seen = await getDeployment(String(dep._id), second);
    expect(seen.monthlyHours[0]).toMatchObject({ status: 'Pending', currentStep: 1 });
    expect(seen.monthlyHours[0].approvalTrail[0].approvedBy.name).toMatch(/^Manager/);

    const result = await decideMonthlyHours(String(dep._id), entryId, { decision: 'Approved' }, second);
    expect(result.monthlyHours[0].status).toBe('Approved');
    seen = await getDeployment(String(dep._id), admin());
    expect(seen.monthlyHours[0].status).toBe('Approved');
  });

  it('with no hierarchy a pending month is decided as before', async () => {
    const dep = await deployment();
    const after = await addMonthlyHours(String(dep._id), { month: '2026-03', actualHours: 150 }, admin());
    const entryId = String(after.monthlyHours[0]._id);
    const result = await decideMonthlyHours(String(dep._id), entryId, { decision: 'Rejected', note: 'recount' }, admin());
    expect(result.monthlyHours[0]).toMatchObject({ status: 'Rejected', decisionNote: 'recount' });
    // the same month cannot be decided twice
    await expect(decideMonthlyHours(String(dep._id), entryId, { decision: 'Approved' }, admin())).rejects.toMatchObject({ statusCode: 400 });
  });
});

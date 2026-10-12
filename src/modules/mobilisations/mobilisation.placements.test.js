/**
 * mobilisation.placements.test.js - the merged Mobilisations/Deployments list
 * (2026-10-12): every placement in one list, where each row says where its
 * deployment stands, filtered by site, and visible to the same people who could
 * open the old Deployments register without widening what they can read.
 */
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Mobilisation from './mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import { createMobilisation, getMobilisation, listMobilisations } from './mobilisation.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const iqama = () => String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
const LIST = { page: 1, limit: 50, sortBy: 'createdAt', sortOrder: 'desc' };

let admin;
let reader;
let secretary;
let stranger;
let finalApprover;
let viewerOnly;
let client;
let subcontractor;

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id, ip: '127.0.0.1' };
}

// The test database is emptied between tests, so everything is rebuilt each time.
beforeEach(async () => {
  [admin, reader, secretary, stranger, finalApprover, viewerOnly] = await Promise.all([
    login('Admin'),
    login('Manager'),
    login('Office Secretary'),
    login('Manager'),
    login('Manager'),
    login('Manager'),
  ]);
  const registerCircle = await ApprovalRole.create({ name: `Register ${unique()}`, members: [reader.id] });
  await SectionAccess.create({ sectionKey: 'deploymentsRelease', readApprovalRoles: [registerCircle._id] });
  const viewerCircle = await ApprovalRole.create({ name: `Viewers ${unique()}`, members: [viewerOnly.id] });
  await SectionAccess.create({ sectionKey: 'mobilisationsViewer', readApprovalRoles: [viewerCircle._id] });
  const stepZero = await ApprovalRole.create({ name: `Secretaries ${unique()}`, members: [secretary.id] });
  const finalStep = await ApprovalRole.create({ name: `Approvers ${unique()}`, members: [finalApprover.id] });
  await ApprovalWorkflow.create({
    name: `Mobilisation flow ${unique()}`,
    appliesTo: ['Mobilisation'],
    steps: [
      { label: 'Office Secretary', roles: [stepZero._id] },
      { label: 'Approver', roles: [finalStep._id] },
    ],
  });
  client = await Client.create({ companyName: `Client ${unique()}` });
  subcontractor = await Subcontractor.create({ name: `Sub ${unique()}` });
});

async function placement({ status = 'Approved', site = 'Jizan', deployment = status === 'Approved' || status === 'Completed' } = {}) {
  const created = await createMobilisation(
    {
      workerType: 'SupplierEmployee',
      workerName: `Worker ${unique()}`,
      iqamaNumber: iqama(),
      jobTitle: 'Helper',
      client: String(client._id),
      clientRate: 30,
      subcontractor: String(subcontractor._id),
      subcontractorRate: 20,
      site,
      mobilisationDate: new Date('2031-01-01'),
    },
    admin
  );
  await Mobilisation.updateOne({ _id: created._id }, { status, clientQuotation: 'QUO-1' });
  if (deployment) {
    await Deployment.create({
      mobilisation: created._id,
      workerType: 'SupplierEmployee',
      workerName: created.workerName,
      client: client._id,
      clientName: client.companyName,
      site,
      startDate: new Date('2031-01-01'),
      status: status === 'Completed' ? 'Ended' : 'Active',
      monthlyHours: [{ month: '2031-01', contractHours: 200, actualHours: 200, otHours: 0, enteredBy: admin.id }],
    });
  }
  return created;
}

describe('who sees an approved placement', () => {
  it('shows the register circle approved and ended placements, with where the deployment stands', async () => {
    const live = await placement();
    const ended = await placement({ status: 'Completed' });
    await placement({ status: 'Draft' });
    await placement({ status: 'PendingReview' });

    const { items, total } = await listMobilisations(LIST, reader);
    expect(total).toBe(2);
    expect(items.map((m) => String(m._id)).sort()).toEqual([String(live._id), String(ended._id)].sort());
    const liveRow = items.find((m) => String(m._id) === String(live._id));
    expect(liveRow.deployment).toMatchObject({ status: 'Active', monthlyHours: [{ month: '2031-01' }] });
    expect(items.find((m) => String(m._id) === String(ended._id)).deployment.status).toBe('Ended');
  });

  it('gives the register circle the identity it always had, not the rates, review paperwork or documents', async () => {
    await placement();
    const [row] = (await listMobilisations(LIST, reader)).items;
    expect(row).toMatchObject({ jobTitle: 'Helper' });
    for (const hidden of ['clientRate', 'subcontractorRate', 'clientQuotation', 'documents', 'approvalTrail']) {
      expect(row).not.toHaveProperty(hidden);
    }
  });

  it('shows an Office Secretary the approved placements too', async () => {
    const live = await placement();
    const { items } = await listMobilisations(LIST, secretary);
    expect(items.map((m) => String(m._id))).toEqual([String(live._id)]);
  });

  it('shows nothing to someone outside every circle', async () => {
    await placement();
    expect((await listMobilisations(LIST, stranger)).total).toBe(0);
  });

  it('does not point a viewer who cannot open deployments at a deployment', async () => {
    const live = await placement();
    const { items } = await listMobilisations(LIST, viewerOnly);
    const row = items.find((m) => String(m._id) === String(live._id));
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('deployment');
  });

  it('does not hand a former final-step reviewer the review fields on an approved row', async () => {
    const live = await placement();
    await Mobilisation.updateOne({ _id: live._id }, { $push: { coordinators: { user: finalApprover.id, confirmed: true } } });
    const [row] = (await listMobilisations(LIST, finalApprover)).items;
    expect(String(row._id)).toBe(String(live._id));
    expect(row).not.toHaveProperty('clientQuotation');
    expect(row).not.toHaveProperty('clientRate');
  });
});

describe('the placement page', () => {
  it('hands the deployment to someone who may open it, and only to them', async () => {
    const live = await placement();
    const forReader = await getMobilisation(String(live._id), reader);
    expect(forReader.deployment).toMatchObject({ status: 'Active' });
    const forViewer = await getMobilisation(String(live._id), viewerOnly);
    expect(forViewer.deployment).toBeUndefined();
  });

  it('opens an approved placement for the register circle with the reduced view, and nothing else', async () => {
    const live = await placement();
    const view = await getMobilisation(String(live._id), reader);
    for (const hidden of ['clientRate', 'subcontractorRate', 'clientQuotation', 'documents', 'approvalTrail']) {
      expect(view).not.toHaveProperty(hidden);
    }
    expect(view.canEditSection1).toBe(false);
    await expect(getMobilisation(String(live._id), stranger)).rejects.toMatchObject({ statusCode: 403 });
    const pending = await placement({ status: 'PendingReview' });
    await expect(getMobilisation(String(pending._id), reader)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('has no deployment before approval', async () => {
    const draft = await placement({ status: 'Draft' });
    expect((await getMobilisation(String(draft._id), admin)).deployment).toBeUndefined();
  });
});

describe('site', () => {
  it('filters by site, ignoring case', async () => {
    await placement({ site: 'Jizan Port' });
    await placement({ site: 'Abha' });
    const { items } = await listMobilisations({ ...LIST, site: 'jizan' }, admin);
    expect(items).toHaveLength(1);
    expect(items[0].site).toBe('Jizan Port');
  });

  it('treats the filter as plain text, not a pattern', async () => {
    await placement({ site: 'Abha' });
    await expect(listMobilisations({ ...LIST, site: '[' }, admin)).resolves.toMatchObject({ total: 0 });
  });

  it('sorts by site', async () => {
    await placement({ site: 'Yanbu' });
    await placement({ site: 'Abha' });
    const { items } = await listMobilisations({ ...LIST, sortBy: 'site', sortOrder: 'asc' }, admin);
    expect(items.map((m) => m.site)).toEqual(['Abha', 'Yanbu']);
  });
});

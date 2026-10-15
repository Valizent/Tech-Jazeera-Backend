/**
 * annualVacation.travel.test.js - the annual vacation flow: the days come from the contract HR set, HR may change
 * them at the HR step, any approver may attach documents and a remark while approving (they reach the next stage and,
 * on final approval, become the employee's restricted documents); the roles the workflow lists are told at
 * submission and at approval.
 */
import User from '../auth/user.model.js';
import Employee from '../employees/employee.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Notification from '../notifications/notification.model.js';
import AnnualVacationRequest from './annualVacation.model.js';
import { listDocuments, getDocument } from '../documents/document.service.js';
import Document from '../documents/document.model.js';
import {
  submitOwnAnnualVacation,
  changeVacationDays,
  decideAnnualVacation,
  listAnnualVacation,
  listOwnAnnualVacation,
} from './annualVacation.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const DAY = 86_400_000;
const inDays = (n) => new Date(Date.now() + n * DAY);
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

async function login(role) {
  const user = await User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
  return { userId: String(user._id), role, id: user._id, ip: '127.0.0.1' };
}

const ticket = (name = 'ticket.pdf') => ({ filename: `crm-documents/${unique()}`, originalname: name, mimetype: 'application/pdf', size: 1000 });

let hr;
let accounts;
let fm;
let marketingManager;
let employee;
let outsider;

beforeEach(async () => {
  [hr, accounts, fm, marketingManager, outsider] = await Promise.all([login('HR'), login('Accounts'), login('Manager'), login('Executive'), login('Accounts')]);
  const role = (name, member) => ApprovalRole.create({ name, members: [member.id] });
  const [hrRole, accountsRole, fmRole, mmRole] = await Promise.all([role('HR', hr), role('Accounts', accounts), role('FM', fm), role('MM', marketingManager)]);
  await ApprovalWorkflow.create({
    name: `Annual vacation ${unique()}`,
    appliesTo: ['AnnualVacation'],
    steps: [
      { label: 'HR', roles: [hrRole._id] },
      { label: 'Accounts', roles: [accountsRole._id] },
      { label: 'FM', roles: [fmRole._id] },
    ],
    notifyRoles: [mmRole._id],
  });
  await SectionAccess.create({ sectionKey: 'annualVacation', writeApprovalRoles: [hrRole._id, accountsRole._id, fmRole._id] });
  employee = await Employee.create({
    employeeId: `EMP-${unique()}`,
    fullName: 'Vacation Taker',
    type: 'Own',
    designation: 'Clerk',
    joiningDate: new Date('2023-01-01'),
    contractStartDate: new Date('2023-01-01'),
    contractEndDate: inDays(-5),
    annualVacationDays: 25,
  });
});

const submit = (extra = {}) => submitOwnAnnualVacation(employee._id, { startDate: inDays(30), ...extra }, { userId: String(employee._id), ip: '127.0.0.1' });

describe('the days and who is told', () => {
  it('uses the contract days whatever the client sends, and tells the informed role', async () => {
    const request = await submit({ requestedDays: 5 });

    expect(request.requestedDays).toBe(25);
    expect(request.contractDays).toBe(25);
    expect(dateOnly(request.endDate)).toBe(dateOnly(new Date(new Date(request.startDate).getTime() + 24 * DAY)));
    const told = await Notification.find({ user: marketingManager.id });
    expect(told).toHaveLength(1);
    expect(told[0].title).toContain('Vacation Taker');
  });

  it('refuses a request when HR has not set the contract days', async () => {
    await Employee.updateOne({ _id: employee._id }, { $set: { annualVacationDays: null } });
    await expect(submit()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets only the HR step change the days, and moves the last day', async () => {
    const request = await submit();

    await expect(changeVacationDays(request._id, { requestedDays: 30, note: 'asked in notes' }, accounts)).rejects.toMatchObject({ statusCode: 403 });
    const changed = await changeVacationDays(request._id, { requestedDays: 30, note: 'asked in notes' }, hr);

    expect(changed.requestedDays).toBe(30);
    expect(changed.daysChange).toMatchObject({ from: 25, to: 30, note: 'asked in notes' });
    expect(dateOnly(changed.endDate)).toBe(dateOnly(new Date(new Date(changed.startDate).getTime() + 29 * DAY)));
  });
});

describe('documents and remarks while approving', () => {
  async function atAccounts() {
    const request = await submit();
    await decideAnnualVacation(request._id, { status: 'Approved', decisionNote: 'Days are right' }, hr);
    return request;
  }

  it('keeps the files and the remark with the stage, and hands them on to FM', async () => {
    const request = await atAccounts();

    const after = await decideAnnualVacation(
      request._id,
      { status: 'Approved', decisionNote: 'Tickets for 5 Dec attached' },
      accounts,
      [ticket('out.pdf'), ticket('back.pdf')]
    );

    expect(after.currentStep).toBe(2);
    const stored = await AnnualVacationRequest.findById(request._id).lean();
    expect(stored.tickets.map((t) => t.originalName)).toEqual(['out.pdf', 'back.pdf']);
    expect(stored.tickets[0]).toMatchObject({ step: 1, stage: 'Accounts' });
    expect(stored.approvalTrail.map((e) => e.note)).toEqual(['Days are right', 'Tickets for 5 Dec attached']);

    // FM sees them with who attached them, and the remarks in the trail
    const { items } = await listAnnualVacation({ page: 1, limit: 10 }, fm);
    expect(items[0].tickets[0]).toMatchObject({ originalName: 'out.pdf', stage: 'Accounts' });
    expect(items[0].tickets[0].uploadedBy).toMatch(/^Accounts/);
    expect(items[0].tickets[0]).not.toHaveProperty('fileName');
    expect(items[0].canDecideCurrentStep).toBe(true);
  });

  it('refuses files with a rejection, and stores nothing for someone who may not decide the stage', async () => {
    const request = await submit();
    await expect(decideAnnualVacation(request._id, { status: 'Rejected' }, hr, [ticket()])).rejects.toMatchObject({ statusCode: 400 });
    await expect(decideAnnualVacation(request._id, { status: 'Approved' }, outsider, [ticket()])).rejects.toMatchObject({ statusCode: 403 });
    expect((await AnnualVacationRequest.findById(request._id).lean()).tickets).toHaveLength(0);
  });

  it('a failed decision takes the files off again', async () => {
    const request = await atAccounts();
    // Accounts is the current stage; FM is not
    await expect(decideAnnualVacation(request._id, { status: 'Approved' }, fm, [ticket()])).rejects.toMatchObject({ statusCode: 403 });
    expect((await AnnualVacationRequest.findById(request._id).lean()).tickets).toHaveLength(0);
  });

  it('on final approval the files become the employee restricted documents: only they and an Admin see them', async () => {
    const request = await atAccounts();
    await decideAnnualVacation(request._id, { status: 'Approved' }, accounts, [ticket('ticket.pdf')]);
    const done = await decideAnnualVacation(request._id, { status: 'Approved', decisionNote: 'Enjoy' }, fm, [ticket('visa-copy.pdf')]);
    expect(done.status).toBe('Approved');

    const documents = await Document.find({ owner: employee._id }).lean();
    expect(documents).toHaveLength(2);
    expect(documents.every((d) => d.restricted && d.ownerType === 'Employee' && d.source?.kind === 'AnnualVacation')).toBe(true);

    const asEmployee = { userId: 'x', role: 'Staff', employee: String(employee._id) };
    const asAdmin = { userId: 'a', role: 'Admin', employee: null };
    const asHr = { userId: String(hr.id), role: 'HR', employee: null };
    const query = { page: 1, limit: 20, ownerType: 'Employee', owner: String(employee._id) };
    expect((await listDocuments(query, asEmployee)).items).toHaveLength(2);
    expect((await listDocuments(query, asAdmin)).items).toHaveLength(2);
    expect((await listDocuments(query, asHr)).items).toHaveLength(0);
    await expect(getDocument(String(documents[0]._id), asHr)).rejects.toMatchObject({ statusCode: 404 });
    expect((await getDocument(String(documents[0]._id), asAdmin))._id).toBeTruthy();
  });
});

describe('own request list shows the approval stages', () => {
  it('returns the step role names and who decided each step', async () => {
    const request = await submit();
    await decideAnnualVacation(request._id, { status: 'Approved' }, hr);

    const { items } = await listOwnAnnualVacation(employee._id, { page: 1, limit: 10 });

    expect(items[0].steps.map((s) => s.label)).toEqual(['HR', 'Accounts', 'FM']);
    expect(items[0].steps[0].roles[0].name).toBe('HR');
    expect(items[0].approvalTrail[0].approvedBy.name).toBe(hr.userId ? (await User.findById(hr.userId)).name : '');
  });
});

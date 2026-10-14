/**
 * annualVacation.travel.test.js - the annual vacation flow of 2026-10-14: the days come from the contract HR set,
 * HR may change them at the HR step, Accounts attach the air tickets (which raises the re-entry visa request) and
 * upload the visa, then FM approves; the roles the workflow lists are told at submission and at approval.
 */
import User from '../auth/user.model.js';
import Employee from '../employees/employee.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import SectionAccess from '../sectionAccess/sectionAccess.model.js';
import Notification from '../notifications/notification.model.js';
import ExitReentryRequest from '../exitDocuments/exitReentry.model.js';
import LeaveRequest from '../leave/leaveRequest.model.js';
import AnnualVacationRequest from './annualVacation.model.js';
import {
  submitOwnAnnualVacation,
  changeVacationDays,
  attachTickets,
  uploadVisa,
  decideAnnualVacation,
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
  const role = (name, member) => ApprovalRole.create({ name: `${name} ${unique()}`, members: [member.id] });
  const [hrRole, accountsRole, fmRole, mmRole] = await Promise.all([role('HR', hr), role('Accounts', accounts), role('FM', fm), role('MM', marketingManager)]);
  await ApprovalWorkflow.create({
    name: `Annual vacation ${unique()}`,
    appliesTo: ['AnnualVacation'],
    steps: [
      { label: 'HR', roles: [hrRole._id], duty: 'HrReview' },
      { label: 'Accounts', roles: [accountsRole._id], duty: 'TravelDocuments' },
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

describe('Accounts: tickets, re-entry visa, then FM', () => {
  async function atAccounts() {
    const request = await submit();
    await decideAnnualVacation(request._id, { status: 'Approved' }, hr);
    return request;
  }

  it('raises a re-entry visa request from the travel day and waits for the visa document', async () => {
    const request = await atAccounts();
    const travel = inDays(30);

    await expect(attachTickets(request._id, [ticket()], { travelDate: travel }, outsider)).rejects.toMatchObject({ statusCode: 403 });
    const after = await attachTickets(request._id, [ticket()], { travelDate: travel }, accounts);

    const visa = await ExitReentryRequest.findById(after.visaRequest._id);
    expect(visa).toMatchObject({ status: 'Approved', visaType: 'Single', reason: 'Annual vacation' });
    expect(dateOnly(visa.departureDate)).toBe(dateOnly(travel));
    expect(dateOnly(visa.expectedReturnDate)).toBe(dateOnly(new Date(new Date(travel).getTime() + 25 * DAY))); // 26 days counting the travel day
    expect(after.tickets[0]).not.toHaveProperty('fileName');
    // not ready: the Accounts step cannot be approved by hand, and the request is still with Accounts
    await expect(decideAnnualVacation(request._id, { status: 'Approved' }, accounts)).rejects.toMatchObject({ statusCode: 400 });
    expect((await AnnualVacationRequest.findById(request._id)).currentStep).toBe(1);
  });

  it('moves on to FM by itself once the visa is uploaded, and FM approval records the leave and tells the informed role', async () => {
    const request = await atAccounts();
    await attachTickets(request._id, [ticket()], { travelDate: inDays(30) }, accounts);
    await uploadVisa(request._id, ticket('visa.pdf'), { visaReferenceNumber: 'V-123' }, accounts);

    const atFm = await AnnualVacationRequest.findById(request._id);
    expect(atFm.currentStep).toBe(2);
    expect(atFm.status).toBe('PendingReview');
    expect(await ExitReentryRequest.findById(atFm.visaRequest)).toMatchObject({ status: 'Issued', visaReferenceNumber: 'V-123' });

    await decideAnnualVacation(request._id, { status: 'Approved' }, fm);

    const done = await AnnualVacationRequest.findById(request._id);
    expect(done.status).toBe('Approved');
    const leave = await LeaveRequest.findById(done.linkedLeaveRequest);
    expect(leave.status).toBe('Approved');
    expect(String((await ExitReentryRequest.findById(done.visaRequest)).linkedLeaveRequest)).toBe(String(leave._id));
    const told = await Notification.find({ user: marketingManager.id });
    expect(told.map((n) => n.title).join(' ')).toContain('is going on annual leave');
  });
});

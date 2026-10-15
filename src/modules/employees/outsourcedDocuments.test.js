/**
 * outsourcedDocuments.test.js - an outsourced worker's documents: recorded by type with an expiry and a reminder
 * lead time (file optional), reminders to the worker's coordinators and then the Marketing Manager, and the expiry
 * tracker that lists every document with an expiry.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import Employee from './employee.model.js';
import OutsourcedEmployee from './outsourcedEmployee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Client from '../clients/client.model.js';
import Notification from '../notifications/notification.model.js';
import { addDocument, updateDocument } from './outsourcedEmployee.service.js';
import { outsourcedEmployeeDocumentBodySchema } from './outsourcedEmployee.validation.js';
import { runOutsourcedDocumentCheck, outsourcedDocumentStep } from '../notifications/outsourcedDocuments.job.js';
import { listExpiryTracker } from '../documents/expiryTracker.service.js';

const DAY = 86_400_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const inDays = (n) => new Date(Date.now() + n * DAY + 3_600_000);
const iqama = () => String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));

const login = (role) =>
  User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase().replace(/\s/g, '')}-${unique()}@example.com`, passwordHash: 'x', role });
const worker = (extra = {}) =>
  OutsourcedEmployee.create({ name: `Worker ${unique()}`, workerType: 'Freelancer', iqamaNumber: iqama(), createdBy: new mongoose.Types.ObjectId(), ...extra });
const actor = () => ({ userId: String(new mongoose.Types.ObjectId()), role: 'Admin', ip: '127.0.0.1' });

async function mobilised(w, coordinatorUser) {
  const client = await Client.create({ companyName: `Client ${unique()}` });
  return Mobilisation.create({
    serialNumber: `MOB-O${unique()}`,
    workerType: 'Freelancer',
    workerName: w.name,
    iqamaNumber: w.iqamaNumber,
    jobTitle: 'Labour',
    client: client._id,
    clientName: client.companyName,
    clientRate: 10,
    otClientRate: 10,
    mobilisationDate: new Date('2026-01-01'),
    createdBy: new mongoose.Types.ObjectId(),
    coordinators: [{ user: coordinatorUser._id, isPrimary: true, confirmed: true }],
  });
}

describe('recording a document', () => {
  it('needs no file, names itself by its type, and can be edited later', async () => {
    const w = await worker();
    const saved = await addDocument(String(w._id), null, { type: 'Ajeer', number: 'AJ-1', expiryDate: inDays(40), reminderDays: 45 }, actor());
    const doc = saved.documents[0];
    expect(doc).toMatchObject({ type: 'Ajeer', title: 'Ajeer', number: 'AJ-1', reminderDays: 45, fileName: null });

    const edited = await updateDocument(String(w._id), String(doc._id), null, { reminderDays: 10, expiryDate: inDays(90) }, actor());
    expect(edited.documents[0]).toMatchObject({ reminderDays: 10, title: 'Ajeer' });
  });

  it('asks for a name only when the type is Other', () => {
    expect(outsourcedEmployeeDocumentBodySchema.safeParse({ type: 'Other' }).success).toBe(false);
    expect(outsourcedEmployeeDocumentBodySchema.safeParse({ type: 'Other', title: 'Site pass' }).success).toBe(true);
    expect(outsourcedEmployeeDocumentBodySchema.safeParse({ type: 'Muqeem' }).success).toBe(true);
  });
});

describe('reminders', () => {
  it('step buckets: one at the start, weekly, daily, expired', () => {
    expect(outsourcedDocumentStep(25)).toBe('start');
    expect(outsourcedDocumentStep(10)).toBe('w2');
    expect(outsourcedDocumentStep(3)).toBe('d3');
    expect(outsourcedDocumentStep(-2)).toMatch(/^x/);
  });

  it('tells the coordinator inside the lead time, the MM in the last week, and never twice', async () => {
    const coordinator = await login('Coordinator');
    const mm = await login('Executive');
    await ApprovalRole.create({ name: 'MM', members: [mm._id] });
    const w = await worker();
    await mobilised(w, coordinator);
    await addDocument(String(w._id), null, { type: 'Muqeem', expiryDate: inDays(20), reminderDays: 30 }, actor());

    await runOutsourcedDocumentCheck();
    expect(await Notification.countDocuments({ user: coordinator._id })).toBe(1);
    expect(await Notification.countDocuments({ user: mm._id })).toBe(0);
    const again = await runOutsourcedDocumentCheck();
    expect(again.notificationsSent).toBe(0);

    // closer to the date: a new weekly step, and the MM joins
    await OutsourcedEmployee.updateOne({ _id: w._id }, { $set: { 'documents.0.expiryDate': inDays(6) } });
    await runOutsourcedDocumentCheck();
    expect(await Notification.countDocuments({ user: mm._id })).toBe(1);
  });

  it('a document outside its lead time is left alone; a worker with no coordinator goes straight to the MM', async () => {
    const mm = await login('Executive');
    await ApprovalRole.create({ name: 'MM', members: [mm._id] });
    const quiet = await worker();
    await addDocument(String(quiet._id), null, { type: 'Passport', expiryDate: inDays(100), reminderDays: 30 }, actor());
    const alone = await worker();
    await addDocument(String(alone._id), null, { type: 'Iqama', expiryDate: inDays(20), reminderDays: 30 }, actor());

    const result = await runOutsourcedDocumentCheck();

    expect(result.itemsFound).toBe(1);
    expect(await Notification.countDocuments({ user: mm._id })).toBe(1);
  });
});

describe('expiry tracker', () => {
  it('lists documents from every place with where each stands, and filters', async () => {
    await Employee.create({
      employeeId: `EMP-${unique()}`,
      fullName: 'Tracked Person',
      type: 'Own',
      designation: 'Clerk',
      joiningDate: new Date('2023-01-01'),
      passport: { number: 'P1', expiry: inDays(-5) },
      iqama: { number: '1', expiry: inDays(400) },
      additionalDocuments: [{ name: 'Safety card', expiry: inDays(20) }],
    });
    const w = await worker();
    await addDocument(String(w._id), null, { type: 'Ajeer', expiryDate: inDays(10), reminderDays: 30 }, actor());

    const all = await listExpiryTracker({}, { role: 'Admin', userId: 'a' });
    const names = all.items.map((i) => `${i.source}:${i.name}:${i.status}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'EmployeeIdentity:Passport:Expired',
        'EmployeeIdentity:Iqama:Valid',
        'EmployeeExtra:Safety card:Expiring',
        'Outsourced:Ajeer:Expiring',
      ])
    );
    expect(all.items[0].name).toBe('Passport'); // soonest (already expired) first
    expect(all.items.every((i) => !('number' in i))).toBe(true);

    const expiring = await listExpiryTracker({ status: 'Expiring' }, { role: 'Admin', userId: 'a' });
    expect(expiring.items.every((i) => i.status === 'Expiring')).toBe(true);
    expect(expiring.counts.Expired).toBe(1);
    const outsourcedOnly = await listExpiryTracker({ ownerType: 'Outsourced' }, { role: 'Admin', userId: 'a' });
    expect(outsourcedOnly.items.map((i) => i.name)).toEqual(['Ajeer']);
  });
});

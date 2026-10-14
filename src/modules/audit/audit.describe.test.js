/**
 * audit.describe.test.js - the Security Log's Details in plain words
 * (2026-10-14): what was deleted or changed is said in a sentence, names are
 * looked up, and technical ids never show.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import User from '../auth/user.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import { describeEntries } from './audit.describe.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const entry = (extra) => ({ _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...extra });
const describe1 = async (extra) => (await describeEntries([entry(extra)]))[0].description;

describe('audit descriptions', () => {
  it('says what a deleted mobilisation was', async () => {
    const lines = await describe1({
      action: 'mobilisation.delete',
      targetType: 'Mobilisation',
      meta: { serialNumber: 'MOB-0082', workerName: 'Hassan', status: 'PendingReview' },
    });
    expect(lines[0]).toBe('Deleted mobilisation MOB-0082 for Hassan.');
    expect(lines.join(' ')).toContain('Pending review');
  });

  it('names the removed document and the mobilisation it belonged to', async () => {
    const client = await Client.create({ companyName: `Client ${unique()}` });
    const mobilisation = await Mobilisation.create({
      serialNumber: `MOB-A${Date.now()}`,
      workerType: 'Freelancer',
      workerName: 'Hassan',
      jobTitle: 'Fitter',
      client: client._id,
      clientName: client.companyName,
      mobilisationDate: new Date(),
      createdBy: new mongoose.Types.ObjectId(),
      coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
    });
    const [line] = await describe1({
      action: 'mobilisation.documents.remove',
      targetType: 'Mobilisation',
      targetId: mobilisation._id,
      meta: { fileId: String(new mongoose.Types.ObjectId()), documentName: 'passport.pdf', category: 'IDCopy' },
    });
    expect(line).toContain('passport.pdf');
    expect(line).toContain(mobilisation.serialNumber);
    expect(line).toContain('Hassan');
    expect(line).not.toMatch(/[0-9a-f]{24}/);
  });

  it('looks up the person removed from a mobilisation', async () => {
    const person = await User.create({ name: 'Sarmad Shabir', email: `s-${unique()}@example.com`, passwordHash: 'x', role: 'Coordinator' });
    const [line] = await describe1({ action: 'mobilisation.coordinator.remove', meta: { removedUser: String(person._id) } });
    expect(line).toContain('Sarmad Shabir');
  });

  it('describes an access change with the module name, not its key', async () => {
    const lines = await describe1({
      action: 'sectionAccess.update',
      meta: { sectionKey: 'employeeFinancial', readApprovalRoleCount: 3, writeApprovalRoleCount: 0, readAllStaff: false, writeAllStaff: false, exceptRoleCount: 0 },
    });
    expect(lines.join(' ')).not.toContain('employeeFinancial');
    expect(lines[1]).toContain('3');
  });

  it('shows an employee edit as before and after', async () => {
    const lines = await describe1({
      action: 'employee.update',
      meta: { employeeId: 'EMP-1', fullName: 'Babu Ram', fields: ['designation'], changes: { designation: { from: 'Fitter', to: 'Foreman' } } },
    });
    expect(lines).toEqual(['Updated employee Babu Ram (EMP-1).', 'Designation: Fitter → Foreman']);
  });

  it('falls back to labelled facts and leaves ids out', async () => {
    const lines = await describe1({
      action: 'something.new',
      meta: { serialNumber: 'X-1', hasLogin: true, ownerId: String(new mongoose.Types.ObjectId()), when: '2026-10-14' },
    });
    expect(lines).toEqual(['Serial number: X-1', 'Has login: Yes', 'When: 14 Oct 2026']);
  });
});

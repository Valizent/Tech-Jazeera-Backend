/**
 * companyProfile.test.js - the shared client/subcontractor company profile
 * (2026-10-12): the National Address and person validation, what counts as
 * "missing", and that the same rules hold for both kinds of company.
 */
import mongoose from 'mongoose';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import Document from '../documents/document.model.js';
import { createClientSchema } from '../clients/client.validation.js';
import { createSubcontractorSchema } from '../subcontractors/subcontractor.validation.js';
import { missingDetails, withMissingDetails } from './companyProfile.service.js';
import { createClient, getClient, listClients } from '../clients/client.service.js';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const person = { name: 'Aisha Khan', position: 'Manager', phone: '+966500000001', email: 'aisha@example.com' };
const address = { buildingNumber: '1234', streetName: 'King Fahd Rd', district: 'Olaya', city: 'Riyadh', postalCode: '12211', additionalNumber: '5678' };
const complete = {
  arabicName: 'شركة الاختبار',
  crNumber: '1010123456',
  crExpiry: new Date('2030-01-01'),
  contactPerson: person.name,
  contactPosition: person.position,
  phone: person.phone,
  email: person.email,
  financePerson: person,
  owner: person,
  nationalAddress: address,
  coordinators: [{ name: 'Omar' }],
};
const docs = [
  { category: 'Agreement', expiryDate: new Date('2027-01-01') },
  { category: 'Commercial Registration', expiryDate: new Date('2027-01-01') },
  { category: 'National Address', expiryDate: null },
];

describe('what counts as missing', () => {
  it('lists everything for an empty company, letterhead never included', () => {
    expect(missingDetails({}, [])).toEqual([
      'arabicName', 'crNumber', 'crExpiry', 'nationalAddress', 'contact', 'finance', 'owner', 'coordinators',
      'agreementDocument', 'crDocument', 'nationalAddressDocument',
    ]);
  });

  it('is empty for a complete company', () => {
    expect(missingDetails(complete, docs)).toEqual([]);
  });

  it('needs the full national address, but not the unit number or short address', () => {
    const noDistrict = { ...complete, nationalAddress: { ...address, district: '' } };
    expect(missingDetails(noDistrict, docs)).toEqual(['nationalAddress']);
  });

  it('needs every field of each person', () => {
    const noPosition = { ...complete, financePerson: { ...person, position: '' }, contactPosition: '' };
    expect(missingDetails(noPosition, docs)).toEqual(['contact', 'finance']);
  });

  it('needs an expiry date on the agreement and the CR document, not on the national address one', () => {
    const noDates = [
      { category: 'Agreement', expiryDate: null },
      { category: 'Commercial Registration' },
      { category: 'National Address' },
    ];
    expect(missingDetails(complete, noDates)).toEqual(['agreementDocument', 'crDocument']);
  });
});

describe('validation', () => {
  const base = { companyName: 'Acme Co' };

  it('accepts a company with none of the new details', () => {
    expect(createClientSchema.safeParse(base).success).toBe(true);
    expect(createSubcontractorSchema.safeParse({ name: 'Sub Co' }).success).toBe(true);
  });

  it('checks the national address shape for both kinds of company', () => {
    const bad = { nationalAddress: { buildingNumber: '12', postalCode: '1234', additionalNumber: 'abcd', shortAddress: 'XX1' } };
    for (const result of [createClientSchema.safeParse({ ...base, ...bad }), createSubcontractorSchema.safeParse({ name: 'Sub Co', ...bad })]) {
      expect(result.success).toBe(false);
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/Building number is 4 digits/);
      expect(messages).toMatch(/Postal code is 5 digits/);
      expect(messages).toMatch(/Additional number is 4 digits/);
      expect(messages).toMatch(/Short address/);
    }
  });

  it('upper-cases a short address and treats blank fields as not given', () => {
    const parsed = createClientSchema.parse({ ...base, nationalAddress: { shortAddress: 'rrrd2929', streetName: '' }, crExpiry: '' });
    expect(parsed.nationalAddress.shortAddress).toBe('RRRD2929');
    expect(parsed.nationalAddress.streetName).toBeUndefined();
    expect(parsed.crExpiry).toBeNull();
  });

  it('requires a name on each company coordinator', () => {
    const result = createClientSchema.safeParse({ ...base, coordinators: [{ name: '', phone: '+966500000002' }] });
    expect(result.success).toBe(false);
  });
});

describe('through the services', () => {
  it('a client saved bare shows everything missing, and fills in as details and documents arrive', async () => {
    const admin = { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin' };
    const created = await createClient({ companyName: `Bare ${unique()}` }, admin);
    const bare = await getClient(created._id);
    expect(bare.missingDetails).toContain('arabicName');
    expect(bare.missingDetails).toHaveLength(11);

    await Client.updateOne({ _id: created._id }, { $set: complete });
    await Document.create({ title: 'Agreement', category: 'Agreement', ownerType: 'Client', owner: created._id, expiryDate: new Date('2027-01-01'), versions: [{ version: 1, fileName: 'a', originalName: 'a.pdf', mimeType: 'application/pdf', size: 1 }] });
    const partial = await getClient(created._id);
    expect(partial.missingDetails).toEqual(['crDocument', 'nationalAddressDocument']);

    const list = await listClients({ page: 1, limit: 50, sortBy: 'createdAt', sortOrder: 'desc', search: bare.companyName });
    expect(list.items[0].missingDetails).toEqual(['crDocument', 'nationalAddressDocument']);
  });

  it('a subcontractor is judged by the same rules, from its own documents', async () => {
    const sub = await Subcontractor.create({ name: `Sub ${unique()}`, ...complete });
    const other = await Client.create({ companyName: `Other ${unique()}` });
    // A client's agreement must not count for the subcontractor.
    await Document.create({ title: 'Agreement', category: 'Agreement', ownerType: 'Client', owner: other._id, expiryDate: new Date('2027-01-01'), versions: [{ version: 1, fileName: 'b', originalName: 'b.pdf', mimeType: 'application/pdf', size: 1 }] });
    await Document.create({ title: 'CR', category: 'Commercial Registration', ownerType: 'Subcontractor', owner: sub._id, expiryDate: new Date('2027-01-01'), versions: [{ version: 1, fileName: 'c', originalName: 'c.pdf', mimeType: 'application/pdf', size: 1 }] });
    const result = await withMissingDetails('Subcontractor', sub.toObject());
    expect(result.missingDetails).toEqual(['agreementDocument', 'nationalAddressDocument']);
  });
});

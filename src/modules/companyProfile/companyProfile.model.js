/**
 * Company profile fields shared by Client and Subcontractor (2026-10-12).
 *
 * Both are "a company we deal with", so they carry the same compliance
 * details: Arabic name, CR expiry, Saudi National Address, a Finance person,
 * the Owner, and the people at that company we coordinate with. Defined once
 * here and spread into each model so the two can never drift apart.
 *
 * The existing flat `contactPerson` / `phone` / `email` on each model ARE the
 * "contact person" block (name, number, email); only `contactPosition` is new.
 * Reusing them keeps every stored record valid with no data migration.
 *
 * `coordinators` are embedded (they live and die with the company) and keep
 * their own `_id` so a mobilisation can later point at one stably. They are
 * people at the client/subcontractor, not to be confused with OUR own
 * coordinators on Mobilisation.coordinators.
 *
 * Everything here is optional at save time: a record may be saved incomplete
 * and is then flagged as missing details (companyProfile.service.js).
 */
import mongoose from 'mongoose';

/** The Saudi National Address (SPL) shape. */
const nationalAddressSchema = new mongoose.Schema(
  {
    buildingNumber: { type: String, trim: true }, // 4 digits
    streetName: { type: String, trim: true },
    district: { type: String, trim: true }, // neighbourhood
    city: { type: String, trim: true },
    postalCode: { type: String, trim: true }, // 5 digits
    additionalNumber: { type: String, trim: true }, // 4 digits
    unitNumber: { type: String, trim: true }, // optional
    shortAddress: { type: String, trim: true, uppercase: true }, // optional, e.g. RRRD2929
  },
  { _id: false }
);

/** A named person at the company: finance contact, owner. */
const personSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    position: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
  },
  { _id: false }
);

/** A coordinator at the company. Keeps its own _id (default). */
const companyCoordinatorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  designation: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Spread into a model's field list. */
export const companyProfileFields = {
  arabicName: { type: String, trim: true },
  crExpiry: { type: Date, default: null },
  contactPosition: { type: String, trim: true },
  financePerson: { type: personSchema, default: () => ({}) },
  owner: { type: personSchema, default: () => ({}) },
  nationalAddress: { type: nationalAddressSchema, default: () => ({}) },
  coordinators: { type: [companyCoordinatorSchema], default: [] },
  // Reminder bookkeeping, server-managed only (never in the Zod schemas):
  // when the record was first seen incomplete, and which reminders went out.
  missingDetailsSince: { type: Date, default: null },
  missingDetailsReminders: {
    creatorAt: { type: Date, default: null },
    bdmAt: { type: Date, default: null },
    managerAt: { type: Date, default: null }, // the latest of the repeating reminders
  },
};

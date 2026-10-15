import mongoose from 'mongoose';

/** What an outsourced worker's papers are called in the picker; "Other" takes a name typed by the user. */
export const OUTSOURCED_DOCUMENT_TYPES = [
  'Ajeer',
  'Muqeem',
  'Passport',
  'Iqama',
  'Medical',
  'Visa',
  'Driving License',
  'Insurance',
  'Contract',
  'Other',
];

// A document record (2026-10-15): what it is, its number and expiry, and how many days before the expiry
// the reminders start; the scanned file is optional and can be attached later. The file fields follow the
// app-wide private-storage pattern (private Cloudinary object + a signed URL minted per request).
const outsourcedEmployeeDocumentSchema = new mongoose.Schema({
  type: { type: String, enum: OUTSOURCED_DOCUMENT_TYPES, default: 'Other' },
  title: { type: String, required: true, trim: true, maxlength: 150 }, // the type's name, or the custom name for 'Other'
  number: { type: String, trim: true, maxlength: 80, default: null },
  expiryDate: { type: Date, default: null },
  // Reminders begin this many days before the expiry date.
  reminderDays: { type: Number, default: 30, min: 1, max: 365 },
  fileName: { type: String, default: null }, // Cloudinary public_id
  resourceType: { type: String, default: null }, // 'raw', from the upload middleware
  originalName: { type: String, default: null },
  mimeType: { type: String, default: null },
  size: { type: Number, default: null },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
});

const outsourcedEmployeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    workerType: { type: String, enum: ['Freelancer', 'SupplierEmployee'], required: true },
    subcontractor: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcontractor', default: null },
    // Same durable identity Mobilisation uses for these two worker types (see
    // mobilisation.service.js's lookupWorkerByIqama) — lets this record be
    // looked up/autofilled by Iqama the same way, and be recognized as the
    // same real person across both modules.
    iqamaNumber: { type: String, trim: true, default: null },
    nationality: { type: String, trim: true, default: null },
    phone: { type: String, trim: true, default: null },
    email: { type: String, trim: true, default: null },
    documents: { type: [outsourcedEmployeeDocumentSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 1000, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

outsourcedEmployeeSchema.index({ name: 1 });
outsourcedEmployeeSchema.index({ workerType: 1 });

export default mongoose.model('OutsourcedEmployee', outsourcedEmployeeSchema);

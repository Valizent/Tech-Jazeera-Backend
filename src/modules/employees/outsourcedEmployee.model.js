import mongoose from 'mongoose';

// Redesigned 2026-09-30 — this field existed since the module was first
// built but had no route or UI ever wired to it (found during a live audit).
// The original shape (`fileUrl`, no resourceType/mimeType/uploadedBy) assumed
// a directly-fetchable public URL, which is exactly the "every upload sat on
// a public CDN URL forever" problem middleware/upload.js's own doc comment
// describes fixing app-wide — so this is rebuilt to match that same
// established, secure pattern (private Cloudinary storage + a signed URL
// minted per request) rather than carried forward as-is. Safe to redesign
// outright: the collection has never had a real document on it.
const outsourcedEmployeeDocumentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 150 },
  fileName: { type: String, required: true }, // Cloudinary public_id
  resourceType: { type: String, required: true }, // 'raw', from the upload middleware
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  expiryDate: { type: Date, default: null },
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
    agreedRate: { type: Number, default: null, min: 0 },
    currency: { type: String, default: 'SAR' },
    documents: { type: [outsourcedEmployeeDocumentSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 1000, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

outsourcedEmployeeSchema.index({ name: 1 });
outsourcedEmployeeSchema.index({ workerType: 1 });

export default mongoose.model('OutsourcedEmployee', outsourcedEmployeeSchema);

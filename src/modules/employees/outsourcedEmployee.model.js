import mongoose from 'mongoose';

const outsourcedEmployeeDocumentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  fileUrl: { type: String, required: true }, // Cloudinary public_id or url
  originalName: { type: String, required: true },
  expiryDate: { type: Date, default: null },
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

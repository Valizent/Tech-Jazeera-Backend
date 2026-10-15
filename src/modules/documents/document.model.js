/**
 * Document — a titled file attached to an Employee or a Client, with
 * categories, an optional expiry date, and version history.
 *
 * Schema choices, justified:
 *  - `owner` uses a **dynamic reference** (`refPath: 'ownerType'`) so one
 *    collection serves both employee and client documents. ownerType tells
 *    Mongoose which model to populate against.
 *  - `versions` are EMBEDDED. A version is a stored file plus its metadata; it
 *    has no life outside its document and is only ever read together with it —
 *    the embed rule. The CURRENT version is simply the last element (versions
 *    are only ever appended, never reordered), so `versions.at(-1)` is current.
 *  - The stored file is referenced by `storage` + `fileName` (a disk UUID, or a
 *    Cloudinary public_id — see the field comments); `originalName` is kept
 *    only for display/download.
 */
import mongoose from 'mongoose';

export const DOCUMENT_OWNER_TYPES = ['Employee', 'Client', 'Subcontractor'];
export const DOCUMENT_CATEGORIES = [
  'Passport',
  'Visa',
  'Iqama',
  'Medical',
  'Driving License',
  'Contract',
  'Certificate',
  'Commercial Registration',
  'VAT Certificate',
  'Agreement',
  'National Address',
  'Letterhead',
  'Invoice',
  'Other',
];

/** One stored file. _id disabled — it's a value object, addressed by version. */
const versionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    /**
     * Where the bytes actually live.
     *   'local'      — a file under UPLOAD_DIR (everything predating Cloudinary)
     *   'cloudinary' — an object in the Cloudinary account
     * Defaults to 'local' so documents written before this field existed keep
     * resolving exactly as they did.
     */
    storage: { type: String, enum: ['local', 'cloudinary'], default: 'local' },
    /**
     * The storage KEY, not a URL: a UUID filename for 'local', Cloudinary's
     * `public_id` (stored verbatim, as returned) for 'cloudinary'.
     *
     * Deliberately never a delivery URL. Deriving the key by string-slicing a
     * URL is what made deletes silently fail, and storing a signed URL here
     * would leak a readable capability into every API response that includes
     * versions. See docs/SECURITY-AUDIT.md (C-1, C-2).
     */
    fileName: { type: String, required: true },
    /** Cloudinary resource_type ('raw'); null for local files. */
    resourceType: { type: String, default: null },
    originalName: { type: String, required: true }, // what the user uploaded
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: DOCUMENT_CATEGORIES, required: true },
    ownerType: { type: String, enum: DOCUMENT_OWNER_TYPES, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'ownerType' },
    expiryDate: { type: Date, default: null },
    // 2026-10-14: a document only its owning employee and an Admin may open (papers that came with an approved
    // annual vacation: air tickets and the like). Everyone else - including people with Documents access - gets
    // a plain "not found". Default false: every existing document is unchanged.
    restricted: { type: Boolean, default: false },
    // Where it came from, when it was not uploaded here: { kind: 'AnnualVacation', ref: <request id> }.
    source: {
      type: new mongoose.Schema({ kind: String, ref: mongoose.Schema.Types.ObjectId }, { _id: false }),
      default: undefined,
    },
    versions: { type: [versionSchema], required: true },
  },
  { timestamps: true }
);

// List/search a specific owner's documents; and expiry scans.
documentSchema.index({ ownerType: 1, owner: 1 });
documentSchema.index({ expiryDate: 1 });

export default mongoose.model('Document', documentSchema);

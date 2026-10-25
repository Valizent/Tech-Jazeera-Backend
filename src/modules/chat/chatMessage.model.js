/**
 * ChatMessage - one message in a conversation. A deleted message stays as a
 * tombstone (`deletedAt`) with its text and attachment removed, so the thread
 * still reads "Message deleted" instead of silently closing the gap.
 *
 * The attachment is stored the same way as every other private upload: the
 * Cloudinary public id plus the metadata needed to stream it back. A signed URL
 * is never stored (see middleware/upload.js).
 */
import mongoose from 'mongoose';

export const MAX_CHAT_BODY = 4000;

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    resourceType: { type: String, required: true },
    mimeType: { type: String, required: true },
    originalName: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, trim: true, maxlength: MAX_CHAT_BODY, default: '' },
    attachment: { type: attachmentSchema, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// ObjectIds grow with time, so _id is both the sort key and the paging cursor.
chatMessageSchema.index({ conversation: 1, _id: -1 });
chatMessageSchema.index({ createdAt: 1 }); // the retention job's scan

export default mongoose.model('ChatMessage', chatMessageSchema);

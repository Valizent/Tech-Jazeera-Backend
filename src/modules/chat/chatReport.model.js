/**
 * ChatReport - a member flagging a message. Reports are the ONLY route by which
 * anyone outside a conversation sees any of its content: a moderator (Section
 * Access `chatModeration`) reviews the reported message and either dismisses the
 * report or removes the message.
 */
import mongoose from 'mongoose';

export const REPORT_STATUSES = ['open', 'dismissed', 'removed'];

const chatReportSchema = new mongoose.Schema(
  {
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: REPORT_STATUSES, default: 'open' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

chatReportSchema.index({ message: 1, reporter: 1 }, { unique: true });
chatReportSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('ChatReport', chatReportSchema);

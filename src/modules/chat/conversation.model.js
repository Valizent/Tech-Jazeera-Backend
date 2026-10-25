/**
 * Conversation - a 1:1 or group chat between office staff logins (never Workers).
 *
 * Per-member state lives on the conversation itself: `unread` is a counter bumped
 * on every incoming message and reset when the member reads, so the nav badge is
 * one cheap aggregate instead of counting messages. `lastPushAt` is the push
 * throttle (chat.service.js), kept here so a conditional update claims it
 * atomically across PM2 processes.
 *
 * `revision` is bumped by every change anyone could see (a message, a delete, a
 * read, a membership change). The real-time layer watches this collection and
 * tells the members "something changed in this conversation"; it never carries
 * message content, clients re-fetch over the authenticated REST API.
 */
import mongoose from 'mongoose';

export const CONVERSATION_TYPES = ['direct', 'group'];
export const MEMBER_ROLES = ['member', 'admin'];

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: MEMBER_ROLES, default: 'member' },
    unread: { type: Number, default: 0, min: 0 },
    lastReadAt: { type: Date, default: null },
    lastPushAt: { type: Date, default: null },
  },
  { _id: false }
);

const lastMessageSchema = new mongoose.Schema(
  {
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    snippet: { type: String, default: '' },
    hasAttachment: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: CONVERSATION_TYPES, required: true },
    name: { type: String, trim: true, maxlength: 80, default: null },
    // Sorted member ids joined with ':' - set on direct chats only, so the same two
    // people can never end up with two separate 1:1 conversations.
    directKey: { type: String, default: undefined },
    members: { type: [memberSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessage: { type: lastMessageSchema, default: null },
    lastMessageAt: { type: Date, default: Date.now },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true }
);

conversationSchema.index({ directKey: 1 }, { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } });
conversationSchema.index({ 'members.user': 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);

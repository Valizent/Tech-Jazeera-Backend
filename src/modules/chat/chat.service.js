/**
 * Chat service - conversations, messages, unread counts, reports.
 *
 * Who can chat: every office staff login and Executive (never Worker/Staff
 * self-service logins). That floor is the router's (`requireStaffOrExecutive`);
 * the people one can ADD to a chat are re-checked here (`assertChatUsers`).
 *
 * Privacy: a conversation is visible to its members only. A non-member gets the
 * same 404 as a conversation that does not exist. The one exception is a
 * reported message, which a moderator can review (see the report functions).
 *
 * Every change anyone could see bumps `Conversation.revision` in the SAME write,
 * which is what the real-time layer watches (chat.socket.js). Messages are never
 * pushed over the socket, only "something changed in conversation X", so the
 * authenticated REST API stays the single place content is read.
 */
import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import User from '../auth/user.model.js';
import { STAFF_ROLES } from '../../middleware/rbac.js';
import { signedDownloadUrl, destroyDocumentFile, DOCUMENT_RESOURCE_TYPE } from '../../middleware/upload.js';
import { pushOnly } from '../notifications/notification.service.js';
import { logAudit } from '../audit/audit.service.js';
import Conversation from './conversation.model.js';
import ChatMessage from './chatMessage.model.js';
import ChatReport from './chatReport.model.js';
import { MAX_GROUP_MEMBERS } from './chat.validation.js';

export const CHAT_ROLES = [...STAFF_ROLES, 'Executive'];

const SNIPPET_LENGTH = 100;
// One push per member per conversation in this window: a burst of messages is one
// buzz, not twenty. Claimed with a conditional update so it holds across processes.
const PUSH_THROTTLE_MS = 30_000;
const DIRECTORY_LIMIT = 500;

const toObjectId = (id) => new mongoose.Types.ObjectId(id);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------------- */
/* Shaping                                                                    */
/* ------------------------------------------------------------------------- */

async function namesFor(ids) {
  const unique = [...new Set(ids.map(String))];
  const users = await User.find({ _id: { $in: unique } }).select('name').lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

function shapeConversation(conversation, me, names) {
  const mine = conversation.members.find((m) => String(m.user) === me);
  const last = conversation.lastMessage;
  return {
    id: String(conversation._id),
    type: conversation.type,
    name: conversation.name,
    members: conversation.members.map((m) => ({
      id: String(m.user),
      name: names.get(String(m.user)) ?? 'Former user',
      role: m.role,
    })),
    unread: mine?.unread ?? 0,
    lastMessage: last
      ? {
          id: String(last.message),
          senderId: String(last.sender),
          snippet: last.snippet,
          hasAttachment: last.hasAttachment,
          deleted: last.deleted,
          at: last.at,
        }
      : null,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  };
}

async function presentConversation(conversation, me) {
  const names = await namesFor(conversation.members.map((m) => m.user));
  return shapeConversation(conversation, me, names);
}

function shapeMessage(message, names) {
  const deleted = Boolean(message.deletedAt);
  return {
    id: String(message._id),
    conversationId: String(message.conversation),
    senderId: String(message.sender),
    senderName: names.get(String(message.sender)) ?? 'Former user',
    body: deleted ? '' : message.body,
    attachment:
      deleted || !message.attachment
        ? null
        : { name: message.attachment.originalName, mimeType: message.attachment.mimeType, size: message.attachment.size },
    deleted,
    createdAt: message.createdAt,
  };
}

/* ------------------------------------------------------------------------- */
/* Guards                                                                     */
/* ------------------------------------------------------------------------- */

async function assertChatUsers(ids) {
  if (ids.length === 0) return;
  const found = await User.countDocuments({ _id: { $in: ids }, isActive: true, role: { $in: CHAT_ROLES } });
  if (found !== ids.length) throw new ApiError(400, 'One or more of those people cannot be added to a chat.');
}

/** The conversation, if `userId` is a member; otherwise the same 404 as a missing one. */
async function loadMemberConversation(conversationId, userId) {
  const conversation = await Conversation.findOne({ _id: conversationId, 'members.user': userId });
  if (!conversation) throw new ApiError(404, 'Conversation not found.');
  return conversation;
}

function assertGroupAdmin(conversation, userId) {
  if (conversation.type !== 'group') throw new ApiError(400, 'A direct chat cannot be changed.');
  const mine = conversation.members.find((m) => String(m.user) === userId);
  if (mine.role !== 'admin') throw new ApiError(403, 'Only a group admin can change the group.');
}

/* ------------------------------------------------------------------------- */
/* Conversations                                                              */
/* ------------------------------------------------------------------------- */

export async function listConversations(me, { page, limit }) {
  const filter = { 'members.user': me };
  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Conversation.countDocuments(filter),
  ]);
  const names = await namesFor(items.flatMap((c) => c.members.map((m) => m.user)));
  return {
    items: items.map((c) => shapeConversation(c, me, names)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function createConversation(actor, { type, memberIds, name }) {
  const me = actor.userId;
  const others = memberIds.filter((id) => id !== me);

  if (type === 'direct') {
    if (others.length !== 1) throw new ApiError(400, 'Choose someone other than yourself to chat with.');
    await assertChatUsers(others);
    const directKey = [me, others[0]].sort().join(':');
    const existing = await Conversation.findOne({ directKey });
    if (existing) return presentConversation(existing, me);
    try {
      const created = await Conversation.create({
        type,
        directKey,
        members: [{ user: me }, { user: others[0] }],
        createdBy: me,
      });
      await logAudit({
        user: me,
        action: 'chat.conversation.create',
        targetType: 'Conversation',
        targetId: created._id,
        meta: { type, memberCount: 2 },
        ip: actor.ip,
      });
      return presentConversation(created, me);
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Two people opened the same chat at once: the other request won, use its conversation.
      return presentConversation(await Conversation.findOne({ directKey }), me);
    }
  }

  if (others.length < 1) throw new ApiError(400, 'Add at least one other member.');
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new ApiError(400, `A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  await assertChatUsers(others);
  const created = await Conversation.create({
    type,
    name,
    members: [{ user: me, role: 'admin' }, ...others.map((user) => ({ user }))],
    createdBy: me,
  });
  await logAudit({
    user: me,
    action: 'chat.conversation.create',
    targetType: 'Conversation',
    targetId: created._id,
    meta: { type, name, memberCount: others.length + 1 },
    ip: actor.ip,
  });
  return presentConversation(created, me);
}

export async function updateConversation(actor, conversationId, { name, addMemberIds = [], removeMemberIds = [] }) {
  const me = actor.userId;
  const conversation = await loadMemberConversation(conversationId, me);
  assertGroupAdmin(conversation, me);

  const memberIds = new Set(conversation.members.map((m) => String(m.user)));
  if (removeMemberIds.includes(me)) throw new ApiError(400, 'Use "Leave group" to remove yourself.');
  const toAdd = addMemberIds.filter((id) => !memberIds.has(id));
  const toRemove = removeMemberIds.filter((id) => memberIds.has(id));
  if (memberIds.size + toAdd.length - toRemove.length > MAX_GROUP_MEMBERS) {
    throw new ApiError(400, `A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  }
  await assertChatUsers(toAdd);

  if (name) conversation.name = name;
  for (const user of toAdd) conversation.members.push({ user });
  if (toRemove.length > 0) {
    conversation.members = conversation.members.filter((m) => !toRemove.includes(String(m.user)));
  }
  conversation.revision += 1;
  await conversation.save();

  await logAudit({
    user: me,
    action: 'chat.conversation.update',
    targetType: 'Conversation',
    targetId: conversation._id,
    meta: { name: conversation.name, renamed: Boolean(name), added: toAdd.length, removed: toRemove.length },
    ip: actor.ip,
  });
  return presentConversation(conversation, me);
}

export async function leaveConversation(actor, conversationId) {
  const me = actor.userId;
  const conversation = await loadMemberConversation(conversationId, me);
  if (conversation.type !== 'group') throw new ApiError(400, 'A direct chat cannot be left.');

  const groupName = conversation.name;
  const remaining = conversation.members.filter((m) => String(m.user) !== me);
  await logAudit({
    user: me,
    action: 'chat.conversation.leave',
    targetType: 'Conversation',
    targetId: conversation._id,
    meta: { name: groupName },
    ip: actor.ip,
  });

  if (remaining.length === 0) {
    await deleteConversationData(conversation._id);
    return { left: true };
  }
  // A group never ends up with nobody in charge.
  if (!remaining.some((m) => m.role === 'admin')) remaining[0].role = 'admin';
  conversation.members = remaining;
  conversation.revision += 1;
  await conversation.save();
  return { left: true };
}

async function deleteConversationData(conversationId) {
  const withFiles = await ChatMessage.find({ conversation: conversationId, attachment: { $ne: null } })
    .select('attachment')
    .lean();
  await removeStoredFiles(withFiles.map((m) => m.attachment));
  await Promise.all([
    ChatMessage.deleteMany({ conversation: conversationId }),
    ChatReport.deleteMany({ conversation: conversationId }),
    Conversation.deleteOne({ _id: conversationId }),
  ]);
}

/** Removes stored files; one failure is logged and never stops the rest. */
export async function removeStoredFiles(attachments) {
  await Promise.all(
    attachments.map((file) =>
      destroyDocumentFile(file.fileName, file.resourceType).catch((err) =>
        logger.error(`[chat] could not remove stored file ${file.fileName}: ${err.message}`)
      )
    )
  );
}

/* ------------------------------------------------------------------------- */
/* Messages                                                                   */
/* ------------------------------------------------------------------------- */

export async function listMessages(me, conversationId, { before, limit }) {
  await loadMemberConversation(conversationId, me);
  const filter = { conversation: conversationId };
  if (before) filter._id = { $lt: before };
  const found = await ChatMessage.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = found.length > limit;
  const page = found.slice(0, limit);
  const names = await namesFor(page.map((m) => m.sender));
  return {
    items: page.map((m) => shapeMessage(m, names)),
    hasMore,
    nextBefore: hasMore ? String(page.at(-1)._id) : null,
  };
}

export async function sendMessage(actor, conversationId, { body }, file) {
  const me = actor.userId;
  const conversation = await loadMemberConversation(conversationId, me);
  const text = body ?? '';
  if (!text && !file) throw new ApiError(400, 'Write a message or attach a file.');

  const message = await ChatMessage.create({
    conversation: conversation._id,
    sender: me,
    body: text,
    attachment: file
      ? {
          fileName: file.filename,
          resourceType: DOCUMENT_RESOURCE_TYPE,
          mimeType: file.mimetype,
          originalName: file.originalname,
          size: file.size,
        }
      : null,
  });

  const sentAt = message.createdAt;
  try {
    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          lastMessage: {
            message: message._id,
            sender: me,
            snippet: text.slice(0, SNIPPET_LENGTH),
            hasAttachment: Boolean(file),
            deleted: false,
            at: sentAt,
          },
          lastMessageAt: sentAt,
          'members.$[mine].unread': 0,
          'members.$[mine].lastReadAt': sentAt,
        },
        $inc: { revision: 1, 'members.$[others].unread': 1 },
      },
      { arrayFilters: [{ 'mine.user': toObjectId(me) }, { 'others.user': { $ne: toObjectId(me) } }] }
    );
  } catch (err) {
    // A message the conversation never heard about must not exist (its file is removed by the route).
    await ChatMessage.deleteOne({ _id: message._id });
    throw err;
  }

  const recipients = conversation.members.map((m) => String(m.user)).filter((id) => id !== me);
  pushToRecipients(conversation._id, recipients, actor.userName, sentAt);

  return shapeMessage(message.toObject(), new Map([[me, actor.userName]]));
}

/** At most one push per member per conversation per window; generic body (nothing of the message leaves the server). */
function pushToRecipients(conversationId, recipientIds, senderName, now) {
  const cutoff = new Date(now.getTime() - PUSH_THROTTLE_MS);
  for (const userId of recipientIds) {
    Conversation.updateOne(
      {
        _id: conversationId,
        members: {
          $elemMatch: { user: toObjectId(userId), $or: [{ lastPushAt: null }, { lastPushAt: { $lt: cutoff } }] },
        },
      },
      { $set: { 'members.$.lastPushAt': now } }
    )
      .then((result) => {
        if (result.modifiedCount === 1) {
          pushOnly(userId, { title: senderName, body: 'New message', url: `/chat/${conversationId}` });
        }
      })
      .catch((err) => logger.warn(`[chat] push throttle for ${userId} failed: ${err.message}`));
  }
}

export async function markRead(me, conversationId) {
  await loadMemberConversation(conversationId, me);
  await Conversation.updateOne(
    { _id: conversationId, members: { $elemMatch: { user: toObjectId(me), unread: { $gt: 0 } } } },
    { $set: { 'members.$.unread': 0, 'members.$.lastReadAt': new Date() }, $inc: { revision: 1 } }
  );
  return { unread: 0 };
}

export async function getUnreadCount(me) {
  const userId = toObjectId(me);
  const [row] = await Conversation.aggregate([
    { $match: { 'members.user': userId } },
    { $unwind: '$members' },
    { $match: { 'members.user': userId } },
    { $group: { _id: null, total: { $sum: '$members.unread' } } },
  ]);
  return { unreadCount: row?.total ?? 0 };
}

/** Takes a message's text and file away, leaving the tombstone, and tells the conversation. */
async function tombstone(message, deletedBy) {
  const file = message.attachment;
  message.set({ body: '', attachment: null, deletedAt: new Date(), deletedBy });
  await message.save();
  if (file) await removeStoredFiles([file]);
  await Conversation.updateOne({ _id: message.conversation }, [
    {
      $set: {
        revision: { $add: ['$revision', 1] },
        lastMessage: {
          $cond: [
            { $eq: ['$lastMessage.message', message._id] },
            { $mergeObjects: ['$lastMessage', { snippet: '', hasAttachment: false, deleted: true }] },
            '$lastMessage',
          ],
        },
      },
    },
  ]);
}

export async function deleteMessage(actor, messageId) {
  const message = await ChatMessage.findById(messageId);
  if (!message) throw new ApiError(404, 'Message not found.');
  await loadMemberConversation(message.conversation, actor.userId);
  if (String(message.sender) !== actor.userId) throw new ApiError(403, 'You can only delete your own messages.');
  if (message.deletedAt) throw new ApiError(404, 'Message not found.');

  await tombstone(message, actor.userId);
  await logAudit({
    user: actor.userId,
    action: 'chat.message.delete',
    targetType: 'Conversation',
    targetId: message.conversation,
    meta: {},
    ip: actor.ip,
  });
}

/** The caller's authorised file: a member of the conversation, on a message that still has one. */
export async function getMessageFile(actor, messageId) {
  const message = await ChatMessage.findById(messageId).lean();
  if (!message) throw new ApiError(404, 'Message not found.');
  await loadMemberConversation(message.conversation, actor.userId);
  return fileDataFor(message);
}

function fileDataFor(message) {
  if (message.deletedAt || !message.attachment) throw new ApiError(404, 'That file is no longer available.');
  const { fileName, resourceType, mimeType, originalName } = message.attachment;
  return { url: signedDownloadUrl(fileName, resourceType), mimeType, originalName };
}

/* ------------------------------------------------------------------------- */
/* Directory                                                                  */
/* ------------------------------------------------------------------------- */

/** Everyone the caller could start a chat with. Name and role only. */
export async function listDirectory(me, { q }) {
  const filter = { isActive: true, role: { $in: CHAT_ROLES }, _id: { $ne: me } };
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  const users = await User.find(filter).select('name role').sort({ name: 1 }).limit(DIRECTORY_LIMIT).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, role: u.role }));
}

/* ------------------------------------------------------------------------- */
/* Reports and moderation                                                     */
/* ------------------------------------------------------------------------- */

export async function reportMessage(actor, messageId, { reason }) {
  const message = await ChatMessage.findById(messageId).lean();
  if (!message || message.deletedAt) throw new ApiError(404, 'Message not found.');
  await loadMemberConversation(message.conversation, actor.userId);
  if (String(message.sender) === actor.userId) throw new ApiError(400, 'You cannot report your own message.');

  try {
    await ChatReport.create({
      message: message._id,
      conversation: message.conversation,
      reporter: actor.userId,
      sender: message.sender,
      reason: reason ?? '',
    });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'You have already reported this message.');
    throw err;
  }
  await logAudit({
    user: actor.userId,
    action: 'chat.message.report',
    targetType: 'Conversation',
    targetId: message.conversation,
    meta: { reason },
    ip: actor.ip,
  });
}

export async function listReports({ status, page, limit }) {
  const filter = { status };
  const [reports, total] = await Promise.all([
    ChatReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ChatReport.countDocuments(filter),
  ]);
  const [messages, conversations, names] = await Promise.all([
    ChatMessage.find({ _id: { $in: reports.map((r) => r.message) } }).lean(),
    Conversation.find({ _id: { $in: reports.map((r) => r.conversation) } }).select('type name').lean(),
    namesFor(reports.flatMap((r) => [r.reporter, r.sender, r.reviewedBy].filter(Boolean))),
  ]);
  const messageById = new Map(messages.map((m) => [String(m._id), m]));
  const conversationById = new Map(conversations.map((c) => [String(c._id), c]));

  return {
    items: reports.map((r) => {
      const message = messageById.get(String(r.message));
      const conversation = conversationById.get(String(r.conversation));
      return {
        id: String(r._id),
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reviewedByName: r.reviewedBy ? (names.get(String(r.reviewedBy)) ?? 'Former user') : null,
        reporterName: names.get(String(r.reporter)) ?? 'Former user',
        senderName: names.get(String(r.sender)) ?? 'Former user',
        conversationType: conversation?.type ?? null,
        conversationName: conversation?.name ?? null,
        message: message ? shapeMessage(message, names) : null,
      };
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getReportedMessageFile(reportId) {
  const report = await ChatReport.findById(reportId).lean();
  if (!report) throw new ApiError(404, 'Report not found.');
  const message = await ChatMessage.findById(report.message).lean();
  if (!message) throw new ApiError(404, 'That file is no longer available.');
  return fileDataFor(message);
}

export async function decideReport(actor, reportId, { action }) {
  const report = await ChatReport.findById(reportId);
  if (!report) throw new ApiError(404, 'Report not found.');
  if (report.status !== 'open') throw new ApiError(409, 'This report has already been decided.');

  const decidedAt = new Date();
  if (action === 'remove') {
    const message = await ChatMessage.findById(report.message);
    if (message && !message.deletedAt) await tombstone(message, actor.userId);
    // Every other open report on the same message is settled by the same removal.
    await ChatReport.updateMany(
      { message: report.message, status: 'open' },
      { status: 'removed', reviewedBy: actor.userId, reviewedAt: decidedAt }
    );
  } else {
    report.set({ status: 'dismissed', reviewedBy: actor.userId, reviewedAt: decidedAt });
    await report.save();
  }

  await logAudit({
    user: actor.userId,
    action: 'chat.report.decide',
    targetType: 'Conversation',
    targetId: report.conversation,
    meta: { action },
    ip: actor.ip,
  });
}

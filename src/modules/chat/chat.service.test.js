/**
 * chat.service.test.js - conversations, messages, unread counters, privacy
 * (a non-member sees nothing), reports and moderation, the push throttle.
 *
 * Storage and push are stubbed: nothing here talks to Cloudinary or a phone.
 */
import User from '../auth/user.model.js';
import Conversation from './conversation.model.js';
import ChatMessage from './chatMessage.model.js';
import ChatReport from './chatReport.model.js';
import * as upload from '../../middleware/upload.js';
import { pushOnly } from '../notifications/notification.service.js';
import {
  createConversation,
  updateConversation,
  leaveConversation,
  listConversations,
  listMessages,
  sendMessage,
  markRead,
  getUnreadCount,
  deleteMessage,
  getMessageFile,
  listDirectory,
  reportMessage,
  listReports,
  decideReport,
  getReportedMessageFile,
} from './chat.service.js';

vi.mock('../../middleware/upload.js', () => ({
  signedDownloadUrl: vi.fn((id) => `https://signed.example/${id}`),
  destroyDocumentFile: vi.fn().mockResolvedValue('ok'),
  DOCUMENT_RESOURCE_TYPE: 'raw',
}));
vi.mock('../notifications/notification.service.js', () => ({ pushOnly: vi.fn() }));

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function makeUser(role = 'HR', extra = {}) {
  const user = await User.create({
    name: `${role} ${unique()}`,
    email: `u-${unique()}@example.com`,
    passwordHash: 'x',
    role,
    ...extra,
  });
  return { id: user._id.toString(), actor: { userId: user._id.toString(), userName: user.name, role, ip: '127.0.0.1' } };
}

const pdf = (name = 'a.pdf') => ({ filename: `crm-documents/${unique()}`, mimetype: 'application/pdf', originalname: name, size: 1234 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversations', () => {
  it('opens one direct chat per pair, whoever starts it', async () => {
    const [a, b] = [await makeUser(), await makeUser('Manager')];
    const first = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const again = await createConversation(b.actor, { type: 'direct', memberIds: [a.id] });
    expect(again.id).toBe(first.id);
    expect(await Conversation.countDocuments()).toBe(1);
  });

  it('refuses a chat with yourself, a Worker, a Staff login or a deactivated user', async () => {
    const a = await makeUser();
    const worker = await makeUser('Worker');
    const staffSelfService = await makeUser('Staff');
    const inactive = await makeUser('HR', { isActive: false });
    await expect(createConversation(a.actor, { type: 'direct', memberIds: [a.id] })).rejects.toMatchObject({ statusCode: 400 });
    for (const other of [worker, staffSelfService, inactive]) {
      await expect(createConversation(a.actor, { type: 'direct', memberIds: [other.id] })).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('lets an Executive chat', async () => {
    const [a, exec] = [await makeUser(), await makeUser('Executive')];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [exec.id] });
    expect(conversation.members).toHaveLength(2);
  });

  it('makes the creator the admin of a group', async () => {
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    const group = await createConversation(a.actor, { type: 'group', name: 'Site team', memberIds: [b.id, c.id] });
    expect(group.members.find((m) => m.id === a.id).role).toBe('admin');
    expect(group.members.filter((m) => m.role === 'member')).toHaveLength(2);
  });

  it('shows a conversation to its members only', async () => {
    const [a, b, outsider] = [await makeUser(), await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    expect((await listConversations(outsider.id, { page: 1, limit: 50 })).items).toHaveLength(0);
    await expect(listMessages(outsider.id, conversation.id, { limit: 30 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(sendMessage(outsider.actor, conversation.id, { body: 'hi' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('only a group admin can rename or change members; nobody removes themselves that way', async () => {
    const [a, b, c, d] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const group = await createConversation(a.actor, { type: 'group', name: 'Team', memberIds: [b.id] });
    await expect(updateConversation(b.actor, group.id, { name: 'Mine' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateConversation(a.actor, group.id, { removeMemberIds: [a.id] })).rejects.toMatchObject({ statusCode: 400 });

    const updated = await updateConversation(a.actor, group.id, { name: 'Renamed', addMemberIds: [c.id, d.id], removeMemberIds: [b.id] });
    expect(updated.name).toBe('Renamed');
    expect(updated.members.map((m) => m.id).sort()).toEqual([a.id, c.id, d.id].sort());
    await expect(listMessages(b.id, group.id, { limit: 30 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cannot change a direct chat or leave it', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const direct = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    await expect(updateConversation(a.actor, direct.id, { name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(leaveConversation(a.actor, direct.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('promotes someone when the last admin leaves, and deletes the group (files too) when the last member leaves', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const group = await createConversation(a.actor, { type: 'group', name: 'Two', memberIds: [b.id] });
    await sendMessage(a.actor, group.id, {}, pdf());

    await leaveConversation(a.actor, group.id);
    const afterAdminLeft = await Conversation.findById(group.id);
    expect(afterAdminLeft.members).toHaveLength(1);
    expect(afterAdminLeft.members[0].role).toBe('admin');

    await leaveConversation(b.actor, group.id);
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await ChatMessage.countDocuments()).toBe(0);
    expect(upload.destroyDocumentFile).toHaveBeenCalledTimes(1);
  });
});

describe('messages and unread counts', () => {
  async function pair() {
    const [a, b] = [await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    return { a, b, conversation };
  }

  it('counts a message as unread for the others only, until they read', async () => {
    const { a, b, conversation } = await pair();
    await sendMessage(a.actor, conversation.id, { body: 'one' });
    await sendMessage(a.actor, conversation.id, { body: 'two' });

    expect(await getUnreadCount(a.id)).toEqual({ unreadCount: 0 });
    expect(await getUnreadCount(b.id)).toEqual({ unreadCount: 2 });

    await markRead(b.id, conversation.id);
    expect(await getUnreadCount(b.id)).toEqual({ unreadCount: 0 });
  });

  it('sums unread across conversations', async () => {
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    const ab = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const cb = await createConversation(c.actor, { type: 'direct', memberIds: [b.id] });
    await sendMessage(a.actor, ab.id, { body: 'x' });
    await sendMessage(c.actor, cb.id, { body: 'y' });
    await sendMessage(c.actor, cb.id, { body: 'z' });
    expect(await getUnreadCount(b.id)).toEqual({ unreadCount: 3 });
  });

  it('records the last message and bumps the revision the real-time layer watches', async () => {
    const { a, conversation } = await pair();
    const before = (await Conversation.findById(conversation.id)).revision;
    await sendMessage(a.actor, conversation.id, { body: 'hello there' });
    const stored = await Conversation.findById(conversation.id);
    expect(stored.revision).toBe(before + 1);
    expect(stored.lastMessage.snippet).toBe('hello there');
  });

  it('needs text or a file', async () => {
    const { a, conversation } = await pair();
    await expect(sendMessage(a.actor, conversation.id, { body: undefined })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('pages newest first with a cursor', async () => {
    const { a, conversation } = await pair();
    for (const body of ['m1', 'm2', 'm3']) await sendMessage(a.actor, conversation.id, { body });
    const first = await listMessages(a.id, conversation.id, { limit: 2 });
    expect(first.items.map((m) => m.body)).toEqual(['m3', 'm2']);
    expect(first.hasMore).toBe(true);
    const second = await listMessages(a.id, conversation.id, { limit: 2, before: first.nextBefore });
    expect(second.items.map((m) => m.body)).toEqual(['m1']);
    expect(second.hasMore).toBe(false);
  });

  it('sends at most one push per member inside the throttle window, with a generic body', async () => {
    const { a, b, conversation } = await pair();
    for (const body of ['1', '2', '3']) await sendMessage(a.actor, conversation.id, { body });
    await settle();
    expect(pushOnly).toHaveBeenCalledTimes(1);
    expect(pushOnly).toHaveBeenCalledWith(b.id, expect.objectContaining({ body: 'New message', url: `/chat/${conversation.id}` }));
  });
});

describe('attachments', () => {
  it('streams a file to members only, and not once the message is deleted', async () => {
    const [a, b, outsider] = [await makeUser(), await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const sent = await sendMessage(a.actor, conversation.id, { body: 'see file' }, pdf('plan.pdf'));
    expect(sent.attachment).toEqual({ name: 'plan.pdf', mimeType: 'application/pdf', size: 1234 });

    const file = await getMessageFile(b.actor, sent.id);
    expect(file).toMatchObject({ mimeType: 'application/pdf', originalName: 'plan.pdf' });
    expect(file.url).toContain('https://signed.example/');
    await expect(getMessageFile(outsider.actor, sent.id)).rejects.toMatchObject({ statusCode: 404 });

    await deleteMessage(a.actor, sent.id);
    await expect(getMessageFile(b.actor, sent.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(upload.destroyDocumentFile).toHaveBeenCalledTimes(1);
  });
});

describe('deleting a message', () => {
  it('only the sender can; the thread keeps a tombstone and the preview says deleted', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const sent = await sendMessage(a.actor, conversation.id, { body: 'oops' });

    await expect(deleteMessage(b.actor, sent.id)).rejects.toMatchObject({ statusCode: 403 });
    await deleteMessage(a.actor, sent.id);

    const { items } = await listMessages(b.id, conversation.id, { limit: 30 });
    expect(items[0]).toMatchObject({ deleted: true, body: '', attachment: null });
    const stored = await Conversation.findById(conversation.id);
    expect(stored.lastMessage).toMatchObject({ deleted: true, snippet: '' });
    await expect(deleteMessage(a.actor, sent.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('directory', () => {
  it('lists active chat-eligible people, never yourself, Workers or Staff logins', async () => {
    const me = await makeUser('Admin');
    const hr = await makeUser('HR', { name: 'Zainab Directory' });
    await makeUser('Worker');
    await makeUser('Staff');
    await makeUser('Manager', { isActive: false });
    const all = await listDirectory(me.id, {});
    expect(all.map((u) => u.id)).toEqual([hr.id]);
    expect(await listDirectory(me.id, { q: 'zain' })).toHaveLength(1);
    expect(await listDirectory(me.id, { q: 'nobody-by-this-name' })).toHaveLength(0);
  });
});

describe('reports and moderation', () => {
  async function reported() {
    const [a, b, moderator] = [await makeUser(), await makeUser(), await makeUser('Admin')];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const sent = await sendMessage(a.actor, conversation.id, { body: 'rude words' }, pdf('x.pdf'));
    return { a, b, moderator, conversation, sent };
  }

  it('lets a member report another member\'s message once, not their own', async () => {
    const { a, b, sent } = await reported();
    await expect(reportMessage(a.actor, sent.id, {})).rejects.toMatchObject({ statusCode: 400 });
    await reportMessage(b.actor, sent.id, { reason: 'abusive' });
    await expect(reportMessage(b.actor, sent.id, {})).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps an outsider from reporting (and so from learning the message exists)', async () => {
    const { sent } = await reported();
    const outsider = await makeUser();
    await expect(reportMessage(outsider.actor, sent.id, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('shows a moderator the reported message only, with who reported it', async () => {
    const { b, sent } = await reported();
    await reportMessage(b.actor, sent.id, { reason: 'abusive' });
    const { items, total } = await listReports({ status: 'open', page: 1, limit: 20 });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ reason: 'abusive', message: { body: 'rude words' }, conversationType: 'direct' });
    expect(items[0].reporterName).toBe(b.actor.userName);
    expect(await getReportedMessageFile(items[0].id)).toMatchObject({ originalName: 'x.pdf' });
  });

  it('remove: tombstones the message, deletes its file and settles every open report on it', async () => {
    const { a, b, moderator, conversation, sent } = await reported();
    const third = await makeUser();
    await Conversation.updateOne({ _id: conversation.id }, { $push: { members: { user: third.id } } });
    await reportMessage(b.actor, sent.id, {});
    await reportMessage(third.actor, sent.id, {});
    const [{ id: reportId }] = (await listReports({ status: 'open', page: 1, limit: 20 })).items;

    await decideReport(moderator.actor, reportId, { action: 'remove' });

    const { items } = await listMessages(a.id, conversation.id, { limit: 30 });
    expect(items[0]).toMatchObject({ deleted: true, body: '' });
    expect(upload.destroyDocumentFile).toHaveBeenCalledTimes(1);
    expect(await ChatReport.countDocuments({ status: 'open' })).toBe(0);
    expect(await ChatReport.countDocuments({ status: 'removed' })).toBe(2);
    await expect(decideReport(moderator.actor, reportId, { action: 'dismiss' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('dismiss: leaves the message untouched', async () => {
    const { a, b, moderator, conversation, sent } = await reported();
    await reportMessage(b.actor, sent.id, {});
    const [{ id: reportId }] = (await listReports({ status: 'open', page: 1, limit: 20 })).items;
    await decideReport(moderator.actor, reportId, { action: 'dismiss' });

    const { items } = await listMessages(a.id, conversation.id, { limit: 30 });
    expect(items[0]).toMatchObject({ deleted: false, body: 'rude words' });
    expect((await listReports({ status: 'dismissed', page: 1, limit: 20 })).total).toBe(1);
  });
});
